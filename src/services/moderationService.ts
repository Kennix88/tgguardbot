import type { Api } from "grammy";
import {
  prisma,
  LinkMode,
  WhitelistType,
  MemberStatus,
  FlagStatus,
  type Chat,
  type ChatMembership,
} from "../db";
import { redis } from "../redis";
import { logger } from "../logger";
import {
  scoreSpam,
  extractUrls,
  domainOf,
  URL_REGEX,
} from "../utils/patterns";
import { getLlmModerator } from "./llm/llmModerator";
import { bumpScore } from "./globalListService";

/**
 * Moderation pipeline for incoming messages (spec §7).
 *
 * Caller (onMessage handler) is responsible for:
 *  - skipping admins (§7.1) — pass `senderIsAdmin`
 *  - free-tier quota accounting
 *
 * This module performs the substantive checks and returns a structured
 * decision so the handler can act (delete / restrict / ban / log).
 */

export interface ModerationInput {
  chatId: bigint;
  userId: bigint;
  /** message id, used for deletion */
  messageId: number;
  /** text to inspect (caption or text) */
  text: string;
  /** true if the sender is a chat admin → all checks skipped */
  senderIsAdmin: boolean;
}

export type ModerationAction =
  | { kind: "pass" }
  | { kind: "delete"; reason: string; score: number }
  | { kind: "restrict_temp"; reason: string; untilSeconds: number }
  | { kind: "mute_forever"; reason: string }
  | { kind: "ban"; reason: string }
  | { kind: "kick_global"; reason: string };

export interface ModerationResult {
  action: ModerationAction;
  matchedPatterns: string[];
  warnIncrement: number;
}

const TEMP_RESTRICT_SECONDS = 3600; // 1 hour
const WARN_WINDOW_HOURS = 24;
const WARN_THRESHOLD_TEMP = 3; // 3 warns → 1h restrict
const WARN_THRESHOLD_BAN = 5; // 5 warns → ban/mute

/** Count warns in the last 24h (we store total warnCount; here we approximate
 * by reading recent ModerationLog entries tagged with action='warn'). */
async function recentWarnCount(chatId: bigint, userId: bigint): Promise<number> {
  const since = new Date(Date.now() - WARN_WINDOW_HOURS * 3600_000);
  const n = await prisma.moderationLog.count({
    where: {
      chatId,
      userId,
      action: "warn",
      createdAt: { gte: since },
    },
  });
  return n;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match text against a chat's ban-words (plain or regex). */
async function matchBanWord(
  chatId: bigint,
  text: string,
): Promise<{ matched: boolean; pattern?: string; isRegex?: boolean }> {
  const words = await prisma.banWord.findMany({ where: { chatId } });
  const lower = text.toLowerCase();
  for (const w of words) {
    if (w.isRegex) {
      try {
        const re = new RegExp(w.pattern, "i");
        if (re.test(text)) return { matched: true, pattern: w.pattern, isRegex: true };
      } catch {
        // invalid regex stored — ignore
      }
    } else {
      if (lower.includes(w.pattern.toLowerCase())) {
        return { matched: true, pattern: w.pattern, isRegex: false };
      }
    }
  }
  return { matched: false };
}

/** Evaluate link policy against the message text (spec §7.4). */
async function checkLinks(
  chat: Chat,
  text: string,
): Promise<{ delete: boolean; reason?: string }> {
  if (chat.linkMode === LinkMode.ALLOW) return { delete: false };

  const urls = extractUrls(text);
  if (urls.length === 0) return { delete: false };

  if (chat.linkMode === LinkMode.DELETE_ALL) {
    return { delete: true, reason: "содержит ссылку (режим DELETE_ALL)" };
  }

  // WHITELIST_ONLY
  const domains = new Set(
    urls.map(domainOf).filter((d): d is string => !!d),
  );
  if (domains.size === 0) return { delete: false };

  const allowed = await prisma.whitelistEntry.findMany({
    where: {
      chatId: chat.id,
      type: WhitelistType.DOMAIN,
      value: { in: [...domains] },
    },
  });
  const allowedSet = new Set(allowed.map((w) => w.value.toLowerCase()));
  for (const d of domains) {
    if (!allowedSet.has(d.toLowerCase())) {
      return {
        delete: true,
        reason: `домен ${d} не в whitelist (режим WHITELIST_ONLY)`,
      };
    }
  }
  return { delete: false };
}

export async function runModeration(input: ModerationInput): Promise<ModerationResult> {
  const { chatId, userId, messageId, text, senderIsAdmin } = input;

  // §7.1 — admins bypass everything
  if (senderIsAdmin) {
    return { action: { kind: "pass" }, matchedPatterns: [], warnIncrement: 0 };
  }

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    return { action: { kind: "pass" }, matchedPatterns: [], warnIncrement: 0 };
  }

  // §7.2 — global flag checks
  const flag = await prisma.globalUserFlag.findUnique({ where: { userId } });
  if (flag?.status === FlagStatus.GLOBAL_BANNED) {
    return {
      action: { kind: "kick_global", reason: "пользователь в глобальном бан-листе" },
      matchedPatterns: [],
      warnIncrement: 0,
    };
  }
  // BOT_DETECT / SUSPECT → silent delete, no automatic ban/kick
  const silentDeleteDueToFlag =
    flag?.status === FlagStatus.BOT_DETECT || flag?.status === FlagStatus.SUSPECT;

  // §7.4 — links
  const linkCheck = await checkLinks(chat, text);
  if (linkCheck.delete) {
    if (silentDeleteDueToFlag) {
      return {
        action: { kind: "delete", reason: linkCheck.reason ?? "ссылка", score: 0 },
        matchedPatterns: [],
        warnIncrement: 0,
      };
    }
    return {
      action: { kind: "delete", reason: linkCheck.reason ?? "ссылка", score: 0 },
      matchedPatterns: [],
      warnIncrement: 0,
    };
  }

  // §7.5 — ban-words
  const bw = await matchBanWord(chatId, text);
  if (bw.matched) {
    // increment warnCount + log a warn entry (for 24h window counting)
    await prisma.chatMembership.upsert({
      where: { chatId_userId: { chatId, userId } },
      create: { chatId, userId, warnCount: 1 },
      update: { warnCount: { increment: 1 } },
    });
    await prisma.moderationLog.create({
      data: {
        chatId,
        userId,
        action: "warn",
        text: `бран-слово: ${bw.pattern}`,
      },
    });

    const warns = await recentWarnCount(chatId, userId);

    // §7.6 — escalation
    if (warns >= WARN_THRESHOLD_BAN) {
      if (chat.muteInsteadOfBan) {
        await setMembershipStatusDb(chatId, userId, MemberStatus.RESTRICTED);
        return {
          action: { kind: "mute_forever", reason: `5+ варнов за 24ч (паттерн: ${bw.pattern})` },
          matchedPatterns: [],
          warnIncrement: 1,
        };
      }
      await setMembershipStatusDb(chatId, userId, MemberStatus.BANNED);
      return {
        action: { kind: "ban", reason: `5+ варнов за 24ч (паттерн: ${bw.pattern})` },
        matchedPatterns: [],
        warnIncrement: 1,
      };
    }
    if (warns >= WARN_THRESHOLD_TEMP) {
      return {
        action: {
          kind: "restrict_temp",
          reason: `3 варна за 24ч (паттерн: ${bw.pattern})`,
          untilSeconds: TEMP_RESTRICT_SECONDS,
        },
        matchedPatterns: [],
        warnIncrement: 1,
      };
    }
    return {
      action: { kind: "delete", reason: `бран-слово: ${bw.pattern}`, score: 1 },
      matchedPatterns: [],
      warnIncrement: 1,
    };
  }

  // §7 + §8 — LLM gray-zone: detect partial spam signals and consult LLM.
  // Even with NoopLlmModerator, strong pattern matches still escalate.
  const { score, matched } = scoreSpam(text);
  if (matched.length > 0) {
    // Gray-zone: if LLM is a noop it always says "not spam"; but a high
    // pattern score still warrants deletion + a warn.
    const llm = getLlmModerator();
    let llmSpam = false;
    let llmReason: string | undefined;
    try {
      const verdict = await llm.classify(text);
      llmSpam = verdict.spam && verdict.confidence >= 0.5;
      llmReason = verdict.reason;
    } catch (err) {
      logger.warn({ err }, "LLM classify failed (continuing with patterns only)");
    }

    const verdictSpam = llmSpam || score >= 5;
    if (verdictSpam) {
      await prisma.chatMembership.upsert({
        where: { chatId_userId: { chatId, userId } },
        create: { chatId, userId, warnCount: 1 },
        update: { warnCount: { increment: 1 } },
      });
      await prisma.moderationLog.create({
        data: {
          chatId,
          userId,
          action: "warn",
          text: `спам-паттерны: ${matched.join(",")}${llmReason ? ` | llm: ${llmReason}` : ""}`,
        },
      });
      // bump global score (heuristic escalation toward BOT_DETECT/GLOBAL_BANNED)
      await bumpScore(userId, Math.min(score, 10), `spam patterns: ${matched.join(",")}`);

      const warns = await recentWarnCount(chatId, userId);

      // §7.6 — escalation (same thresholds as ban-words)
      if (warns >= WARN_THRESHOLD_BAN) {
        if (chat.muteInsteadOfBan) {
          await setMembershipStatusDb(chatId, userId, MemberStatus.RESTRICTED);
          return {
            action: { kind: "mute_forever", reason: `5+ варнов за 24ч (спам-паттерны: ${matched.join(",")})` },
            matchedPatterns: matched,
            warnIncrement: 1,
          };
        }
        await setMembershipStatusDb(chatId, userId, MemberStatus.BANNED);
        return {
          action: { kind: "ban", reason: `5+ варнов за 24ч (спам-паттерны: ${matched.join(",")})` },
          matchedPatterns: matched,
          warnIncrement: 1,
        };
      }
      if (warns >= WARN_THRESHOLD_TEMP) {
        return {
          action: {
            kind: "restrict_temp",
            reason: `3 варна за 24ч (спам-паттерны: ${matched.join(",")})`,
            untilSeconds: TEMP_RESTRICT_SECONDS,
          },
          matchedPatterns: matched,
          warnIncrement: 1,
        };
      }

      return {
        action: {
          kind: "delete",
          reason: `спам-паттерны: ${matched.join(",")}`,
          score,
        },
        matchedPatterns: matched,
        warnIncrement: 1,
      };
    }
    // low-score partial match → just log, do not delete
    await prisma.moderationLog.create({
      data: {
        chatId,
        userId,
        action: "observe",
        text: `частичное совпадение паттернов: ${matched.join(",")}`,
        score,
      },
    });
    return {
      action: { kind: "pass" },
      matchedPatterns: matched,
      warnIncrement: 0,
    };
  }

  return { action: { kind: "pass" }, matchedPatterns: [], warnIncrement: 0 };
}

async function setMembershipStatusDb(
  chatId: bigint,
  userId: bigint,
  status: MemberStatus,
): Promise<void> {
  await prisma.chatMembership.upsert({
    where: { chatId_userId: { chatId, userId } },
    create: { chatId, userId, status },
    update: { status },
  });
}

export interface ExecuteResult {
  deleted: boolean;
  restricted: boolean;
  banned: boolean;
  kicked: boolean;
  /** id of the ModerationLog row created for this action (for admin feedback buttons) */
  logId: string | null;
}

const READ_ONLY_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_manage_topics: false,
} as const;

/** Human-readable label for an action kind (used in public announcements). */
export function actionLabel(action: ModerationAction): string {
  switch (action.kind) {
    case "delete":
      return "Сообщение удалено";
    case "restrict_temp":
      return "Пользователь временно ограничен (1 час)";
    case "mute_forever":
      return "Пользователь навсегда ограничен (мут)";
    case "ban":
      return "Пользователь забанен";
    case "kick_global":
      return "Пользователь исключён (глобальный бан-лист)";
    case "pass":
      return "";
  }
}

/**
 * Apply a moderation decision to Telegram and write a ModerationLog entry.
 * Returns the id of the created log row (used for admin feedback buttons).
 */
export async function executeAction(
  api: Api,
  chatId: number,
  userId: number,
  messageId: number,
  action: ModerationAction,
  textSnapshot?: string,
): Promise<ExecuteResult> {
  const result: ExecuteResult = {
    deleted: false,
    restricted: false,
    banned: false,
    kicked: false,
    logId: null,
  };
  const bigChat = BigInt(chatId);
  const bigUser = BigInt(userId);

  const writeLog = async (
    actionName: string,
    text: string | undefined,
    score?: number,
  ): Promise<string> => {
    const log = await prisma.moderationLog.create({
      data: {
        chatId: bigChat,
        userId: bigUser,
        action: actionName,
        text,
        score,
      },
    });
    return log.id;
  };

  try {
    switch (action.kind) {
      case "pass":
        return result;

      case "delete":
        await api.deleteMessage(chatId, messageId).catch(() => {});
        result.deleted = true;
        result.logId = await writeLog("delete", textSnapshot, action.score);
        break;

      case "restrict_temp": {
        const until = Math.floor(Date.now() / 1000) + action.untilSeconds;
        await api
          .restrictChatMember(chatId, userId, READ_ONLY_PERMISSIONS, {
            until_date: until,
            use_independent_chat_permissions: true,
          })
          .catch((err) => logger.warn({ err }, "restrict_temp failed"));
        result.restricted = true;
        await api.deleteMessage(chatId, messageId).catch(() => {});
        result.deleted = true;
        result.logId = await writeLog("restrict_temp", action.reason);
        break;
      }

      case "mute_forever": {
        await api
          .restrictChatMember(chatId, userId, READ_ONLY_PERMISSIONS, {
            use_independent_chat_permissions: true,
          })
          .catch((err) => logger.warn({ err }, "mute_forever failed"));
        result.restricted = true;
        await api.deleteMessage(chatId, messageId).catch(() => {});
        result.deleted = true;
        result.logId = await writeLog("mute_forever", action.reason);
        break;
      }

      case "ban": {
        await api.banChatMember(chatId, userId).catch((err) =>
          logger.warn({ err }, "ban failed"),
        );
        result.banned = true;
        await api.deleteMessage(chatId, messageId).catch(() => {});
        result.deleted = true;
        result.logId = await writeLog("ban", action.reason);
        break;
      }

      case "kick_global": {
        try {
          await api.banChatMember(chatId, userId);
          await api.unbanChatMember(chatId, userId);
        } catch (err) {
          logger.warn({ err }, "kick_global ban/unban failed");
        }
        result.kicked = true;
        await api.deleteMessage(chatId, messageId).catch(() => {});
        result.deleted = true;
        result.logId = await writeLog("kick_global", action.reason);
        break;
      }
    }
  } catch (err) {
    logger.error({ err, action }, "executeAction error");
  }

  return result;
}

/** Re-export URL_REGEX for handlers that may need it. */
export { URL_REGEX, escapeRegex };

/** Track a unique user for free-tier accounting (best-effort). */
export async function trackUserForQuota(chatId: bigint, userId: bigint): Promise<void> {
  const key = `chat:${chatId.toString()}:users`;
  await redis.sadd(key, userId.toString()).catch(() => {});
}

export type { Chat, ChatMembership };
