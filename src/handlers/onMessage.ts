import type { Bot, Context, Api } from "grammy";
import { prisma } from "../db";
import { logger } from "../logger";
import {
  runModeration,
  executeAction,
  trackUserForQuota,
  actionLabel,
  type ModerationAction,
} from "../services/moderationService";
import { consumeMessageQuota } from "../services/rateLimiter";
import { bumpScore } from "../services/globalListService";
import { scheduleSelfDestruct } from "../services/captchaService";

/**
 * Wire the on-message moderation pipeline + captcha callback handling.
 *
 * Assumes upstream middlewares set:
 *  - ctx.isAdmin      (resolveAdmin)
 *  - ctx.isSuperAdmin (resolveSuperAdmin)
 *  - ctx.chatAccess   (chatAccess)
 */
export function registerMessageHandlers(bot: Bot): void {
  // NOTE: Captcha button callbacks are handled in
  // `services/captcha-handlers.ts` (registerCaptchaHandlers), which is the
  // only place that parses `cap:<slot>` against the current image captcha
  // state. The old handler here checked for the literal `cap:ok`, which the
  // image captcha NEVER sends (buttons carry slot indices 0..3), so every
  // click was treated as wrong → user kicked/banned despite a correct answer.

  // ---- Moderation feedback callbacks (admin only) ----
  bot.callbackQuery(new RegExp(`^${MOD_FB_PREFIX}`), async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Only admins can confirm/revert moderation actions.
    if (!ctx.isAdmin) {
      await ctx.answerCallbackQuery({ text: "❌ Только для админов." });
      return;
    }

    // Parse "mfb:<logId>:revert" or "mfb:<logId>:confirm"
    const parts = data.slice(MOD_FB_PREFIX.length).split(":");
    const logId = parts[0];
    const verb = parts[1]; // "revert" | "confirm"

    const log = await prisma.moderationLog.findUnique({ where: { id: logId } });
    if (!log) {
      await ctx.answerCallbackQuery({ text: "❌ Запись не найдена." });
      return;
    }

    // Prevent double-clicking
    if (verb === "revert" && log.reverted) {
      await ctx.answerCallbackQuery({ text: "Уже отменено." });
      return;
    }
    if (verb === "confirm" && log.confirmed) {
      await ctx.answerCallbackQuery({ text: "Уже подтверждено." });
      return;
    }

    const targetUserId = Number(log.userId);

    if (verb === "revert") {
      // Undo the moderation action and mark reverted.
      await revertAction(ctx.api, chatId, targetUserId, log.action);
      await prisma.moderationLog.update({
        where: { id: logId },
        data: { reverted: true },
      });
      // If this was a false positive, reduce the user's global score.
      try {
        const flag = await prisma.globalUserFlag.findUnique({ where: { userId: log.userId } });
        if (flag && flag.score > 0) {
          await bumpScore(log.userId, -2, "false positive reverted");
        }
      } catch {}

      try {
        await ctx.editMessageText(
          [
            `🛡️ *Модерация — ОТМЕНЕНА*`,
            `• Действие: ${log.action}`,
            `• Пользователь: [${log.userId}](tg://user?id=${log.userId})`,
            `• Причина: ${log.text ?? "—"}`,
            ``,
            `↩️ _Действие отменено админом. Пользователь восстановлен._`,
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
      } catch {
        /* message may be gone */
      }
      await ctx.answerCallbackQuery({ text: "↩️ Действие отменено." });
      return;
    }

    if (verb === "confirm") {
      // Confirm the action was correct — training signal.
      await prisma.moderationLog.update({
        where: { id: logId },
        data: { confirmed: true },
      });
      // Boost the user's global score (escalate toward BOT_DETECT/GLOBAL_BANNED).
      const scoreBump = log.action === "ban" || log.action === "kick_global" ? 5 : 2;
      try {
        await bumpScore(
          log.userId,
          scoreBump,
          `confirmed by admin: ${log.action}`,
        );
      } catch {}

      try {
        await ctx.editMessageText(
          [
            `🛡️ *Модерация — ПОДТВЕРЖДЕНА*`,
            `• Действие: ${log.action}`,
            `• Пользователь: [${log.userId}](tg://user?id=${log.userId})`,
            `• Причина: ${log.text ?? "—"}`,
            ``,
            `✅ _Действие подтверждено админом. Данные обновлены._`,
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
      } catch {
        /* message may be gone */
      }
      await ctx.answerCallbackQuery({ text: "✅ Подтверждено." });
      return;
    }
  });

  // ---- Message pipeline ----
  bot.on("message:text", async (ctx) => {
    await handleMessage(ctx, ctx.message.text);
  });

  bot.on("message:caption", async (ctx) => {
    await handleMessage(ctx, ctx.message.caption ?? "");
  });

  // also handle media without caption (for admin/super-admin skip + link-in-entities)
  bot.on(
    ["message:photo", "message:video", "message:document", "message:animation"],
    async (ctx) => {
      // Build a pseudo-text from entities (links) when caption is absent.
      const entities = ctx.message.entities ?? [];
      const links: string[] = [];
      for (const e of entities) {
        if (e.type === "text_link" && typeof e.url === "string") {
          links.push(e.url);
        }
      }
      const text = links.join(" ");
      if (text) await handleMessage(ctx, text);
    },
  );
}

async function handleMessage(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const messageId = ctx.message?.message_id;
  if (!chatId || !userId || !messageId) return;

  // Skip commands — they're handled by dedicated routers.
  if (text.startsWith("/")) return;

  const bigChat = BigInt(chatId);
  const bigUser = BigInt(userId);

  // §7.1 — admins bypass all checks.
  const senderIsAdmin = !!ctx.isAdmin;

  // Free-tier quota accounting (only meaningful for non-full-access chats).
  if (!ctx.chatAccess?.fullAccess && !senderIsAdmin) {
    const quota = await consumeMessageQuota(bigChat);
    if (quota.exceeded) {
      // Spec §4 / §7.3: stop active moderation for the rest of the hour.
      // (Captcha at join still works independently.)
      return;
    }
  }

  // Track unique users (best-effort) for the free-tier user cap.
  if (!senderIsAdmin) {
    await trackUserForQuota(bigChat, bigUser).catch(() => {});
  }

  try {
    const result = await runModeration({
      chatId: bigChat,
      userId: bigUser,
      messageId,
      text,
      senderIsAdmin,
    });

    if (result.action.kind === "pass") return;

    const snapshot = text.length > 500 ? text.slice(0, 500) + "…" : text;
    const exec = await executeAction(ctx.api, chatId, userId, messageId, result.action, snapshot);

    // Announce impactful actions (ban/mute/kick) with admin feedback buttons.
    await announceAction(ctx, chatId, userId, exec.logId, result.action);
  } catch (err) {
    logger.error({ err, chatId, userId, messageId }, "onMessage moderation error");
  }
}

/** Actions that warrant a public announcement with admin feedback buttons. */
const ANNOUNCED_ACTIONS = new Set(["ban", "mute_forever", "restrict_temp", "kick_global"]);

/** Prefix for moderation-feedback callback data: "mfb:<logId>:<verb>" */
export const MOD_FB_PREFIX = "mfb:";

/**
 * Send a moderation announcement with inline buttons for admins to either
 * revert a false positive or confirm the action (training signal).
 */
async function announceAction(
  ctx: Context,
  chatId: number,
  userId: number,
  logId: string | null,
  action: ModerationAction,
): Promise<void> {
  if (!logId || !ANNOUNCED_ACTIONS.has(action.kind)) return;

  const label = actionLabel(action);
  const reason = action.kind === "pass" ? "—" : action.reason;
  const userMention = `[${userId}](tg://user?id=${userId})`;

  const text = [
    `🛡️ *Модерация*`,
    `• Действие: ${label}`,
    `• Пользователь: ${userMention}`,
    `• Причина: ${reason}`,
    ``,
    `_Админы могут отменить действие, если это ложное срабатывание._`,
  ].join("\n");

  const keyboard: { text: string; callback_data: string }[][] = [
    [
      { text: "↩️ Отменить", callback_data: `${MOD_FB_PREFIX}${logId}:revert` },
      { text: "✅ Корректно", callback_data: `${MOD_FB_PREFIX}${logId}:confirm` },
    ],
  ];

  try {
    const sent = await ctx.api.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
    // Автоудаление модерационного анонса через 24 ч., чтобы не засорять чат.
    scheduleSelfDestruct(ctx.api, chatId, sent.message_id, 24 * 60 * 60);
  } catch (err) {
    logger.warn({ err, chatId }, "announceAction: failed to send announcement");
  }
}

const FULL_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_manage_topics: true,
} as const;

/**
 * Undo a moderation action on a user.
 * Called when an admin clicks "↩️ Отменить" on a false-positive.
 */
async function revertAction(
  api: Api,
  chatId: number,
  userId: number,
  actionName: string,
): Promise<void> {
  try {
    switch (actionName) {
      case "ban":
      case "kick_global":
        // Unban the user so they can rejoin / send messages.
        await api.unbanChatMember(chatId, userId);
        break;
      case "restrict_temp":
      case "mute_forever":
        // Restore full permissions.
        await api.restrictChatMember(chatId, userId, FULL_PERMISSIONS, {
          use_independent_chat_permissions: true,
        });
        break;
    }
  } catch (err) {
    logger.warn({ err, chatId, userId, actionName }, "revertAction failed");
  }
}

// keep import alive
void bumpScore;
