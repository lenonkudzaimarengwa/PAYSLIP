const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const candidates = [
  process.env.DOTENV_CONFIG_PATH,
  path.resolve(__dirname, "..", "..", ".env"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "..", ".env"),
].filter(Boolean);

for (const candidate of candidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

if (!process.env.DOTENV_CONFIG_PATH) {
  dotenv.config();
}
