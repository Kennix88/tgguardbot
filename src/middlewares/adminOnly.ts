import type { Context, NextFunction } from "grammy";
import { redis } from "../redis";
import { logger } from "../logger";

declare module "grammy" {
  interface Context {
    /** true if the sender is a chat administrator (cached 5 min in Redis). */
    isAdmin?: boolean;
  }
}

const ADMIN_TTL_SEC = 300; // 5 minutes

function adminKey(chatId: number, userId: number): string {
  return `admin:${chatId}:${userId}`;
}

/**
 * Resolve whether the message sender is an administrator of the chat.
 * Result is cached in Redis for `ADMIN_TTL_SEC`. Attaches `ctx.isAdmin`.
 */
export async function resolveAdmin(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.chat || !ctx.from || ctx.chat.type === "private") {
    ctx.isAdmin = false;
    return next();
  }
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const key = adminKey(chatId, userId);

  try {
    const cached = await redis.get(key);
    if (cached === "1") {
      ctx.isAdmin = true;
      return next();
    }
    if (cached === "0") {
      ctx.isAdmin = false;
      return next();
    }

    const member = await ctx.api.getChatMember(chatId, userId).catch((err) => {
      logger.warn({ err, chatId, userId }, "getChatMember failed");
      return null;
    });

    const isAdmin =
      member != null &&
      (member.status === "creator" || member.status === "administrator");

    await redis.set(key, isAdmin ? "1" : "0", "EX", ADMIN_TTL_SEC);
    ctx.isAdmin = isAdmin;
  } catch (err) {
    logger.error({ err, chatId, userId }, "resolveAdmin error");
    ctx.isAdmin = false;
  }

  return next();
}

/**
 * Guard: allow the handler to run only if the sender is a chat admin.
 * Must run after `resolveAdmin`. Replies with an error otherwise.
 */
export async function adminOnly(ctx: Context, next: NextFunction): Promise<void> {
  if (ctx.isAdmin) {
    return next();
  }
  await ctx.reply?.("🚫 Эта команда доступна только администраторам чата.");
}

/**
 * Invalidate cached admin status for a user (e.g. after rights change).
 */
export async function invalidateAdminCache(
  chatId: number,
  userId: number,
): Promise<void> {
  await redis.del(adminKey(chatId, userId));
}
