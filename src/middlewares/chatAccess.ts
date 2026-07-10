import type { Context, NextFunction } from "grammy";
import { prisma } from "../db";
import { redis } from "../redis";
import { config } from "../config";
import { logger } from "../logger";

/**
 * Access tier resolved for a chat, attached to ctx via `ctx.chatAccess`.
 *
 * - PENDING     — bot just added, awaiting owner approval
 * - FREE        — not approved, no active subscription (subject to free-tier limits)
 * - APPROVED    — owner granted unlimited free access
 * - SUBSCRIBED  — paid via Stars (or grant) until subscriptionExpiresAt
 */
export type ChatTier = "PENDING" | "FREE" | "APPROVED" | "SUBSCRIBED";

declare module "grammy" {
  interface Context {
    chatAccess?: {
      tier: ChatTier;
      fullAccess: boolean;
      /** unique tracked users for this chat (cached, approximate) */
      trackedUsers?: number;
    };
  }
}

function computeTier(chat: {
  approved: boolean;
  subscriptionActive: boolean;
  subscriptionExpiresAt: Date | null;
}): { tier: ChatTier; fullAccess: boolean } {
  const now = new Date();
  const subValid =
    chat.subscriptionActive &&
    chat.subscriptionExpiresAt != null &&
    chat.subscriptionExpiresAt > now;

  const fullAccess = chat.approved || subValid;
  let tier: ChatTier = "FREE";
  if (!chat.approved && !subValid) tier = "FREE";
  if (chat.approved) tier = "APPROVED";
  if (subValid && !chat.approved) tier = "SUBSCRIBED";
  // If both approved and subscribed → APPROVED wins (still full access)
  return { tier, fullAccess };
}

/** Redis cache key for tracked-users count of a chat (best-effort). */
function trackedUsersKey(chatId: bigint): string {
  return `chat:${chatId.toString()}:users`;
}

/**
 * Middleware: ensure the chat exists in DB and attach `ctx.chatAccess`.
 * Does not block message processing — tier decisions are advisory.
 */
export async function chatAccess(ctx: Context, next: NextFunction): Promise<void> {
  // Skip in private chats (DMs) — handled elsewhere.
  if (!ctx.chat || ctx.chat.type === "private") {
    return next();
  }

  const chatId = ctx.chat.id;
  try {
    const chat = await prisma.chat.findUnique({ where: { id: BigInt(chatId) } });

    if (!chat) {
      // Unknown chat — treat as FREE with no full access; do not auto-create
      // (chat creation is handled by the my_chat_member handler).
      ctx.chatAccess = { tier: "FREE", fullAccess: false };
      return next();
    }

    const { tier, fullAccess } = computeTier(chat);
    ctx.chatAccess = { tier, fullAccess };

    // If a non-approved user is allowed only up to N tracked users, count them.
    if (!fullAccess) {
      const cached = await redis.scard(trackedUsersKey(BigInt(chatId)));
      ctx.chatAccess.trackedUsers = cached;
      if (cached > config.FREE_TIER_MAX_USERS) {
        // Beyond tracked-users limit — keep tier as FREE but mark via low cap;
        // fullAccess stays false so free-tier limits still apply.
        ctx.chatAccess.tier = "FREE";
      }
    }
  } catch (err) {
    logger.error({ err, chatId }, "chatAccess middleware error");
    // On error, fall through without blocking.
    ctx.chatAccess = { tier: "FREE", fullAccess: false };
  }

  return next();
}
