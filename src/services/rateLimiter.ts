import { redis } from "../redis";
import { config } from "../config";
import { logger } from "../logger";

/**
 * Per-chat per-hour message counter for free-tier enforcement (spec §4).
 *
 * Uses a Redis key scoped to the current hour. On first message of the hour
 * the key is created with TTL = 3600s so it auto-expires at the next hour.
 */
function hourKey(chatId: bigint): string {
  const hour = Math.floor(Date.now() / 3_600_000); // changes every wall-clock hour
  return `rl:${chatId.toString()}:${hour}`;
}

export interface RateLimitResult {
  /** messages counted in the current hour window (after this increment) */
  count: number;
  /** whether the free-tier limit is exceeded */
  exceeded: boolean;
  limit: number;
}

/**
 * Increment the counter for a chat in the current hour window.
 * Returns the new count and whether the free-tier limit is exceeded.
 *
 * Note: incrementing is best-effort; on Redis failure we fail-open
 * (do not block moderation) but log the error.
 */
export async function consumeMessageQuota(chatId: bigint): Promise<RateLimitResult> {
  const limit = config.FREE_TIER_MAX_MSGS_PER_HOUR;
  const key = hourKey(chatId);
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // first message this hour → set expiry
      await redis.expire(key, 3600);
    }
    return { count, exceeded: count > limit, limit };
  } catch (err) {
    logger.error({ err, chatId }, "rateLimiter incr failed (fail-open)");
    return { count: 0, exceeded: false, limit };
  }
}

/** Current count for the hour window (without incrementing). */
export async function currentQuota(chatId: bigint): Promise<number> {
  const key = hourKey(chatId);
  try {
    const v = await redis.get(key);
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

/**
 * Track a unique user for a chat (Redis set, used for free-tier user cap).
 * Returns the new cardinality of the set.
 */
export async function trackUser(chatId: bigint, userId: bigint): Promise<number> {
  const key = `chat:${chatId.toString()}:users`;
  try {
    await redis.sadd(key, userId.toString());
    // No expiry: the set lives as long as the chat is served by the bot.
    return await redis.scard(key);
  } catch (err) {
    logger.error({ err, chatId, userId }, "trackUser failed (fail-open)");
    return 0;
  }
}

export function freeTierUsersExceeded(trackedCount: number): boolean {
  return trackedCount > config.FREE_TIER_MAX_USERS;
}
