import { Bot } from "grammy";
import { config } from "./config";
import { logger } from "./logger";
import { connectPrisma, disconnectPrisma } from "./db";
import { disconnectRedis } from "./redis";
import { resolveAdmin } from "./middlewares/adminOnly";
import { resolveSuperAdmin } from "./middlewares/superAdminOnly";
import { chatAccess } from "./middlewares/chatAccess";
import { registerMyChatMember } from "./handlers/onMyChatMember";
import { registerMessageHandlers } from "./handlers/onMessage";
import { registerAdminCommands } from "./handlers/commands/adminCommands";
import { registerSuperAdminCommands } from "./handlers/commands/superAdminCommands";
import { onChatMember } from "./handlers/onChatMember";
import { registerCaptchaHandlers } from "./services/captcha-handlers";

/**
 * Build grammY client options. Honours `GRASPIL_PROXY_URL`: when set, all
 * Telegram API calls (bot polling, /backup document upload, etc.) go through
 * that root instead of the default https://api.telegram.org.
 */
function buildClientOptions(): { apiRoot?: string } {
    const root = config.GRASPIL_PROXY_URL.trim().replace(/\/+$/, "");
    if (!root) return {};
    logger.info({ apiRoot: root }, "using custom Telegram API root");
    return { apiRoot: root };
}

async function main(): Promise<void> {
    logger.info({ node: process.version }, "starting antispam-bot");

    await connectPrisma();

    const bot = new Bot(config.BOT_TOKEN, {
        // Optional Telegram API mirror/proxy (e.g. GRASPIL_PROXY_URL).
        // Falls back to the default https://api.telegram.org when unset.
        client: buildClientOptions(),
    });

    // ---- Global middlewares ----
    bot.use(resolveSuperAdmin);

    // For chat messages: resolve admin status + access tier before handlers.
    bot.use(async (ctx, next) => {
        if (ctx.chat && ctx.chat.type !== "private") {
            await resolveAdmin(ctx, async () => {});
            await chatAccess(ctx, async () => {});
        }
        return next();
    });

    bot.catch(({ error, ctx }) => {
        logger.error(
            {
                err: error,
                chatId: ctx.chat?.id,
                update_id: ctx.update.update_id,
            },
            "unhandled bot error",
        );
    });

    // ---- /start (DMs only) ----
    bot.command("start", async (ctx) => {
        if (ctx.chat?.type !== "private") return;
        await ctx.reply(
            [
                "👋 Привет! Я — бот для модерации Telegram-чатов.",
                "",
                "🛡️ *Что я умею:*",
                "• Капча для новых участников (проверка что не бот)",
                "• Фильтрация ссылок (разрешить / whitelist / удалить все)",
                "• Блокировка запрещённых слов и фраз (включая regex)",
                "• Авто-эскалация: варны → мут → бан",
                "• Глобальный бан-лист (общий для всех чатов)",
                "",
                "📋 *Как добавить меня в чат:*",
                "1. Добавьте меня в группу как администратора",
                "   (нужны права: ограничивать участников, удалять сообщения, банить).",
                "2. Бот отправит запрос на одобрение владельцу.",
                "3. После одобрения все функции будут включены.",
                "",
                "✨ *Команды:*",
                "• В личке со мной: /help",
                "• В чате (для админов): /help",
            ].join("\n"),
            { parse_mode: "Markdown" },
        );
    });

    // ---- /help (single handler: branches by chat type) ----
    // NOTE: previously there were two `bot.command("help")` handlers — one for
    // DMs and one for groups. The DM handler early-`return`ed in groups without
    // calling next(), which (in grammY) short-circuits the whole chain, so the
    // group handler never ran and `/help` silently did nothing in groups.
    // Merging into one handler with an internal branch fixes that.
    bot.command("help", async (ctx) => {
        // In a group: short admin quick-reference.
        if (ctx.chat && ctx.chat.type !== "private") {
            await ctx.reply(
                [
                    "🛡️ *Команды модерации (только для админов):*",
                    "",
                    "• `/banword <слово>` — добавить бан-слово",
                    "• `/banword /regex/` — добавить regex-паттерн",
                    "• `/unbanword <слово>` — удалить бан-слово",
                    "• /banwords — список бан-слов",
                    "• `/whitelist domain <домен>` — домен в whitelist",
                    "• `/whitelist word <слово>` — слово-исключение",
                    "• `/unwhitelist <значение>` — удалить из whitelist",
                    "• /whitelistlist — список whitelist",
                    "• `/linkmode allow|whitelist|delete` — режим ссылок",
                    "• `/captcha on|off` — вкл/выкл капчу",
                    "• `/muteinsteadofban on|off` — мут вместо бана",
                    "• `/warns @user` — варны (или ответ на сообщение)",
                    "• `/unban @user` — снять ограничения (или ответ)",
                    "• /stats — статистика за 24ч",
                    "• /subscribe — статус подписки",
                    "",
                    "💡 Напишите боту в личные сообщения для полной справки: /help",
                ].join("\n"),
                { parse_mode: "Markdown" },
            );
            return;
        }

        // In DMs: full reference (incl. owner commands if applicable).
        const lines = [
            "📖 *Справка по командам:*",
            "",
            "*В личке с ботом (все пользователи):*",
            "• /start — приветствие и инструкция",
            "• /help — эта справка",
            "",
            "*В чате (только для админов):*",
            "• /help — справка по командам модерации",
            "• `/banword <слово>` — добавить бан-слово",
            "• `/banword /regex/` — добавить regex-паттерн",
            "• `/unbanword <слово>` — удалить бан-слово",
            "• /banwords — список бан-слов чата",
            "• `/whitelist domain <example.com>` — домен в whitelist",
            "• `/whitelist word <слово>` — слово-исключение",
            "• `/unwhitelist <значение>` — удалить из whitelist",
            "• /whitelistlist — список whitelist",
            "• `/linkmode allow|whitelist|delete` — режим ссылок",
            "• `/captcha on|off` — вкл/выкл капчу",
            "• `/muteinsteadofban on|off` — мут вместо бана",
            "• `/warns @user` — варны пользователя (или ответ на сообщение)",
            "• `/unban @user` — снять ограничения (или ответ на сообщение)",
            "• /stats — статистика модерации за 24ч",
            "• /subscribe — статус подписки (оплата скоро)",
        ];
        if (ctx.isSuperAdmin) {
            lines.push(
                "",
                "🔑 *Команды владельца бота (в личке):*",
                "• /pendingchats — список чатов, ожидающих одобрения",
                "• `/approve <chatId>` — выдать полный доступ",
                "• `/revoke <chatId>` — отозвать доступ",
                "• `/grantsub <chatId> <days>` — выдать подписку (тест)",
                "• `/globalflag <userId> suspect|bot_detect|ban` — глобальный флаг",
                "• /backup — создать и прислать дамп БД сейчас",
                "• /ownerhelp — справка по командам владельца",
            );
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    });

    // ---- chat_member / my_chat_member ----
    bot.on("chat_member", onChatMember);
    registerMyChatMember(bot);

    // ---- commands & message pipeline ----
    registerAdminCommands(bot);
    registerSuperAdminCommands(bot);
    registerMessageHandlers(bot);
    // Captcha button callbacks (image captcha). MUST be the only handler
    // for `cap:*` callbacks — see onMessage.ts for why the old one was removed.
    registerCaptchaHandlers(bot);

    // ---- start (long polling) ----
    await bot.start({
        onStart: (info) => {
            logger.info(
                { username: info.username, id: info.id },
                "bot started (long polling)",
            );
        },
        allowed_updates: [
            "message",
            "edited_message",
            "callback_query",
            "chat_member",
            "my_chat_member",
        ],
    });
}

async function shutdown(err?: unknown): Promise<void> {
    logger.info({ err }, "shutting down...");
    try {
        await disconnectPrisma();
    } catch {}
    try {
        await disconnectRedis();
    } catch {}
    process.exit(err ? 1 : 0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException");
    void shutdown(err);
});

main().catch((err) => {
    logger.fatal({ err }, "fatal startup error");
    void shutdown(err);
});
