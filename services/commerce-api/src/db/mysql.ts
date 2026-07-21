import mysql from "mysql2/promise";
import { loadConfig, t } from "../config.js";

let pool: mysql.Pool | null = null;

export type SqlParam = string | number | boolean | Date | null | Buffer;

export function getPool(): mysql.Pool {
  if (pool) return pool;
  const cfg = loadConfig();
  pool = mysql.createPool({
    host: cfg.MYSQL_HOST,
    port: cfg.MYSQL_PORT,
    user: cfg.MYSQL_USER,
    password: cfg.MYSQL_PASSWORD,
    database: cfg.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: cfg.MYSQL_POOL_SIZE,
    maxIdle: Math.min(cfg.MYSQL_POOL_SIZE, 5),
    idleTimeout: 60_000,
    enableKeepAlive: true,
    namedPlaceholders: false,
    timezone: "Z",
  });
  return pool;
}

export async function query<T = mysql.RowDataPacket[]>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T> {
  // Use query (text protocol), not execute — prepared statements reject LIMIT ?
  const [rows] = await getPool().query(sql, params);
  return rows as T;
}

export async function queryOne<T = mysql.RowDataPacket>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const rows = await query<T[]>(sql, params);
  return rows[0] ?? null;
}

export async function pingMysql(): Promise<boolean> {
  try {
    await query("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  }
}

export async function closeMysql(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export { t };
