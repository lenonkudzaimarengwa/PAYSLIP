require("../src/load-env");
const fs = require("node:fs/promises");
const { parse } = require("csv-parse/sync");
const { Pool } = require("pg");

const requiredColumns = [
  "period_start",
  "period_end",
  "currency",
  "gross_pay",
  "deductions",
  "net_pay",
  "usd_per_unit",
  "zwg_per_unit",
];

function positiveAmount(value, column, rowNumber) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || (column.includes("per_unit") && amount === 0)) {
    throw new Error(`Invalid ${column} on CSV row ${rowNumber}`);
  }
  return amount;
}

async function importPayroll() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("Usage: npm run import -- path/to/payroll_run.csv");

  const contents = await fs.readFile(filePath, "utf8");
  const records = parse(contents, { columns: true, skip_empty_lines: true, trim: true });
  if (!records.length) throw new Error("The CSV contains no payroll rows");
  const missing = requiredColumns.filter((column) => !(column in records[0]));
  if (!("email" in records[0]) && !("company_number" in records[0])) {
    missing.push("email or company_number");
  }
  if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(", ")}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [index, record] of records.entries()) {
      const rowNumber = index + 2;
      const email = record.email?.trim().toLowerCase() || null;
      const companyNumber = record.company_number?.trim().toUpperCase() || null;
      const currency = record.currency.toUpperCase();
      if (!email && !companyNumber) throw new Error(`Email or company_number is required on CSV row ${rowNumber}`);
      if (email && companyNumber) throw new Error(`Use either email or company_number on CSV row ${rowNumber}`);
      if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error(`Invalid email on CSV row ${rowNumber}`);
      if (companyNumber && !/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(companyNumber)) {
        throw new Error(`Invalid company_number on CSV row ${rowNumber}`);
      }
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Invalid currency on CSV row ${rowNumber}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(record.period_end)) {
        throw new Error(`Dates must use YYYY-MM-DD on CSV row ${rowNumber}`);
      }

      const amounts = ["gross_pay", "deductions", "net_pay", "usd_per_unit", "zwg_per_unit"]
        .map((column) => positiveAmount(record[column], column, rowNumber));
      if (Math.abs(amounts[0] - amounts[1] - amounts[2]) > 0.01) {
        throw new Error(`gross_pay - deductions must equal net_pay on CSV row ${rowNumber}`);
      }

      const result = await client.query(
        `INSERT INTO payslips (
           employee_id, period_start, period_end, currency, gross_pay, deductions,
           net_pay, usd_per_unit, zwg_per_unit
         )
         SELECT id, $3, $4, $5, $6, $7, $8, $9, $10
         FROM employees
         WHERE active = TRUE
           AND (($1::TEXT IS NOT NULL AND LOWER(email) = $1)
             OR ($2::TEXT IS NOT NULL AND UPPER(company_number) = $2))
         ON CONFLICT (employee_id, period_start, period_end) DO UPDATE SET
           currency = EXCLUDED.currency,
           gross_pay = EXCLUDED.gross_pay,
           deductions = EXCLUDED.deductions,
           net_pay = EXCLUDED.net_pay,
           usd_per_unit = EXCLUDED.usd_per_unit,
           zwg_per_unit = EXCLUDED.zwg_per_unit`,
        [email, companyNumber, record.period_start, record.period_end, currency, ...amounts],
      );
      if (result.rowCount !== 1) {
        throw new Error(`No active employee found for ${companyNumber || email} on CSV row ${rowNumber}`);
      }
    }
    await client.query("COMMIT");
    console.log(`Imported ${records.length} payslip row(s).`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

importPayroll().catch((error) => {
  console.error("Payroll import failed:", error.message);
  process.exitCode = 1;
});
