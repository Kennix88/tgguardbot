import { prisma, FlagStatus, type GlobalUserFlag } from "../db";
import { logger } from "../logger";

/**
 * Service for the global user-flag list (spec §3 "Global flag", §7.2).
 * The list is shared across all chats where the bot operates.
 */

export async function getFlag(userId: bigint): Promise<GlobalUserFlag | null> {
  return prisma.globalUserFlag.findUnique({ where: { userId } });
}

export async function upsertFlag(
  userId: bigint,
  status: FlagStatus,
  opts: { reason?: string; reportedFrom?: bigint; scoreDelta?: number } = {},
): Promise<GlobalUserFlag> {
  const existing = await prisma.globalUserFlag.findUnique({ where: { userId } });
  const newScore = (existing?.score ?? 0) + (opts.scoreDelta ?? 0);
  return prisma.globalUserFlag.upsert({
    where: { userId },
    create: {
      userId,
      status,
      reason: opts.reason,
      reportedFrom: opts.reportedFrom,
      score: newScore,
    },
    update: {
      status,
      reason: opts.reason ?? existing?.reason,
      reportedFrom: opts.reportedFrom ?? existing?.reportedFrom,
      score: newScore,
    },
  });
}

/**
 * Promote a user's flag based on accumulated score (heuristic).
 * Used by the moderation pipeline when borderline spam is detected.
 */
export async function bumpScore(
  userId: bigint,
  delta: number,
  reason?: string,
): Promise<GlobalUserFlag> {
  const existing = await prisma.globalUserFlag.findUnique({ where: { userId } });
  const score = (existing?.score ?? 0) + delta;
  let status = existing?.status ?? FlagStatus.SUSPECT;
  // Thresholds (illustrative): cross 10 → BOT_DETECT, cross 25 → GLOBAL_BANNED.
  if (score >= 25) status = FlagStatus.GLOBAL_BANNED;
  else if (score >= 10) status = FlagStatus.BOT_DETECT;
  return upsertFlag(userId, status, { reason, scoreDelta: delta });
}

export async function removeFlag(userId: bigint): Promise<void> {
  try {
    await prisma.globalUserFlag.delete({ where: { userId } });
  } catch {
    // already absent
  }
}

/** Parse the CLI-style status argument used by /globalflag. */
export function parseFlagStatus(s: string): FlagStatus | null {
  const map: Record<string, FlagStatus> = {
    suspect: FlagStatus.SUSPECT,
    bot_detect: FlagStatus.BOT_DETECT,
    bot: FlagStatus.BOT_DETECT,
    ban: FlagStatus.GLOBAL_BANNED,
    banned: FlagStatus.GLOBAL_BANNED,
  };
  return map[s.toLowerCase()] ?? null;
}

export function statusLabel(status: FlagStatus): string {
  switch (status) {
    case FlagStatus.SUSPECT:
      return "подозрительный";
    case FlagStatus.BOT_DETECT:
      return "бот";
    case FlagStatus.GLOBAL_BANNED:
      return "глобально забанен";
  }
}

export { FlagStatus };
export type { GlobalUserFlag };

/** convenience no-op to keep logger import alive for future use here */
export const _log = logger;
