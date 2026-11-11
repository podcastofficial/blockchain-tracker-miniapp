import pg from "pg";
const { Pool } = pg;

let pool;
export function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_NOT_CONFIGURED");
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 8000
    });
  }
  return pool;
}
