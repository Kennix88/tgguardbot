import { prisma } from "../db";
import { logger } from "../logger";

/**
 * Telegram Stars subscription helpers (spec §9).
 *
 * Real Stars payment (sendInvoice with currency XTR) is intentionally NOT
 * implemented in MVP. This module exposes:
 *  - `activateSubscription(chatId, days)` — manual activation by super-admin
 *    via `/grantsub <chatId> <days>`, used to test the SUBSCRIBED flow.
 *  - `revokeSubscription` — turn it off.
 */

export async function activateSubscription(chatId: bigint, days: number): Promise<void> {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("days must be a positive number");
  }
  const now = new Date();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  await prisma.chat.update({
    where: { id: chatId },
    data: {
      subscriptionActive: true,
      subscriptionExpiresAt: expires,
    },
  });
  logger.info({ chatId, days, expires }, "subscription activated (manual grant)");
}

export async function revokeSubscription(chatId: bigint): Promise<void> {
  await prisma.chat.update({
    where: { id: chatId },
    data: {
      subscriptionActive: false,
      subscriptionExpiresAt: null,
    },
  });
  logger.info({ chatId }, "subscription revoked");
}

export function describeSubscription(chat: {
  subscriptionActive: boolean;
  subscriptionExpiresAt: Date | null;
}): string {
  if (
    chat.subscriptionActive &&
    chat.subscriptionExpiresAt &&
    chat.subscriptionExpiresAt > new Date()
  ) {
    return `подписка активна до ${chat.subscriptionExpiresAt.toISOString()}`;
  }
  return "подписка не активна";
}
