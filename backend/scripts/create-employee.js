require("../src/load-env");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

async function createEmployee() {
  const companyNumber = process.env.COMPANY_NUMBER?.trim().toUpperCase();
  const fullName = process.env.COMPANY_NAME?.trim();
  const password = process.env.INITIAL_PASSWORD;
  if (!companyNumber || !/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(companyNumber) || !fullName) {
    throw new Error("Set a valid COMPANY_NUMBER and COMPANY_NAME");
  }
  if (!password || password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)
    || password.toUpperCase() === companyNumber) {
    throw new Error("INITIAL_PASSWORD must contain at least 8 characters, a letter, a number, and differ from COMPANY_NUMBER");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO employees (
         company_number, employee_number, full_name, password_hash, must_change_password, role
       ) VALUES ($1, $1, $2, $3, TRUE, 'employee')`,
      [companyNumber, fullName, passwordHash],
    );
    console.log("Employee created.");
  } finally {
    await pool.end();
  }
}

createEmployee().catch((error) => {
  console.error("Employee provisioning failed:", error.message);
  process.exitCode = 1;
});
