require("./load-env");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const PDFDocument = require("pdfkit");
const { Pool } = require("pg");
const { randomBytes, randomUUID } = require("node:crypto");
const payrollCalculator = import("./lib/payroll/zim-paye.ts");
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(randomBytes(32).toString("base64url"), 10);

const requiredSecrets = ["JWT_SECRET"];
for (const key of requiredSecrets) {
  if (!process.env[key]) throw new Error(`${key} must be set before starting the API`);
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters");
}

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});
const sessionCookie = "ess_session";

function isValidPayrollSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const rates = [
    "aidsLevyRate", "nssaEmployeeRate", "nssaEmployerRate", "sdfRate", "necRate",
  ];
  if (rates.some((key) => !Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1)) {
    return false;
  }
  if (!Number.isFinite(settings.nssaCap) || settings.nssaCap < 0
    || typeof settings.nssaDeductibleBeforePaye !== "boolean"
    || !Array.isArray(settings.taxBands) || settings.taxBands.length === 0) return false;
  if (settings.taxBands.length !== 6) return false;
  for (const field of ["companyName", "companyAddress", "payeNumber", "nssaSsr"]) {
    if (typeof (settings[field] ?? "") !== "string" || (settings[field] ?? "").length > 300) return false;
  }

  let previousLimit = 0;
  for (const [index, band] of settings.taxBands.entries()) {
    if (!band || !Number.isFinite(band.rate) || band.rate < 0 || band.rate > 1) return false;
    const isFinal = index === settings.taxBands.length - 1;
    if (isFinal) {
      if (band.limit !== null) return false;
    } else {
      if (!Number.isFinite(band.limit) || band.limit <= previousLimit || band.limit > 100000000) return false;
      previousLimit = band.limit;
    }
  }
  return true;
}

function validMonth(value) {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function formatMoney(value) {
  return Number(value).toFixed(2);
}

function createEmailPayslipPdf(slip, companyName) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      info: { Title: `Payslip ${slip.period_start}`, Author: companyName || "Payroll" },
    });
    const chunks = [];
    pdf.on("data", (chunk) => chunks.push(chunk));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    const earnings = slip.earnings_json || {};
    const allowances = Number(earnings.housing || 0) + Number(earnings.transport || 0)
      + Number(earnings.otherAllowances || 0);
    pdf.fontSize(20).text("Payslip", { align: "center" });
    pdf.moveDown();
    pdf.font("Helvetica-Bold").fontSize(12).text(`Company: ${companyName || "Not set"}`);
    pdf.font("Helvetica").fontSize(11);
    pdf.text(`Employee: ${slip.full_name}`);
    pdf.text(`Employee number: ${slip.employee_number}`);
    pdf.text(`Month: ${String(slip.period_start).slice(0, 7)}`);
    pdf.moveDown();
    pdf.text(`Basic salary: $${formatMoney(earnings.basic || 0)}`);
    pdf.text(`Allowances: $${formatMoney(allowances)}`);
    pdf.text(`Deductions: $${formatMoney(Number(slip.gross_pay) - Number(slip.net_pay))}`);
    pdf.font("Helvetica-Bold").text(`Net pay: $${formatMoney(slip.net_pay)}`);
    pdf.font("Helvetica").text(`Leave taken: ${formatMoney(earnings.leaveDaysTaken || 0)} days`);
    pdf.text(`Leave balance after: ${formatMoney(earnings.leaveBalanceAfter || 0)} days`);
    pdf.font("Helvetica").moveDown().text("Private. Do not share this payslip.", { align: "center" });
    pdf.end();
  });
}

async function sendRunPayslips(runId) {
  const result = await pool.query(
    `SELECT e.active, e.email,
            COALESCE(p.employee_snapshot->>'full_name', e.full_name) AS full_name,
            COALESCE(p.employee_snapshot->>'company_number',
                     p.employee_snapshot->>'employee_number', e.company_number) AS employee_number,
            p.period_start, p.gross_pay, p.net_pay, p.earnings_json, p.settings_snapshot
     FROM payroll_lines l
     JOIN employees e ON e.id = l.employee_id
     JOIN payslips p ON p.employee_id = l.employee_id
       AND p.period_start = (SELECT period_start FROM payroll_runs WHERE id = $1)
     WHERE l.run_id = $1
     ORDER BY e.company_number`,
    [runId],
  );
  const emailReport = { sent: [], skippedNoEmail: [], skippedInactive: [], failed: [] };
  const eligible = [];
  for (const slip of result.rows) {
    const person = { name: slip.full_name, email: slip.email || "" };
    if (!slip.active) emailReport.skippedInactive.push(person);
    else if (!slip.email?.trim()) emailReport.skippedNoEmail.push(person);
    else eligible.push(slip);
  }

  const sendOne = async (slip) => {
    const person = { name: slip.full_name, email: slip.email };
    try {
      if (!process.env.EMAIL_API_KEY || !process.env.EMAIL_FROM) {
        throw new Error("Email service is not configured (EMAIL_API_KEY and EMAIL_FROM are required).");
      }
      const pdf = await createEmailPayslipPdf(slip, slip.settings_snapshot?.companyName || "");
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM,
          to: [slip.email],
          subject: `Payslip for ${String(slip.period_start).slice(0, 7)}`,
          text: "Your payslip is attached. Please do not share it.",
          attachments: [{
            filename: `payslip-${String(slip.period_start).slice(0, 7)}.pdf`,
            content: pdf.toString("base64"),
            content_type: "application/pdf",
          }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const details = await response.json().catch(() => null);
        throw new Error(details?.message || `Email provider returned ${response.status}.`);
      }
      emailReport.sent.push(person);
    } catch (error) {
      console.error(`Unable to email payslip to ${slip.email}:`, error);
      emailReport.failed.push({ ...person, reason: error.message || "Email could not be sent." });
    }
  };

  const workers = Array.from({ length: Math.min(5, eligible.length) }, async () => {
    while (eligible.length) await sendOne(eligible.shift());
  });
  await Promise.all(workers);
  return emailReport;
}

function lineEarnings(value, exempt) {
  const keys = ["basic", "housing", "transport", "otherAllowances", "overtime", "bonus", "loan", "otherDeduction", "leaveDaysTaken"];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Earnings must be provided as an object");
  }
  const earnings = {};
  for (const key of keys) {
    const amount = Number(value[key] ?? 0);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) {
      throw new Error(`${key} must be a non-negative amount`);
    }
    earnings[key] = Number(amount.toFixed(2));
  }
  if (typeof value.nssaExempt !== "undefined" && typeof value.nssaExempt !== "boolean") {
    throw new Error("NSSA exemption must be a boolean");
  }
  earnings.nssaExempt = typeof value.nssaExempt === "boolean" ? value.nssaExempt : exempt === true;
  return earnings;
}

async function loadPayrollSettings(client = pool) {
  const { DEFAULT_SETTINGS } = await payrollCalculator;
  await client.query(
    `INSERT INTO payroll_settings (id, settings) VALUES (TRUE, $1)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(DEFAULT_SETTINGS)],
  );
  const result = await client.query("SELECT settings FROM payroll_settings WHERE id = TRUE");
  return result.rows[0].settings;
}

async function getPayrollRun(periodStart, periodEnd) {
  const result = await pool.query(
    `SELECT r.id, r.period_start, r.period_end, r.status, r.settings_snapshot,
            r.totals_snapshot, r.locked_at, r.locked_by,
            l.id AS line_id, l.earnings_json, l.calculation_json, l.employee_snapshot,
            e.id AS employee_id, e.full_name, e.employee_number, e.department,
            e.company_number, e.job_title, e.national_id,
            e.bank_name, e.bank_account, e.nssa_exempt,
            e.basic_salary, e.housing_allowance, e.transport_allowance, e.other_allowances, e.leave_balance
     FROM payroll_runs r
     LEFT JOIN payroll_lines l ON l.run_id = r.id
     LEFT JOIN employees e ON e.id = l.employee_id
     WHERE r.period_start = $1 AND r.period_end = $2
     ORDER BY e.full_name`,
    [periodStart, periodEnd],
  );
  if (!result.rowCount) return null;

  const run = {
    id: result.rows[0].id,
    period_start: result.rows[0].period_start,
    period_end: result.rows[0].period_end,
    status: result.rows[0].status,
    settings_snapshot: result.rows[0].settings_snapshot,
    totals: result.rows[0].totals_snapshot,
    locked_at: result.rows[0].locked_at,
    locked_by: result.rows[0].locked_by,
    lines: [],
  };
  const settings = run.settings_snapshot || await loadPayrollSettings();
  const { calcLine } = await payrollCalculator;
  for (const row of result.rows) {
    if (!row.line_id) continue;
    const savedEarnings = row.earnings_json;
    const employee = row.employee_snapshot || {};
    const earnings = run.status === "draft" ? {
      ...savedEarnings,
      basic: Number(row.basic_salary),
      housing: Number(row.housing_allowance),
      transport: Number(row.transport_allowance),
      otherAllowances: Number(row.other_allowances),
      nssaExempt: row.nssa_exempt,
      leaveDaysTaken: Number(savedEarnings.leaveDaysTaken || 0),
      leaveBalance: Number(row.leave_balance),
    } : savedEarnings;
    const calculation = run.status === "draft"
      ? calcLine(earnings, settings)
      : row.calculation_json || calcLine(earnings, settings);
    run.lines.push({
      id: row.line_id,
      employee_id: row.employee_id,
      full_name: employee.full_name ?? row.full_name,
      company_number: employee.company_number ?? row.company_number,
      employee_number: employee.company_number ?? row.company_number,
      department: employee.department ?? row.department,
      job_title: employee.job_title ?? row.job_title,
      bank_name: employee.bank_name ?? row.bank_name,
      bank_account: employee.bank_account ?? row.bank_account,
      nssa_exempt: row.nssa_exempt,
      leave_balance: run.status === "draft"
        ? Number(row.leave_balance)
        : Number(savedEarnings.leaveBalanceAfter ?? savedEarnings.leaveBalance ?? row.leave_balance),
      leave_days_taken: Number(earnings.leaveDaysTaken || 0),
      earnings,
      calculation,
    });
  }
  if (run.status === "draft") {
    run.totals = run.lines.reduce((totals, line) => {
      totals.wageBill += line.calculation.gross;
      totals.payeAids += line.calculation.paye + line.calculation.aidsLevy;
      totals.nssaEmployee += line.calculation.nssaEmployee;
      totals.nssaEmployer += line.calculation.nssaEmployer;
      totals.netToBank += line.calculation.net;
      totals.sdf += line.calculation.sdf;
      totals.nec += line.calculation.nec;
      return totals;
    }, { wageBill: 0, payeAids: 0, nssaEmployee: 0, nssaEmployer: 0, netToBank: 0, sdf: 0, nec: 0 });
    for (const key of Object.keys(run.totals)) {
      run.totals[key] = Math.round((run.totals[key] + Number.EPSILON) * 100) / 100;
    }
  }
  return run;
}

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:8000",
  credentials: true,
}));
app.use(express.json({ limit: "512kb" }));
app.use(cookieParser());

function audit(event, employeeId, req, details = {}) {
  return pool.query(
    `INSERT INTO audit_logs (event, employee_id, ip_address, details)
     VALUES ($1, $2, $3, $4)`,
    [event, employeeId || null, req.ip || null, JSON.stringify(details)],
  );
}

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api",
    maxAge: 2 * 60 * 60 * 1000,
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

async function requireEmployee(req, res, next) {
  try {
    const token = req.cookies[sessionCookie];
    if (!token) return res.status(401).json({ error: "Authentication required" });
    let claims;
    try {
      claims = jwt.verify(token, process.env.JWT_SECRET, { issuer: "ess-payslip" });
    } catch {
      res.clearCookie(sessionCookie, authCookieOptions());
      return res.status(401).json({ error: "Authentication required" });
    }
    const result = await pool.query(
      `SELECT e.id, e.email, e.company_number, e.employee_number, e.full_name, e.role,
              e.must_change_password, e.active, e.national_id, e.department, e.job_title,
              e.bank_name, e.bank_account, e.basic_salary, e.housing_allowance,
              e.transport_allowance, e.other_allowances, e.nssa_exempt, e.leave_balance, e.bank_change_note
       FROM employees e
       JOIN auth_sessions s ON s.employee_id = e.id
       WHERE e.id = $1 AND e.active = TRUE AND s.token_id = $2 AND s.expires_at > NOW()`,
      [claims.sub, claims.jti],
    );
    if (!result.rowCount) return res.status(401).json({ error: "Authentication required" });
    req.employee = result.rows[0];
    if (req.employee.must_change_password
      && !["/api/auth/me", "/api/auth/change-password", "/api/auth/logout"].includes(req.path)) {
      return res.status(403).json({ error: "Password change required", mustChangePassword: true });
    }
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.employee?.role !== "admin") return res.status(403).json({ error: "Administrator access required" });
  next();
}

function requireEmployeeRole(req, res, next) {
  if (req.employee?.role !== "employee") return res.status(403).json({ error: "Employee access required" });
  next();
}

function passwordError(password, companyNumber) {
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must be at least 8 characters and include a letter and a number.";
  }
  if (password.toUpperCase() === companyNumber.toUpperCase()) {
    return "Choose a password that is not your company number.";
  }
  return null;
}

function normalizedCompanyNumber(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

async function bootstrapAdmin() {
  const companyNumber = "ADMIN-001";
  const existing = await pool.query("SELECT id FROM employees WHERE role = 'admin' LIMIT 1");
  if (existing.rowCount) return;
  const passwordHash = await bcrypt.hash("ChangeMe2026", 12);
  await pool.query(
    `INSERT INTO employees (
       email, company_number, employee_number, full_name, password_hash,
       must_change_password, role, active
     )
     SELECT NULL, $1, $1, 'Payroll Admin', $2, TRUE, 'admin', TRUE
     WHERE NOT EXISTS (SELECT 1 FROM employees WHERE role = 'admin')`,
    [companyNumber, passwordHash],
  );
}

function parseEmployeeInput(value) {
  const companyNumber = normalizedCompanyNumber(value.companyNumber);
  const fullName = typeof value.fullName === "string" ? value.fullName.trim() : "";
  if (!fullName) throw new Error("Enter the full name.");
  if (!companyNumber || !/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(companyNumber)) {
    throw new Error("Enter a valid company number.");
  }
  const amount = (key, label) => {
    const raw = value[key] ?? (key === "basic" ? undefined : 0);
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0 || number > 100000000) {
      throw new Error(key === "basic" ? "Basic salary must be zero or more." : `${label} must be zero or more.`);
    }
    return Number(number.toFixed(2));
  };
  if (typeof value.nssaExempt !== "undefined" && typeof value.nssaExempt !== "boolean") {
    throw new Error("NSSA exemption must be a boolean.");
  }
  if (typeof value.active !== "undefined" && typeof value.active !== "boolean") {
    throw new Error("Active status must be a boolean.");
  }
  const role = value.role === undefined ? "employee" : value.role;
  if (!["admin", "employee"].includes(role)) throw new Error("Role must be admin or employee.");
  for (const field of ["nationalId", "department", "jobTitle", "bankName", "accountNumber"]) {
    if (typeof (value[field] ?? "") !== "string" || (value[field] ?? "").length > 200) {
      throw new Error(`${field} must be text under 200 characters.`);
    }
  }
  if (typeof (value.email ?? "") !== "string" || (value.email ?? "").length > 254) {
    throw new Error("Enter a valid email address.");
  }
  const email = (value.email ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  return {
    companyNumber,
    fullName,
    email,
    nationalId: (value.nationalId || "").trim() || null,
    department: (value.department || "").trim(),
    jobTitle: (value.jobTitle || "").trim(),
    bankName: (value.bankName || "").trim(),
    accountNumber: (value.accountNumber || "").trim(),
    basic: amount("basic", "Basic salary"),
    housing: amount("housing", "Housing"),
    transport: amount("transport", "Transport"),
    otherAllowance: amount("otherAllowance", "Other allowance"),
    nssaExempt: value.nssaExempt === true,
    leaveBalance: amount("leaveBalance", "Leave balance"),
    role,
    active: value.active !== false,
  };
}

function employeeSelectColumns() {
  return `id, email, company_number, full_name, national_id, department, job_title, role,
          basic_salary, housing_allowance, transport_allowance, other_allowances,
          nssa_exempt, leave_balance, bank_name, bank_account, bank_change_note, active`;
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch {
    res.status(503).json({ status: "unavailable", database: "disconnected" });
  }
});

app.post("/api/auth/login", loginLimiter, async (req, res, next) => {
  const companyNumber = normalizedCompanyNumber(req.body?.companyNumber);
  const { password, role: selectedRole } = req.body || {};
  if (!companyNumber || typeof password !== "string" || !password
    || !["admin", "employee"].includes(selectedRole)) {
    return res.status(401).json({ error: "Company number or password is incorrect." });
  }

  try {
    const result = await pool.query(
      `SELECT id, email, company_number, employee_number, full_name, password_hash,
              must_change_password, role, active
       FROM employees WHERE UPPER(company_number) = $1`,
      [companyNumber],
    );
    const employee = result.rows[0];
    const passwordMatches = await bcrypt.compare(password, employee?.password_hash || DUMMY_PASSWORD_HASH);
    if (!employee || !employee.active || !passwordMatches) {
      await audit("AUTH_FAILURE", employee?.id, req);
      return res.status(401).json({ error: "Company number or password is incorrect." });
    }
    if (employee.role !== selectedRole) {
      await audit("AUTH_ROLE_MISMATCH", employee.id, req, { selectedRole });
      return res.status(403).json({
        error: employee.role === "admin"
          ? "This account is an admin. Choose Admin to sign in."
          : "This account is not an admin. Choose Employee to sign in.",
      });
    }

    const tokenId = randomUUID();
    const token = jwt.sign({ jti: tokenId }, process.env.JWT_SECRET, {
      subject: employee.id,
      issuer: "ess-payslip",
      expiresIn: "2h",
    });
    await pool.query(
      "INSERT INTO auth_sessions (token_id, employee_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '2 hours')",
      [tokenId, employee.id],
    );
    await audit("AUTH_SUCCESS", employee.id, req);
    res.cookie(sessionCookie, token, authCookieOptions());
    res.json({
      employee: {
        id: employee.id,
        companyNumber: employee.company_number,
        fullName: employee.full_name,
        role: employee.role,
        mustChangePassword: employee.must_change_password,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const token = req.cookies[sessionCookie];
    if (token) {
      const claims = jwt.verify(token, process.env.JWT_SECRET, { issuer: "ess-payslip", ignoreExpiration: true });
      if (claims.jti) await pool.query("DELETE FROM auth_sessions WHERE token_id = $1", [claims.jti]);
    }
  } catch (error) {
    if (error.name !== "JsonWebTokenError" && error.name !== "TokenExpiredError") return next(error);
  }
  res.clearCookie(sessionCookie, authCookieOptions());
  res.status(204).end();
});

app.get("/api/auth/me", requireEmployee, (req, res) => {
  res.json({
    employee: {
      id: req.employee.id,
      companyNumber: req.employee.company_number,
      fullName: req.employee.full_name,
      role: req.employee.role,
      mustChangePassword: req.employee.must_change_password,
    },
  });
});

app.post("/api/auth/change-password", requireEmployee, async (req, res, next) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (typeof newPassword !== "string" || typeof confirmPassword !== "string" || newPassword !== confirmPassword) {
    return res.status(400).json({ error: "New password and confirmation must match." });
  }
  const error = passwordError(newPassword, req.employee.company_number);
  if (error) return res.status(400).json({ error });

  try {
    const existing = await pool.query("SELECT password_hash FROM employees WHERE id = $1", [req.employee.id]);
    const samePassword = await bcrypt.compare(newPassword, existing.rows[0].password_hash);
    if (samePassword) return res.status(400).json({ error: "Choose a new password different from your current password." });
    if (!req.employee.must_change_password) {
      const currentMatches = typeof currentPassword === "string"
        && await bcrypt.compare(currentPassword, existing.rows[0].password_hash);
      if (!currentMatches) return res.status(400).json({ error: "Current password is incorrect." });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const client = await pool.connect();
    const newTokenId = randomUUID();
    const token = jwt.sign({ jti: newTokenId }, process.env.JWT_SECRET, {
      subject: req.employee.id,
      issuer: "ess-payslip",
      expiresIn: "2h",
    });
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE employees SET password_hash = $1, must_change_password = FALSE WHERE id = $2",
        [passwordHash, req.employee.id],
      );
      await client.query("DELETE FROM auth_sessions WHERE employee_id = $1", [req.employee.id]);
      await client.query(
        "INSERT INTO auth_sessions (token_id, employee_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '2 hours')",
        [newTokenId, req.employee.id],
      );
      await client.query("COMMIT");
    } catch (transactionError) {
      await client.query("ROLLBACK");
      throw transactionError;
    } finally {
      client.release();
    }
    res.cookie(sessionCookie, token, authCookieOptions());
    res.json({ success: true, home: req.employee.role === "admin" ? "/admin" : "/me" });
  } catch (requestError) {
    next(requestError);
  }
});

app.get("/api/admin/people", requireEmployee, requireAdmin, async (req, res, next) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  try {
    const result = await pool.query(
      `SELECT ${employeeSelectColumns()} FROM employees
       WHERE $1 = '' OR company_number ILIKE '%' || $1 || '%' OR full_name ILIKE '%' || $1 || '%'
       ORDER BY company_number`,
      [search],
    );
    res.json({ people: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/people/import", requireEmployee, requireAdmin, async (req, res, next) => {
  const inputRows = req.body?.rows;
  if (!Array.isArray(inputRows) || inputRows.length === 0 || inputRows.length > 1000) {
    return res.status(400).json({ error: "Import between 1 and 1,000 valid rows." });
  }

  const seenNumbers = new Set();
  const rows = [];
  for (const [index, row] of inputRows.entries()) {
    const companyNumber = normalizedCompanyNumber(row?.employeeNumber);
    const fullName = typeof row?.name === "string" ? row.name.trim() : "";
    const department = typeof row?.department === "string" ? row.department.trim() : "";
    if (!companyNumber || !/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(companyNumber)) {
      return res.status(400).json({ error: `Row ${index + 2}: enter a valid employee number.` });
    }
    if (!fullName || fullName.length > 200 || department.length > 200) {
      return res.status(400).json({ error: `Row ${index + 2}: enter a valid name and department.` });
    }
    if (seenNumbers.has(companyNumber)) {
      return res.status(400).json({ error: `Row ${index + 2}: employee number ${companyNumber} appears more than once.` });
    }
    seenNumbers.add(companyNumber);
    const amount = (value, label) => {
      const number = typeof value === "number" ? value
        : typeof value === "string" && value.trim() ? Number(value.trim()) : NaN;
      if (!Number.isFinite(number) || number < 0 || number > 100000000) {
        throw new Error(`Row ${index + 2}: ${label} must be a non-negative number.`);
      }
      return Number(number.toFixed(2));
    };
    try {
      rows.push({
        companyNumber,
        fullName,
        department,
        basic: amount(row.basicSalary, "Basic salary"),
        allowances: amount(row.allowances ?? 0, "Allowances"),
        deductions: amount(row.deductions ?? 0, "Deductions"),
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  const client = await pool.connect();
  const temporaryPasswords = [];
  const affectedEmployeeIds = [];
  let added = 0;
  let updated = 0;
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const existing = await client.query(
        "SELECT id, role FROM employees WHERE UPPER(company_number) = $1 OR UPPER(employee_number) = $1 FOR UPDATE",
        [row.companyNumber],
      );
      if (existing.rowCount > 1) {
        throw new Error(`Employee number ${row.companyNumber} matches more than one account.`);
      }
      if (existing.rowCount && existing.rows[0].role !== "employee") {
        throw new Error(`Employee number ${row.companyNumber} belongs to an admin account.`);
      }
      if (existing.rowCount) {
        const result = await client.query(
          `UPDATE employees SET company_number = $1, employee_number = $1, full_name = $2,
             department = $3, basic_salary = $4, other_allowances = $5, default_deductions = $6
           WHERE id = $7 RETURNING id`,
          [row.companyNumber, row.fullName, row.department, row.basic, row.allowances, row.deductions, existing.rows[0].id],
        );
        affectedEmployeeIds.push(result.rows[0].id);
        updated += 1;
      } else {
        const temporaryPassword = `Temp9-${randomBytes(12).toString("hex")}`;
        const passwordHash = await bcrypt.hash(temporaryPassword, 12);
        const result = await client.query(
          `INSERT INTO employees (
             email, company_number, employee_number, full_name, password_hash,
             must_change_password, role, active, department, basic_salary,
             other_allowances, default_deductions
           ) VALUES (NULL, $1, $1, $2, $3, TRUE, 'employee', TRUE, $4, $5, $6, $7)
           RETURNING id`,
          [row.companyNumber, row.fullName, passwordHash, row.department, row.basic, row.allowances, row.deductions],
        );
        affectedEmployeeIds.push(result.rows[0].id);
        temporaryPasswords.push({ employeeNumber: row.companyNumber, name: row.fullName, password: temporaryPassword });
        added += 1;
      }
    }

    if (affectedEmployeeIds.length) {
      await client.query(
        `UPDATE payroll_lines l
         SET earnings_json = l.earnings_json || jsonb_build_object('otherDeduction', e.default_deductions),
             employee_snapshot = l.employee_snapshot || jsonb_build_object(
               'full_name', e.full_name, 'company_number', e.company_number, 'department', e.department
             )
         FROM payroll_runs r, employees e
         WHERE l.run_id = r.id AND l.employee_id = e.id AND r.status = 'draft'
           AND e.active = TRUE AND e.id = ANY($1::UUID[])`,
        [affectedEmployeeIds],
      );
      await client.query(
        `INSERT INTO payroll_lines (run_id, employee_id, earnings_json, employee_snapshot)
         SELECT r.id, e.id, jsonb_build_object(
           'basic', e.basic_salary, 'housing', e.housing_allowance, 'transport', e.transport_allowance,
           'otherAllowances', e.other_allowances, 'overtime', 0, 'bonus', 0,
           'loan', 0, 'otherDeduction', e.default_deductions, 'nssaExempt', e.nssa_exempt,
           'leaveDaysTaken', 0
         ), jsonb_build_object(
           'full_name', e.full_name, 'employee_number', e.company_number, 'company_number', e.company_number,
           'department', e.department, 'bank_name', e.bank_name, 'bank_account', e.bank_account
         )
         FROM payroll_runs r CROSS JOIN employees e
         WHERE r.status = 'draft' AND e.active = TRUE AND e.id = ANY($1::UUID[])
           AND NOT EXISTS (
             SELECT 1 FROM payroll_lines existing
             WHERE existing.run_id = r.id AND existing.employee_id = e.id
           )`,
        [affectedEmployeeIds],
      );
    }
    await client.query("COMMIT");
    res.json({ added, updated, temporaryPasswords });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ error: "An employee number is already in use." });
    if (error instanceof Error && error.message.startsWith("Employee number ")) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  } finally {
    client.release();
  }
});

app.post("/api/admin/people", requireEmployee, requireAdmin, async (req, res, next) => {
  let person;
  try {
    person = parseEmployeeInput(req.body || {});
    const password = req.body?.temporaryPassword;
    const error = typeof password === "string" ? passwordError(password, person.companyNumber) : "Enter a temporary password.";
    if (error) return res.status(400).json({ error });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO employees (
         email, company_number, employee_number, full_name, password_hash, must_change_password,
         role, active, national_id, department, job_title, bank_name, bank_account,
         basic_salary, housing_allowance, transport_allowance, other_allowances, nssa_exempt, leave_balance
       ) VALUES (NULLIF($1, ''), $2, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING ${employeeSelectColumns()}`,
      [
        person.email, person.companyNumber, person.fullName, passwordHash, person.role, person.active,
        person.nationalId, person.department, person.jobTitle, person.bankName, person.accountNumber,
        person.basic, person.housing, person.transport, person.otherAllowance, person.nssaExempt, person.leaveBalance,
      ],
    );
    res.status(201).json({ person: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: error.constraint === "employees_email_lower_idx" ? "That email address is already used." : "That company number is already used.",
      });
    }
    if (error instanceof Error && /full name|company number|email|salary|zero or more|NSSA exemption|Active status|Role must|must be text/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.patch("/api/admin/people/:id", requireEmployee, requireAdmin, async (req, res, next) => {
  let person;
  let client;
  try {
    person = parseEmployeeInput(req.body || {});
    if (req.params.id === req.employee.id && !person.active) {
      return res.status(400).json({ error: "You cannot deactivate the account you are using." });
    }
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE employees SET company_number = $1, employee_number = $1, full_name = $2,
         email = NULLIF($3, ''), national_id = $4, department = $5, job_title = $6,
         role = $7, active = $8, bank_name = $9, bank_account = $10,
         basic_salary = $11, housing_allowance = $12, transport_allowance = $13,
         other_allowances = $14, nssa_exempt = $15, leave_balance = $16
       WHERE id = $17
       RETURNING ${employeeSelectColumns()}`,
      [
        person.companyNumber, person.fullName, person.email, person.nationalId, person.department, person.jobTitle,
        person.role, person.active, person.bankName, person.accountNumber, person.basic,
        person.housing, person.transport, person.otherAllowance, person.nssaExempt, person.leaveBalance, req.params.id,
      ],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Person not found." });
    }
    if (!person.active) {
      await client.query(
        `DELETE FROM payroll_lines l USING payroll_runs r
         WHERE l.run_id = r.id AND r.status = 'draft' AND l.employee_id = $1`,
        [req.params.id],
      );
    }
    await client.query("COMMIT");
    res.json({ person: result.rows[0] });
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(409).json({
        error: error.constraint === "employees_email_lower_idx" ? "That email address is already used." : "That company number is already used.",
      });
    }
    if (error instanceof Error && /full name|company number|email|salary|zero or more|NSSA exemption|Active status|Role must|must be text/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  } finally {
    client?.release();
  }
});

app.post("/api/admin/people/:id/reset-password", requireEmployee, requireAdmin, async (req, res, next) => {
  try {
    const personResult = await pool.query(
      "SELECT id, company_number, active FROM employees WHERE id = $1",
      [req.params.id],
    );
    const person = personResult.rows[0];
    if (!person) return res.status(404).json({ error: "Person not found." });
    let temporaryPassword;
    do {
      temporaryPassword = randomBytes(9).toString("base64url");
    } while (passwordError(temporaryPassword, person.company_number));
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    await pool.query(
      `UPDATE employees SET password_hash = $1, must_change_password = TRUE WHERE id = $2`,
      [passwordHash, person.id],
    );
    await pool.query("DELETE FROM auth_sessions WHERE employee_id = $1", [person.id]);
    res.json({ temporaryPassword, message: "Copy this now. It will not be shown again." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/people/:id/bank-change/:action", requireEmployee, requireAdmin, async (req, res, next) => {
  if (!["accept", "dismiss"].includes(req.params.action)) return res.status(404).json({ error: "Not found." });
  try {
    const result = await pool.query(
      req.params.action === "accept"
        ? `UPDATE employees SET bank_name = COALESCE((bank_change_note::JSONB)->>'bankName', ''),
             bank_account = COALESCE((bank_change_note::JSONB)->>'accountNumber', ''), bank_change_note = NULL
           WHERE id = $1 AND bank_change_note IS NOT NULL
           RETURNING ${employeeSelectColumns()}`
        : `UPDATE employees SET bank_change_note = NULL WHERE id = $1 AND bank_change_note IS NOT NULL
           RETURNING ${employeeSelectColumns()}`,
      [req.params.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: "No bank change request found." });
    res.json({ person: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/me", requireEmployee, requireEmployeeRole, (req, res) => {
  res.json({ employee: req.employee });
});

app.get("/api/me/payslips", requireEmployee, requireEmployeeRole, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT period_start, period_end, currency, gross_pay, deductions, net_pay,
              earnings_json, statutory_json, settings_snapshot, employee_snapshot
       FROM payslips p
       JOIN employees e ON e.id = p.employee_id
       WHERE p.employee_id = $1
         AND UPPER(REGEXP_REPLACE(BTRIM(COALESCE(
           NULLIF(p.employee_snapshot->>'company_number', ''),
           NULLIF(p.employee_snapshot->>'employee_number', ''),
           e.company_number
         )), '[[:space:]]+', '', 'g')) =
           UPPER(REGEXP_REPLACE(BTRIM($2), '[[:space:]]+', '', 'g'))
         AND EXISTS (
           SELECT 1 FROM payroll_runs r
           WHERE r.period_start = p.period_start AND r.period_end = p.period_end
             AND r.status = 'locked'
         )
       ORDER BY p.period_end DESC`,
      [req.employee.id, req.employee.company_number],
    );
    res.json({ payslips: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/api/me/payslips/:month", requireEmployee, requireEmployeeRole, async (req, res, next) => {
  if (!validMonth(req.params.month)) return res.status(400).json({ error: "Month must use YYYY-MM." });
  const [year, month] = req.params.month.split("-");
  const start = `${year}-${month}-01`;
  const end = new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
  try {
    const result = await pool.query(
      `SELECT p.period_start, p.period_end, p.currency, p.gross_pay, p.deductions, p.net_pay,
              p.earnings_json, p.statutory_json, p.settings_snapshot, p.employee_snapshot,
              p.employee_id
       FROM payslips p
       JOIN employees e ON e.id = p.employee_id
       WHERE p.employee_id = $1 AND p.period_start = $2 AND p.period_end = $3
         AND UPPER(REGEXP_REPLACE(BTRIM(COALESCE(
           NULLIF(p.employee_snapshot->>'company_number', ''),
           NULLIF(p.employee_snapshot->>'employee_number', ''),
           e.company_number
         )), '[[:space:]]+', '', 'g')) =
           UPPER(REGEXP_REPLACE(BTRIM($4), '[[:space:]]+', '', 'g'))
         AND EXISTS (
           SELECT 1 FROM payroll_runs r
           WHERE r.period_start = p.period_start AND r.period_end = p.period_end
             AND r.status = 'locked'
         )`,
      [req.employee.id, start, end, req.employee.company_number],
    );
    if (!result.rowCount) return res.status(404).json({ error: "That payslip is not available." });
    res.json({ payslip: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/me/details/bank", requireEmployee, requireEmployeeRole, async (req, res, next) => {
  const { bankName, accountNumber } = req.body || {};
  if ([bankName, accountNumber].some((value) => typeof value !== "string" || value.length > 200)) {
    return res.status(400).json({ error: "Bank and account details must be text under 200 characters." });
  }
  try {
    const result = await pool.query(
      `UPDATE employees SET bank_change_note = $1 WHERE id = $2
       RETURNING bank_change_note`,
      [JSON.stringify({ bankName: bankName.trim(), accountNumber: accountNumber.trim() }), req.employee.id],
    );
    res.json({ bankChangeNote: result.rows[0].bank_change_note });
  } catch (error) {
    next(error);
  }
});

app.get("/api/payroll/settings", requireEmployee, requireAdmin, async (_req, res, next) => {
  try {
    res.json({ settings: await loadPayrollSettings() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/payroll/settings", requireEmployee, requireAdmin, async (req, res, next) => {
  try {
    const settings = req.body?.settings;
    if (!isValidPayrollSettings(settings)) {
      return res.status(400).json({ error: "Payroll rates or tax bands are invalid" });
    }
    await pool.query(
      `INSERT INTO payroll_settings (id, settings, updated_at)
       VALUES (TRUE, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
      [JSON.stringify(settings)],
    );
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

app.get("/api/payroll/employees", requireEmployee, requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, employee_number, department, bank_name, bank_account,
              basic_salary, housing_allowance, transport_allowance, other_allowances, nssa_exempt
       FROM employees WHERE active = TRUE ORDER BY full_name`,
    );
    res.json({ employees: result.rows });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/payroll/employees/:employeeId", requireEmployee, requireAdmin, async (req, res, next) => {
  const { department, bankName, bankAccount } = req.body || {};
  if ([department, bankName, bankAccount].some((value) => typeof value !== "string" || value.length > 200)) {
    return res.status(400).json({ error: "Department and bank details must be text under 200 characters" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE employees SET department = $1, bank_name = $2, bank_account = $3
       WHERE id = $4 AND active = TRUE
       RETURNING id, department, bank_name, bank_account`,
      [department.trim(), bankName.trim(), bankAccount.trim(), req.params.employeeId],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Active employee not found" });
    }
    await client.query(
      `UPDATE payroll_lines l SET employee_snapshot = employee_snapshot || $1::JSONB
       FROM payroll_runs r
       WHERE l.run_id = r.id AND r.status = 'draft' AND l.employee_id = $2`,
      [
        JSON.stringify({
          department: result.rows[0].department,
          bank_name: result.rows[0].bank_name,
          bank_account: result.rows[0].bank_account,
        }),
        req.params.employeeId,
      ],
    );
    await client.query("COMMIT");
    res.json({ employee: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof Error && /must be a non-negative|NSSA exemption must/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  } finally {
    client.release();
  }
});

app.get("/api/payroll/runs", requireEmployee, requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.period_start, r.period_end, r.status, r.totals_snapshot,
              COUNT(l.id)::INTEGER AS employee_count
       FROM payroll_runs r LEFT JOIN payroll_lines l ON l.run_id = r.id
       GROUP BY r.id ORDER BY r.period_start DESC LIMIT 24`,
    );
    res.json({ runs: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/api/payroll/runs/:month", requireEmployee, requireAdmin, async (req, res, next) => {
  if (!validMonth(req.params.month)) return res.status(400).json({ error: "Month must use YYYY-MM" });
  try {
    const [year, month] = req.params.month.split("-");
    const start = `${year}-${month}-01`;
    const end = new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
    const run = await getPayrollRun(start, end);
    if (!run) return res.status(404).json({ error: "No payroll run exists for this month" });
    res.json({ run });
  } catch (error) {
    next(error);
  }
});

app.post("/api/payroll/runs", requireEmployee, requireAdmin, async (req, res, next) => {
  const month = req.body?.month;
  if (!validMonth(month)) return res.status(400).json({ error: "Month must use YYYY-MM" });
  const [year, monthNumber] = month.split("-");
  const periodStart = `${year}-${monthNumber}-01`;
  const periodEnd = new Date(Date.UTC(Number(year), Number(monthNumber), 0)).toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT id FROM payroll_runs WHERE period_start = $1 AND period_end = $2",
      [periodStart, periodEnd],
    );
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "A payroll run already exists for this month" });
    }
    const activeCount = await client.query("SELECT COUNT(*)::INTEGER AS count FROM employees WHERE active = TRUE");
    if (activeCount.rows[0].count === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Add employees on People before running payroll." });
    }
    const runResult = await client.query(
      "INSERT INTO payroll_runs (period_start, period_end) VALUES ($1, $2) RETURNING id",
      [periodStart, periodEnd],
    );
    await client.query(
      `INSERT INTO payroll_lines (run_id, employee_id, earnings_json, employee_snapshot)
       SELECT $1, id, jsonb_build_object(
         'basic', basic_salary, 'housing', housing_allowance, 'transport', transport_allowance,
         'otherAllowances', other_allowances, 'overtime', 0, 'bonus', 0,
         'loan', 0, 'otherDeduction', default_deductions, 'nssaExempt', nssa_exempt,
         'leaveDaysTaken', 0
       ), jsonb_build_object(
         'full_name', full_name, 'employee_number', employee_number, 'department', department,
         'bank_name', bank_name, 'bank_account', bank_account
       )
       FROM employees WHERE active = TRUE`,
      [runResult.rows[0].id],
    );
    await client.query("COMMIT");
    const run = await getPayrollRun(periodStart, periodEnd);
    res.status(201).json({ run });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(409).json({ error: "A payroll run already exists for this month" });
    }
    next(error);
  } finally {
    client.release();
  }
});

app.patch("/api/payroll/runs/:runId/lines/:lineId", requireEmployee, requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT r.status, r.settings_snapshot, l.earnings_json, e.nssa_exempt, e.leave_balance,
              e.basic_salary, e.housing_allowance, e.transport_allowance, e.other_allowances
       FROM payroll_runs r
       JOIN payroll_lines l ON l.run_id = r.id
       JOIN employees e ON e.id = l.employee_id
       WHERE r.id = $1 AND l.id = $2 FOR UPDATE OF r, l`,
      [req.params.runId, req.params.lineId],
    );
    const line = result.rows[0];
    if (!line) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Payroll line not found" });
    }
    if (line.status !== "draft") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Locked payroll runs cannot be edited" });
    }
    const { calcLine } = await payrollCalculator;
    const monthInput = req.body?.earnings || {};
    const earnings = lineEarnings({
      ...line.earnings_json,
      basic: line.basic_salary,
      housing: line.housing_allowance,
      transport: line.transport_allowance,
      otherAllowances: line.other_allowances,
      overtime: monthInput.overtime ?? line.earnings_json.overtime,
      bonus: monthInput.bonus ?? line.earnings_json.bonus,
      loan: monthInput.loan ?? line.earnings_json.loan,
      otherDeduction: monthInput.otherDeduction ?? line.earnings_json.otherDeduction,
      leaveDaysTaken: monthInput.leaveDaysTaken ?? line.earnings_json.leaveDaysTaken,
    }, line.nssa_exempt);
    if (earnings.leaveDaysTaken > Number(line.leave_balance)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Leave days taken cannot exceed the available balance of ${Number(line.leave_balance).toFixed(2)} days.` });
    }
    const settings = line.settings_snapshot || await loadPayrollSettings(client);
    const calculation = calcLine(earnings, settings);
    await client.query(
      `UPDATE payroll_lines SET earnings_json = $1, calculation_json = $2 WHERE id = $3`,
      [JSON.stringify(earnings), JSON.stringify(calculation), req.params.lineId],
    );
    await client.query("COMMIT");
    res.json({ earnings, calculation });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof Error && /must be a non-negative/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  } finally {
    client.release();
  }
});

app.post("/api/payroll/runs/:runId/lock", requireEmployee, requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const runResult = await client.query(
      "SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE",
      [req.params.runId],
    );
    const run = runResult.rows[0];
    if (!run) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Payroll run not found" });
    }
    if (run.status !== "draft") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Payroll run is already locked" });
    }
    const settings = await loadPayrollSettings(client);
    const { calcLine } = await payrollCalculator;
    const linesResult = await client.query(
      `SELECT l.id, l.employee_id, l.earnings_json, l.employee_snapshot,
              e.full_name, e.company_number, e.department, e.job_title, e.national_id,
              e.bank_name, e.bank_account, e.nssa_exempt,
              e.basic_salary, e.housing_allowance, e.transport_allowance, e.other_allowances, e.leave_balance,
              EXISTS (
                SELECT 1 FROM payslips p
                WHERE p.employee_id = l.employee_id
                  AND p.period_start = $2 AND p.period_end = $3
              ) AS payslip_exists
       FROM payroll_lines l JOIN employees e ON e.id = l.employee_id
       WHERE l.run_id = $1 ORDER BY e.full_name FOR UPDATE OF l, e`,
      [run.id, run.period_start, run.period_end],
    );
    if (!linesResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Add active employees before locking the payroll run" });
    }

    const totals = { wageBill: 0, payeAids: 0, nssaEmployee: 0, nssaEmployer: 0, netToBank: 0, sdf: 0, nec: 0 };
    for (const line of linesResult.rows) {
      if (line.payslip_exists) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "An employee already has a payslip for this month; the run was not locked" });
      }
      const earnings = lineEarnings({
        ...line.earnings_json,
        basic: line.basic_salary,
        housing: line.housing_allowance,
        transport: line.transport_allowance,
        otherAllowances: line.other_allowances,
      }, line.nssa_exempt);
      if (earnings.leaveDaysTaken > Number(line.leave_balance)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Leave days taken for ${line.full_name} cannot exceed their available balance of ${Number(line.leave_balance).toFixed(2)} days.`,
        });
      }
      earnings.leaveBalanceBefore = Number(line.leave_balance);
      earnings.leaveBalanceAfter = Number((Number(line.leave_balance) - earnings.leaveDaysTaken).toFixed(2));
      const calculation = calcLine(earnings, settings);
      for (const key of Object.keys(totals)) {
        const field = {
          wageBill: "gross", payeAids: null, nssaEmployee: "nssaEmployee",
          nssaEmployer: "nssaEmployer", netToBank: "net", sdf: "sdf", nec: "nec",
        }[key];
        totals[key] += key === "payeAids" ? calculation.paye + calculation.aidsLevy : calculation[field];
      }
      const employeeSnapshot = {
        company_name: settings.companyName || "",
        full_name: line.full_name,
        company_number: line.company_number,
        employee_number: line.company_number,
        department: line.department,
        job_title: line.job_title,
        national_id: line.national_id,
        bank_name: line.bank_name,
        bank_account: line.bank_account,
      };
      await client.query(
        `UPDATE payroll_lines SET earnings_json = $1, calculation_json = $2, employee_snapshot = $3
         WHERE id = $4`,
        [JSON.stringify(earnings), JSON.stringify(calculation), JSON.stringify(employeeSnapshot), line.id],
      );
      await client.query(
        "UPDATE employees SET leave_balance = $1 WHERE id = $2",
        [earnings.leaveBalanceAfter, line.employee_id],
      );
      await client.query(
        `INSERT INTO payslips (
           employee_id, period_start, period_end, currency, gross_pay, deductions, net_pay,
           usd_per_unit, zwg_per_unit, earnings_json, statutory_json, settings_snapshot, employee_snapshot
         ) VALUES ($1, $2, $3, 'USD', $4, $5, $6, 1, 1, $7, $8, $9, $10)`,
        [
          line.employee_id, run.period_start, run.period_end, calculation.gross,
          calculation.gross - calculation.net, calculation.net,
          JSON.stringify(earnings), JSON.stringify(calculation), JSON.stringify(settings),
          JSON.stringify(employeeSnapshot),
        ],
      );
    }
    for (const key of Object.keys(totals)) {
      totals[key] = Math.round((totals[key] + Number.EPSILON) * 100) / 100;
    }
    await client.query(
      `UPDATE payroll_runs SET status = 'locked', settings_snapshot = $1,
         totals_snapshot = $2, locked_at = NOW(), locked_by = $3 WHERE id = $4`,
      [JSON.stringify(settings), JSON.stringify(totals), req.employee.company_number, run.id],
    );
    await client.query("COMMIT");
    const periodStart = run.period_start.toISOString?.().slice(0, 10) || run.period_start;
    const periodEnd = run.period_end.toISOString?.().slice(0, 10) || run.period_end;
    let emailReport;
    try {
      emailReport = await sendRunPayslips(run.id);
    } catch (error) {
      console.error("Payroll was locked, but payslip email processing failed:", error);
      emailReport = {
        sent: [],
        skippedNoEmail: [],
        skippedInactive: [],
        failed: [{ name: "Email processing", email: "", reason: error.message || "Payslip email processing failed." }],
      };
    }
    res.json({
      run: await getPayrollRun(periodStart, periodEnd),
      emailReport: { month: periodStart.slice(0, 7), ...emailReport },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(409).json({ error: "A payslip already exists for an employee in this month" });
    }
    next(error);
  } finally {
    client.release();
  }
});

app.post("/api/payroll/runs/:runId/unlock", requireEmployee, requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE",
      [req.params.runId],
    );
    const run = result.rows[0];
    if (!run) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Payroll run not found." });
    }
    if (run.status !== "locked") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Payroll run is not locked." });
    }
    await client.query(
      `UPDATE employees e
       SET leave_balance = COALESCE(
         (l.earnings_json->>'leaveBalanceBefore')::NUMERIC,
         e.leave_balance + COALESCE((l.earnings_json->>'leaveDaysTaken')::NUMERIC, 0)
       )
       FROM payroll_lines l
       WHERE l.run_id = $1 AND l.employee_id = e.id`,
      [run.id],
    );
    await client.query(
      `DELETE FROM payslips p USING payroll_lines l
       WHERE l.run_id = $1 AND p.employee_id = l.employee_id
         AND p.period_start = $2 AND p.period_end = $3`,
      [run.id, run.period_start, run.period_end],
    );
    await client.query(
      `UPDATE payroll_lines SET calculation_json = NULL, employee_snapshot = '{}'::JSONB
       WHERE run_id = $1`,
      [run.id],
    );
    await client.query(
      `UPDATE payroll_runs SET status = 'draft', settings_snapshot = NULL, totals_snapshot = NULL,
         locked_at = NULL, locked_by = NULL WHERE id = $1`,
      [run.id],
    );
    await client.query("COMMIT");
    const start = run.period_start.toISOString?.().slice(0, 10) || run.period_start;
    const end = run.period_end.toISOString?.().slice(0, 10) || run.period_end;
    res.json({ run: await getPayrollRun(start, end) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.get("/api/admin/month/:month/returns", requireEmployee, requireAdmin, async (req, res, next) => {
  if (!validMonth(req.params.month)) return res.status(400).json({ error: "Month must use YYYY-MM." });
  const [year, month] = req.params.month.split("-");
  const start = `${year}-${month}-01`;
  const end = new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
  try {
    const run = await getPayrollRun(start, end);
    if (!run) return res.status(404).json({ error: "No payroll run exists for this month." });
    const returns = run.lines.reduce((totals, line) => {
      totals.paye += Number(line.calculation.paye);
      totals.aidsLevy += Number(line.calculation.aidsLevy);
      totals.employeeNssa += Number(line.calculation.nssaEmployee);
      totals.employerNssa += Number(line.calculation.nssaEmployer);
      totals.insurableEarnings += Number(line.calculation.nssaBase);
      totals.sdf += Number(line.calculation.sdf);
      totals.nec += Number(line.calculation.nec);
      totals.net += Number(line.calculation.net);
      return totals;
    }, { paye: 0, aidsLevy: 0, employeeNssa: 0, employerNssa: 0, insurableEarnings: 0, sdf: 0, nec: 0, net: 0 });
    for (const key of Object.keys(returns)) returns[key] = Number(returns[key].toFixed(2));
    res.json({
      status: run.status,
      returns,
      bankList: run.lines.map((line) => ({
        companyNumber: line.company_number,
        name: line.full_name,
        bank: line.bank_name,
        account: line.bank_account,
        net: Number(line.calculation.net),
      })).sort((left, right) => left.companyNumber.localeCompare(right.companyNumber)),
      lines: run.lines,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/payslips", requireEmployee, requireEmployeeRole, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, period_start, period_end, currency, gross_pay, deductions, net_pay,
              usd_per_unit, zwg_per_unit, earnings_json, statutory_json, settings_snapshot
       FROM payslips WHERE employee_id = $1 ORDER BY period_end DESC LIMIT 24`,
      [req.employee.id],
    );
    res.json({ payslips: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/api/payslips/:id/pdf", requireEmployee, requireEmployeeRole, async (req, res, next) => {
  const { password } = req.body || {};
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: "Choose a PDF password between 8 and 128 characters" });
  }

  try {
    const result = await pool.query(
      `SELECT p.*, COALESCE(p.employee_snapshot->>'full_name', e.full_name) AS full_name,
              COALESCE(p.employee_snapshot->>'company_number',
                       p.employee_snapshot->>'employee_number', e.company_number) AS employee_number
       FROM payslips p JOIN employees e ON e.id = p.employee_id
       WHERE p.id = $1 AND p.employee_id = $2`,
      [req.params.id, req.employee.id],
    );
    const slip = result.rows[0];
    if (!slip) return res.status(404).json({ error: "Payslip not found" });

    await audit("PAYSLIP_DOWNLOAD", req.employee.id, req, { payslipId: slip.id });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="payslip-${slip.period_end}.pdf"`);

    const pdf = new PDFDocument({
      userPassword: password,
      ownerPassword: require("node:crypto").randomBytes(32).toString("base64url"),
      permissions: { printing: "highResolution", copying: false, modifying: false, annotating: false },
      info: { Title: `Payslip ${slip.period_start} to ${slip.period_end}`, Author: "ESS Payslip Portal" },
    });
    pdf.pipe(res);
    pdf.fontSize(20).text("Employee payslip", { align: "center" });
    pdf.moveDown();
    pdf.fontSize(11).text(`Employee: ${slip.full_name}`);
    pdf.text(`Company number: ${slip.employee_number}`);
    pdf.text(`Pay period: ${slip.period_start} to ${slip.period_end}`);
    pdf.text(`Currency: ${slip.currency.trim()}`);
    if (slip.employee_snapshot?.company_name) pdf.text(`Company: ${slip.employee_snapshot.company_name}`);
    if (slip.employee_snapshot?.department) pdf.text(`Department: ${slip.employee_snapshot.department}`);
    if (slip.employee_snapshot?.bank_name || slip.employee_snapshot?.bank_account) {
      pdf.text(`Bank: ${[slip.employee_snapshot.bank_name, slip.employee_snapshot.bank_account].filter(Boolean).join(" · ")}`);
    }
    pdf.moveDown();
    pdf.text(`Gross pay: ${formatMoney(slip.gross_pay)} ${slip.currency.trim()}`);
    pdf.text(`Deductions: ${formatMoney(slip.deductions)} ${slip.currency.trim()}`);
    if (slip.earnings_json && slip.statutory_json) {
      pdf.moveDown();
      pdf.font("Helvetica-Bold").text("Earnings");
      for (const [label, key] of [
        ["Basic salary", "basic"], ["Housing", "housing"], ["Transport", "transport"],
        ["Other allowances", "otherAllowances"], ["Overtime", "overtime"], ["Bonus", "bonus"],
      ]) pdf.font("Helvetica").text(`${label}: ${formatMoney(slip.earnings_json[key])} USD`);
      pdf.moveDown();
      pdf.font("Helvetica-Bold").text("Statutory and other deductions");
      for (const [label, key] of [
        ["Employee NSSA", "nssaEmployee"], ["PAYE", "paye"], ["AIDS levy", "aidsLevy"],
        ["Loan", "loan"], ["Other deduction", "otherDeduction"],
      ]) {
        if (key === "paye") {
          pdf.font("Helvetica").text(`Taxable income: ${formatMoney(slip.statutory_json.taxableIncome)} USD`);
        }
        pdf.font("Helvetica").text(`${label}: ${formatMoney(slip.statutory_json[key])} USD`);
      }
      pdf.text(`Employer NSSA: ${formatMoney(slip.statutory_json.nssaEmployer)} USD`);
      pdf.text(`SDF: ${formatMoney(slip.statutory_json.sdf)} USD`);
      pdf.text(`NEC: ${formatMoney(slip.statutory_json.nec)} USD`);
      const costToCompany = slip.statutory_json.gross + slip.statutory_json.nssaEmployer
        + slip.statutory_json.sdf + slip.statutory_json.nec;
      pdf.text(`Cost to company: ${formatMoney(costToCompany)} USD`);
    }
    pdf.font("Helvetica-Bold").text(`Net pay: ${formatMoney(slip.net_pay)} ${slip.currency.trim()}`);
    pdf.font("Helvetica").moveDown().text("Private", { align: "center" });
    pdf.end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("API request failed:", error.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "The request could not be completed" });
});

const port = Number(process.env.PORT || 5000);
let server;

bootstrapAdmin().then(() => {
  server = app.listen(port, "0.0.0.0", () => {
    console.log(`Backend listening on port ${port}`);
  });
}).catch((error) => {
  console.error("Backend startup failed:", error.message);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!server) {
      pool.end().finally(() => process.exit(0));
      return;
    }
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
