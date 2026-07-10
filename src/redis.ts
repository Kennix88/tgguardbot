import Redis from "ioredis";
import { config } from "./config";
import { logger } from "./logger";

/**
 * Shared Redis client used for:
 *  - admin-rights cache (TTL 5 min)
 *  - captcha state / timeouts
 *  - per-chat per-hour rate limit counters
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  enableReadyCheck: true,
});

redis.on("error", (err) => {
  logger.error({ err }, "redis error");
});

redis.on("connect", () => {
  logger.info("redis connected");
});

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
