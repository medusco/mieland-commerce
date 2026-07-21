import { Redis } from "ioredis";
import { loadConfig } from "../config.js";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  const cfg = loadConfig();
  client = new Redis(cfg.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on("error", (err: Error) => {
    console.error(JSON.stringify({ msg: "redis_error", err: String(err) }));
  });
  return client;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const pong = await getRedis().ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

/** Simple Redis SET NX lock with TTL (ms). Returns unlock fn. */
export async function withRedisLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const redis = getRedis();
  const token = `${Date.now()}-${Math.random()}`;
  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") {
    await new Promise((r) => setTimeout(r, 50));
    const retry = await redis.set(key, token, "PX", ttlMs, "NX");
    if (retry !== "OK") {
      throw new Error("Cart is busy; retry shortly");
    }
  }
  try {
    return await fn();
  } finally {
    const current = await redis.get(key);
    if (current === token) {
      await redis.del(key);
    }
  }
}
