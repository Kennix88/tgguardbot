import type { Bot, Context } from "grammy";
import { InputFile } from "grammy";
import { prisma } from "../../db";
import { superAdminOnly } from "../../middlewares/superAdminOnly";
import {
  getFlag,
  upsertFlag,
  parseFlagStatus,
  statusLabel,
  FlagStatus,
} from "../../services/globalListService";
import { activateSubscription } from "../../services/subscriptionService";
import { createBackupArchive } from "../../services/backupService";
import { config } from "../../config";
import { logger } from "../../logger";

/**
 * Super-admin commands (spec §11). These run only in DMs with the bot.
 * Guarded by `superAdminOnly` (which already checks ID + private chat).
 */
export function registerSuperAdminCommands(bot: Bot): void {
  const args = (ctx: Context) => (ctx.message?.text ?? "").split(/\s+/).slice(1);

  // ---- /pendingchats ----
  bot.command("pendingchats", superAdminOnly, async (ctx) => {
    const chats = await prisma.chat.findMany({
      where: { approved: false, subscriptionActive: false },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    if (chats.length === 0) {
      await ctx.reply("Нет чатов, ожидающих одобрения.");
      return;
    }
    const list = chats
      .map((c) => `• ${c.title ?? "(без названия)"} — <code>${c.id}</code> (${c.createdAt.toISOString().slice(0, 10)})`)
      .join("\n");
    await ctx.reply(`Чаты в ожидании (PENDING/FREE):\n${list}`, { parse_mode: "HTML" });
  });

  // ---- /approve <chatId> ----
  bot.command("approve", superAdminOnly, async (ctx) => {
    const a = args(ctx);
    const chatId = parseBig(a[0]);
    if (chatId == null) {
      await ctx.reply("Использование: `/approve <chatId>`", { parse_mode: "Markdown" });
      return;
    }
    try {
      await prisma.chat.update({
        where: { id: chatId },
        data: { approved: true },
      });
      await ctx.api
        .sendMessage(Number(chatId), "✅ Доступ подтверждён, все функции включены.")
        .catch(() => {});
      await ctx.reply(`✅ Чат ${chatId} одобрен.`);
    } catch (err) {
      logger.error({ err, chatId }, "approve failed");
      await ctx.reply("❌ Чат не найден.");
    }
  });

  // ---- /revoke <chatId> ----
  bot.command("revoke", superAdminOnly, async (ctx) => {
    const a = args(ctx);
    const chatId = parseBig(a[0]);
    if (chatId == null) {
      await ctx.reply("Использование: `/revoke <chatId>`", { parse_mode: "Markdown" });
      return;
    }
    try {
      await prisma.chat.update({
        where: { id: chatId },
        data: { approved: false },
      });
      await ctx.reply(`✅ Доступ чата ${chatId} отозван (FREE-лимиты).`);
    } catch (err) {
      logger.error({ err, chatId }, "revoke failed");
      await ctx.reply("❌ Чат не найден.");
    }
  });

  // ---- /grantsub <chatId> <days> ----
  bot.command("grantsub", superAdminOnly, async (ctx) => {
    const a = args(ctx);
    const chatId = parseBig(a[0]);
    const days = Number(a[1]);
    if (chatId == null || !Number.isFinite(days) || days <= 0) {
      await ctx.reply("Использование: `/grantsub <chatId> <days>`", {
        parse_mode: "Markdown",
      });
      return;
    }
    try {
      await activateSubscription(chatId, days);
      await ctx.reply(`✅ Подписка на ${days} дн. выдана чату ${chatId}.`);
    } catch (err) {
      logger.error({ err }, "grantsub failed");
      await ctx.reply("❌ Ошибка выдачи подписки.");
    }
  });

  // ---- /globalflag <userId> <suspect|bot_detect|ban> ----
  bot.command("globalflag", superAdminOnly, async (ctx) => {
    const a = args(ctx);
    const userId = parseBig(a[0]);
    const status = parseFlagStatus(a[1] ?? "");
    if (userId == null || status == null) {
      await ctx.reply(
        "Использование: `/globalflag <userId> suspect|bot_detect|ban`",
        { parse_mode: "Markdown" },
      );
      return;
    }
    await upsertFlag(userId, status, { reportedFrom: BigInt(ctx.from!.id) });
    await ctx.reply(`✅ Флаг пользователя ${userId}: ${statusLabel(status)}.`);
  });

  // ---- /backup — dump DB and send to each super-admin DM ----
  bot.command("backup", superAdminOnly, async (ctx) => {
    await ctx.reply("⏳ Создаю дамп базы данных…");

    let archive;
    try {
      archive = await createBackupArchive();
    } catch (err) {
      logger.error({ err }, "backup command: dump failed");
      await ctx.reply("❌ Не удалось создать дамп БД. Подробности в логах.");
      return;
    }

    const sizeKb = Math.max(1, Math.round(archive.data.length / 1024));
    const caption = `💾 Дамп БД\n• Файл: ${archive.filename}\n• Размер: ~${sizeKb} KB\n• Создан: ${new Date().toISOString()}`;

    let sent = 0;
    for (const adminId of config.SUPER_ADMIN_IDS) {
      try {
        await ctx.api.sendDocument(adminId, new InputFile(archive.data, archive.filename), {
          caption,
        });
        sent++;
      } catch (err) {
        logger.warn({ err, adminId }, "backup command: send failed");
      }
    }
    await ctx.reply(`✅ Дамп отправлен ${sent}/${config.SUPER_ADMIN_IDS.length} супер-админам.`);
  });

  // ---- inline buttons: approve / reject (from my_chat_member DM) ----
  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    if (!ctx.isSuperAdmin) return void ctx.answerCallbackQuery();
    const chatId = parseBig(ctx.callbackQuery.data.split(":")[1]);
    if (chatId == null) return void ctx.answerCallbackQuery();
    try {
      await prisma.chat.update({ where: { id: chatId }, data: { approved: true } });
      await ctx.api
        .sendMessage(Number(chatId), "✅ Доступ подтверждён, все функции включены.")
        .catch(() => {});
      await ctx.answerCallbackQuery({ text: "Одобрено" });
      try {
        await ctx.editMessageText(`✅ Одобрено: чат ${chatId}.`);
      } catch {
        /* noop */
      }
    } catch (err) {
      logger.error({ err }, "approve callback failed");
      await ctx.answerCallbackQuery({ text: "Ошибка" });
    }
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    if (!ctx.isSuperAdmin) return void ctx.answerCallbackQuery();
    const chatId = parseBig(ctx.callbackQuery.data.split(":")[1]);
    if (chatId == null) return void ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery({ text: "Отклонено" });
    try {
      await ctx.editMessageText(`⛔️ Отклонено: чат ${chatId}.`);
    } catch {
      /* noop */
    }
  });

  // ---- /ownerhelp (superadmin-specific commands reference) ----
  bot.command("ownerhelp", superAdminOnly, async (ctx) => {
    await ctx.reply(
      [
        "🔑 *Команды владельца бота (в личке):*",
        "",
        "• /pendingchats — список чатов, ожидающих одобрения",
        "• `/approve <chatId>` — выдать полный бесплатный доступ",
        "• `/revoke <chatId>` — отозвать доступ (FREE-лимиты)",
        "• `/grantsub <chatId> <days>` — вручную выдать подписку",
        "• `/globalflag <userId> suspect|bot_detect|ban` — глобальный флаг",
        "• /backup — создать и прислать дамп БД сейчас",
        "• /ownerhelp — эта справка",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });
}

function parseBig(s?: string): bigint | null {
  if (!s) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

// keep imports used in type-space alive
void getFlag;
void FlagStatus;
