require("../src/load-env");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const schema = await fs.readFile(path.join(__dirname, "..", "schema.sql"), "utf8");
    await pool.query(schema);
    console.log("Database schema is up to date.");
  } finally {
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error("Database migration failed:", error.message);
  process.exitCode = 1;
});
