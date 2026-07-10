import type { Bot, Context } from "grammy";
import { prisma, LinkMode, WhitelistType, MemberStatus } from "../../db";
import { adminOnly } from "../../middlewares/adminOnly";
import { activateSubscription } from "../../services/subscriptionService";
import { describeSubscription } from "../../services/subscriptionService";
import { logger } from "../../logger";

/**
 * Chat-admin commands (spec §11). These must run inside the chat;
 * `adminOnly` requires `ctx.isAdmin` to have been resolved upstream.
 */
export function registerAdminCommands(bot: Bot): void {
  // helper: extract args after the command
  const args = (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    return text.split(/\s+/).slice(1);
  };

  const ensureChat = async (ctx: Context) => {
    const id = BigInt(ctx.chat!.id);
    const chat = await prisma.chat.findUnique({ where: { id } });
    return chat;
  };

  // ---- /banword <word or /regex/> ----
  bot.command("banword", adminOnly, async (ctx) => {
    const a = args(ctx);
    if (a.length === 0) {
      await ctx.reply("Использование: `/banword <слово или /regex/>`", {
        parse_mode: "Markdown",
      });
      return;
    }
    const chat = await ensureChat(ctx);
    if (!chat) return;
    const raw = a.join(" ");
    let pattern = raw;
    let isRegex = false;
    const reMatch = raw.match(/^\/(.+)\/([a-z]*)$/i);
    if (reMatch) {
      pattern = reMatch[1];
      isRegex = true;
      try {
        new RegExp(pattern, "i");
      } catch {
        await ctx.reply("❌ Некорректное регулярное выражение.");
        return;
      }
    }
    try {
      await prisma.banWord.create({
        data: {
          chatId: chat.id,
          pattern,
          isRegex,
          addedBy: BigInt(ctx.from!.id),
        },
      });
      await ctx.reply(
        isRegex ? `✅ Добавлен regex-паттерн: \`${pattern}\`` : `✅ Добавлено слово: ${pattern}`,
        { parse_mode: "Markdown" },
      );
    } catch (err: any) {
      if (err?.code === "P2002") {
        await ctx.reply("ℹ️ Такое правило уже есть.");
      } else {
        logger.error({ err }, "banword create error");
        await ctx.reply("❌ Ошибка при добавлении.");
      }
    }
  });

  // ---- /unbanword <word> ----
  bot.command("unbanword", adminOnly, async (ctx) => {
    const a = args(ctx);
    if (a.length === 0) {
      await ctx.reply("Использование: `/unbanword <слово>`", { parse_mode: "Markdown" });
      return;
    }
    const pattern = a.join(" ");
    const res = await prisma.banWord.deleteMany({
      where: { chatId: BigInt(ctx.chat!.id), pattern },
    });
    await ctx.reply(
      res.count > 0 ? `✅ Удалено правил: ${res.count}.` : "ℹ️ Правило не найдено.",
    );
  });

  // ---- /banwords ----
  bot.command("banwords", adminOnly, async (ctx) => {
    const words = await prisma.banWord.findMany({
      where: { chatId: BigInt(ctx.chat!.id) },
      orderBy: { createdAt: "asc" },
    });
    if (words.length === 0) {
      await ctx.reply("Список бан-слов пуст.");
      return;
    }
    const list = words
      .map((w) => `• ${w.isRegex ? `\`/${w.pattern}/\`` : w.pattern}`)
      .join("\n");
    await ctx.reply(`Бан-слова чата:\n${list}`, { parse_mode: "Markdown" });
  });

  // ---- /whitelist domain|word <value> ----
  bot.command("whitelist", adminOnly, async (ctx) => {
    const a = args(ctx);
    if (a.length < 2) {
      await ctx.reply(
        "Использование:\n`/whitelist domain example.com`\n`/whitelist word слово`",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const sub = a[0].toLowerCase();
    const type =
      sub === "domain" ? WhitelistType.DOMAIN : sub === "word" ? WhitelistType.WORD : null;
    if (!type) {
      await ctx.reply("❌ Тип должен быть `domain` или `word`.", { parse_mode: "Markdown" });
      return;
    }
    const value = a.slice(1).join(" ").toLowerCase();
    try {
      await prisma.whitelistEntry.create({
        data: {
          chatId: BigInt(ctx.chat!.id),
          type,
          value,
          addedBy: BigInt(ctx.from!.id),
        },
      });
      await ctx.reply(`✅ Добавлено в whitelist (${sub}): ${value}`);
    } catch (err: any) {
      if (err?.code === "P2002") {
        await ctx.reply("ℹ️ Уже в whitelist.");
      } else {
        logger.error({ err }, "whitelist create error");
        await ctx.reply("❌ Ошибка при добавлении.");
      }
    }
  });

  // ---- /unwhitelist <value> ----
  bot.command("unwhitelist", adminOnly, async (ctx) => {
    const a = args(ctx);
    if (a.length === 0) {
      await ctx.reply("Использование: `/unwhitelist <значение>`", {
        parse_mode: "Markdown",
      });
      return;
    }
    const value = a.join(" ").toLowerCase();
    const res = await prisma.whitelistEntry.deleteMany({
      where: { chatId: BigInt(ctx.chat!.id), value },
    });
    await ctx.reply(res.count > 0 ? `✅ Удалено: ${res.count}.` : "ℹ️ Не найдено.");
  });

  // ---- /whitelistlist ----
  bot.command("whitelistlist", adminOnly, async (ctx) => {
    const entries = await prisma.whitelistEntry.findMany({
      where: { chatId: BigInt(ctx.chat!.id) },
      orderBy: { type: "asc" },
    });
    if (entries.length === 0) {
      await ctx.reply("Whitelist пуст.");
      return;
    }
    const byType = (t: WhitelistType) =>
      entries
        .filter((e) => e.type === t)
        .map((e) => `• ${e.value}`)
        .join("\n");
    const msg = [
      `*Domains:*`,
      byType(WhitelistType.DOMAIN) || "(пусто)",
      ``,
      `*Words:*`,
      byType(WhitelistType.WORD) || "(пусто)",
    ].join("\n");
    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // ---- /linkmode allow|whitelist|delete ----
  bot.command("linkmode", adminOnly, async (ctx) => {
    const a = args(ctx);
    const map: Record<string, LinkMode> = {
      allow: LinkMode.ALLOW,
      whitelist: LinkMode.WHITELIST_ONLY,
      delete: LinkMode.DELETE_ALL,
    };
    const mode = a[0]?.toLowerCase();
    if (!mode || !(mode in map)) {
      await ctx.reply(
        "Использование: `/linkmode allow|whitelist|delete`",
        { parse_mode: "Markdown" },
      );
      return;
    }
    await prisma.chat.update({
      where: { id: BigInt(ctx.chat!.id) },
      data: { linkMode: map[mode] },
    });
    await ctx.reply(`✅ Режим ссылок: ${mode}`);
  });

  // ---- /captcha on|off ----
  bot.command("captcha", adminOnly, async (ctx) => {
    const a = args(ctx);
    const on = a[0]?.toLowerCase() === "on";
    const off = a[0]?.toLowerCase() === "off";
    if (!on && !off) {
      await ctx.reply("Использование: `/captcha on|off`", { parse_mode: "Markdown" });
      return;
    }
    await prisma.chat.update({
      where: { id: BigInt(ctx.chat!.id) },
      data: { captchaEnabled: on },
    });
    await ctx.reply(`✅ Капча ${on ? "включена" : "выключена"}.`);
  });

  // ---- /muteinsteadofban on|off ----
  bot.command("muteinsteadofban", adminOnly, async (ctx) => {
    const a = args(ctx);
    const on = a[0]?.toLowerCase() === "on";
    const off = a[0]?.toLowerCase() === "off";
    if (!on && !off) {
      await ctx.reply("Использование: `/muteinsteadofban on|off`", {
        parse_mode: "Markdown",
      });
      return;
    }
    await prisma.chat.update({
      where: { id: BigInt(ctx.chat!.id) },
      data: { muteInsteadOfBan: on },
    });
    await ctx.reply(`✅ Эскалация: ${on ? "мут" : "бан"}.`);
  });

  // ---- /warns @user (or reply target) ----
  bot.command("warns", adminOnly, async (ctx) => {
    const target = await resolveTargetUser(ctx);
    if (!target) {
      await ctx.reply("Укажите пользователя: `/warns @user` или ответом на сообщение.");
      return;
    }
    const m = await prisma.chatMembership.findUnique({
      where: { chatId_userId: { chatId: BigInt(ctx.chat!.id), userId: BigInt(target) } },
    });
    const warns = m?.warnCount ?? 0;
    const status = m?.status ?? "(нет записи)";
    await ctx.reply(`Пользователь ${target}: варнов — ${warns}, статус — ${status}.`);
  });

  // ---- /unban @user ----
  bot.command("unban", adminOnly, async (ctx) => {
    const target = await resolveTargetUser(ctx);
    if (!target) {
      await ctx.reply("Укажите пользователя: `/unban @user` или ответом на сообщение.");
      return;
    }
    await prisma.chatMembership.upsert({
      where: { chatId_userId: { chatId: BigInt(ctx.chat!.id), userId: BigInt(target) } },
      create: {
        chatId: BigInt(ctx.chat!.id),
        userId: BigInt(target),
        status: MemberStatus.VERIFIED,
        warnCount: 0,
      },
      update: { status: MemberStatus.VERIFIED },
    });
    // best-effort: restore permissions
    try {
      await ctx.api.restrictChatMember(
        ctx.chat!.id,
        target,
        {
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
        },
        { use_independent_chat_permissions: true },
      );
    } catch (err) {
      logger.warn({ err }, "unban restrict failed");
    }
    await ctx.reply(`✅ С пользователя ${target} сняты ограничения.`);
  });

  // ---- /stats ----
  bot.command("stats", adminOnly, async (ctx) => {
    const chatId = BigInt(ctx.chat!.id);
    const since = new Date(Date.now() - 24 * 3600_000);
    const [deletes, warns, bans, restricts, members, bwCount] = await Promise.all([
      prisma.moderationLog.count({ where: { chatId, action: "delete", createdAt: { gte: since } } }),
      prisma.moderationLog.count({ where: { chatId, action: "warn", createdAt: { gte: since } } }),
      prisma.moderationLog.count({ where: { chatId, action: "ban", createdAt: { gte: since } } }),
      prisma.moderationLog.count({
        where: { chatId, action: { in: ["restrict_temp", "mute_forever"] }, createdAt: { gte: since } },
      }),
      prisma.chatMembership.count({ where: { chatId } }),
      prisma.banWord.count({ where: { chatId } }),
    ]);
    await ctx.reply(
      [
        "📊 *Статистика за 24 часа:*",
        `• Удалений: ${deletes}`,
        `• Варнов: ${warns}`,
        `• Банов: ${bans}`,
        `• Мутов/ограничений: ${restricts}`,
        `• Участников в базе: ${members}`,
        `• Бан-слов: ${bwCount}`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  // ---- /subscribe (stub per spec §9) ----
  bot.command("subscribe", async (ctx) => {
    const chat = await ensureChat(ctx);
    const status = chat ? describeSubscription(chat) : "нет данных";
    await ctx.reply(
      [
        "💳 Оплата через Telegram Stars появится в следующей версии.",
        "",
        `Текущий статус: ${status}.`,
      ].join("\n"),
    );
  });

  // (grantsub is super-admin only; kept in superAdminCommands)
}

/** Resolve a target user id from command args (`@user`/numeric) or replied message. */
async function resolveTargetUser(ctx: Context): Promise<number | null> {
  const a = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const replied = ctx.message?.reply_to_message?.from;
  if (replied) return replied.id;
  const arg = a[0];
  if (!arg) return null;
  if (/^-?\d+$/.test(arg)) return Number(arg);
  // @username — best-effort: we cannot resolve without extra API; reply required.
  return null;
}

// unused import guard
void activateSubscription;
