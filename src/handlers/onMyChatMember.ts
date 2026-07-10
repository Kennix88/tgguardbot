import type { Bot, Context } from "grammy";
import { prisma } from "../db";
import { logger } from "../logger";
import { config } from "../config";
import { scheduleSelfDestruct } from "../services/captchaService";

/**
 * Handler for `my_chat_member` updates — the bot itself was added to /
 * removed from a chat. Per spec §5:
 *
 *  1. Bot added (status → member/administrator) → create Chat with status
 *     PENDING (approved=false, no subscription).
 *  2. Notify the chat: "Бот ожидает подтверждения...".
 *  3. DM each SUPER_ADMIN_IDS owner with inline buttons Одобрить / Отклонить.
 *  4. (Approval handled in command/callback handlers — see superAdminCommands.)
 *
 * Also handles the bot being kicked (status → left) — we keep the row for
 * audit but could mark inactive. MVP: just log.
 */
export function registerMyChatMember(bot: Bot): void {
  bot.on("my_chat_member", async (ctx: Context) => {
    const upd = ctx.myChatMember;
    if (!upd) return;

    const chatId = upd.chat.id;
    const bigChat = BigInt(chatId);
    const newStatus = upd.new_chat_member.status;
    const oldStatus = upd.old_chat_member.status;

    const added =
      (newStatus === "member" || newStatus === "administrator") &&
      oldStatus === "left";

    if (added) {
      await prisma.chat
        .upsert({
          where: { id: bigChat },
          create: {
            id: bigChat,
            title: upd.chat.title ?? null,
            approved: false,
            subscriptionActive: false,
          },
          update: { title: upd.chat.title ?? undefined },
        })
        .catch((err) => logger.error({ err, chatId }, "chat upsert failed"));

      // Notify the chat (auto-delete after 5 minutes).
      const welcomeMsg = await ctx.api
        .sendMessage(
          chatId,
          [
            "👋 Спасибо за установку!",
            "",
            "⏳ Бот ожидает подтверждения владельцем. Часть функций ограничена.",
            "Капча на вход работает всегда; полная модерация включится после одобрения.",
          ].join("\n"),
        )
        .catch((err) => {
          logger.warn({ err, chatId }, "notify chat failed");
          return null;
        });

      if (welcomeMsg) {
        scheduleSelfDestruct(ctx.api, chatId, welcomeMsg.message_id, 5 * 60);
      }

      // DM each super-admin with Approve / Reject buttons.
      const addedBy = upd.from?.id;
      const addedByName =
        [upd.from?.first_name, upd.from?.last_name].filter(Boolean).join(" ") ??
        "неизвестно";
      const info = [
        `📥 Новый чат запросил доступ:`,
        `• Название: ${upd.chat.title ?? "(без названия)"}`,
        `• ID: <code>${chatId}</code>`,
        `• Добавил: ${addedByName} (id: ${addedBy ?? "—"})`,
      ].join("\n");

      for (const adminId of config.SUPER_ADMIN_IDS) {
        await ctx.api
          .sendMessage(adminId, info, {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Одобрить", callback_data: `approve:${chatId}` },
                  { text: "⛔️ Отклонить", callback_data: `reject:${chatId}` },
                ],
              ],
            },
          })
          .catch((err) =>
            logger.warn({ err, adminId }, "notify super-admin failed"),
          );
      }
      return;
    }

    if (newStatus === "left" || newStatus === "kicked") {
      logger.info({ chatId }, "bot removed from chat");
      // MVP: do not delete the row (keep audit trail); real cleanup can be added.
    }
  });
}
