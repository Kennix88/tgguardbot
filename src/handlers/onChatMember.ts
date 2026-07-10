import type { Context } from "grammy";
import { prisma } from "../db";
import { redis } from "../redis";
import { logger } from "../logger";
import { config } from "../config";
import {
    restrictForCaptcha,
    sendCaptchaWithTimeout,
    getCaptchaState,
    clearCaptchaState,
    deleteCaptchaMessage,
    bumpCaptchaAttempts,
    setMembershipStatus,
    kickUser,
    banPermanently,
    MemberStatus,
    MAX_CAPTCHA_ATTEMPTS,
} from "../services/captchaService";
import {
    getFlag,
    statusLabel,
    FlagStatus,
} from "../services/globalListService";

/**
 * Handler for `chat_member` updates — a new participant joined the chat.
 *
 * ЭТО ЕДИНСТВЕННЫЙ обработчик chat_member в проекте. Если где-то ещё
 * зарегистрирован bot.on("chat_member", ...) (например, в старом
 * captcha.ts) — это гонка: на один join прилетает два independent
 * sendCaptcha, каждый пишет свой correctIndex в один и тот же ключ
 * Redis, и пользователь видит картинку от одного вызова, а Redis к
 * моменту клика уже хранит indexed от другого. Именно так объясняется
 * баг "кнопка не совпадает с фигурой" — правильная кнопка была верна
 * для другой, невидимой капчи. Держите регистрацию строго в одном месте.
 *
 * Per spec §6:
 *  - If the user is globally GLOBAL_BANNED → kick.
 *  - If BOT_DETECT → kick (skip captcha).
 *  - Otherwise (and captcha enabled) → restrict + send image captcha.
 *  - SUSPECT flag → still require captcha (no automatic action).
 *
 * Spec §6.6: captcha runs regardless of free-tier limits.
 * Spec §6.7: if the user leaves/is kicked while captcha is pending,
 *  the captcha is cancelled and its message removed immediately —
 *  there is no point holding a timer or showing a prompt to someone
 *  who is no longer in the chat.
 */
export async function onChatMember(ctx: Context): Promise<void> {
    const cm = ctx.chatMember ?? ctx.myChatMember;
    if (!cm) return;

    // Игнорируем апдейты, вызванные действиями самого бота (restrict/ban/unban).
    // Без этой проверки собственные вызовы restrictChatMember/banChatMember
    // порождают chat_member-апдейт, который приходит обратно в этот же
    // хендлер — это и есть источник дублей "restricted → restricted" в логах.
    if (ctx.me && cm.from?.id === ctx.me.id) {
        return;
    }

    const chatId = cm.chat.id;
    const bigChat = BigInt(chatId);
    const newStatus = cm.new_chat_member.status;
    const oldStatus = cm.old_chat_member.status;
    const userId = cm.new_chat_member.user?.id;
    if (userId == null) return;
    const bigUser = BigInt(userId);

    // --- Выход / удаление пользователя -------------------------------
    // Если у пользователя была активна капча — отменяем её сразу: чистим
    // Redis-состояние и удаляем сообщение с картинкой из чата, вместо
    // того чтобы ждать таймаута и/или оставлять картинку висеть навсегда.
    const isLeaving = newStatus === "left" || newStatus === "kicked";
    if (isLeaving) {
        const state = await getCaptchaState(bigChat, bigUser);
        if (state) {
            await clearCaptchaState(bigChat, bigUser);
            await deleteCaptchaMessage(ctx.api, chatId, state.messageId);
            logger.info(
                { chatId, userId },
                "captcha cancelled: user left/kicked before solving",
            );
        }
        await setMembershipStatus(bigChat, bigUser, MemberStatus.PENDING).catch(
            () => {},
        );
        return;
    }

    const isPresent =
        newStatus === "member" ||
        newStatus === "administrator" ||
        newStatus === "restricted";
    if (!isPresent) return;

    // Классический вход: old был left/kicked. Дополнительно допускаем
    // old === new — так Telegram репортит пользователей, залипших
    // в ограничении с прошлых багов; такие тоже должны пройти капчу заново,
    // если сейчас они не VERIFIED и капча не идёт прямо сейчас.
    const looksLikeFreshJoin = oldStatus === "left" || oldStatus === "kicked";

    // Дедуп-лок на 5 сек — Telegram может продублировать апдейт, а без лока
    // это привело бы к двойному restrict + двойной капче на один вход.
    const lockKey = `chatmember:lock:${chatId}:${userId}`;
    const acquired = await redis.set(lockKey, "1", "EX", 5, "NX");
    if (!acquired) return;

    if (!looksLikeFreshJoin) {
        const [existingCaptcha, existingMembership] = await Promise.all([
            getCaptchaState(bigChat, bigUser),
            prisma.chatMembership.findUnique({
                where: { chatId_userId: { chatId: bigChat, userId: bigUser } },
            }),
        ]);
        const alreadyHandled =
            existingCaptcha != null ||
            existingMembership?.status === MemberStatus.VERIFIED;
        if (alreadyHandled) return;
        // иначе — считаем это "залипшим" пользователем без активной верификации
        // и всё равно прогоняем через капчу заново
    }

    const user = cm.new_chat_member.user;
    const fullName =
        [user.first_name, user.last_name].filter(Boolean).join(" ") ||
        user.username ||
        "новый участник";

    await prisma.chat
        .upsert({
            where: { id: bigChat },
            create: { id: bigChat, title: cm.chat.title ?? null },
            update: { title: cm.chat.title ?? undefined },
        })
        .catch((err) => logger.warn({ err, chatId }, "chat upsert failed"));

    await setMembershipStatus(bigChat, bigUser, MemberStatus.PENDING).catch(
        () => {},
    );
    // Сбрасываем счётчик попыток капчи для нового входа. Без этого он копится
    // между заходами (старый kickUser позволял перезайти), и пользователь мог
    // получить бан с первого же клика, потому что попытки были израсходованы
    // ещё в прошлых заходах.
    await prisma.chatMembership
        .update({
            where: { chatId_userId: { chatId: bigChat, userId: bigUser } },
            data: { captchaAttempts: 0 },
        })
        .catch(() => {});

    const flag = await getFlag(bigUser).catch(() => null);
    if (
        flag?.status === FlagStatus.GLOBAL_BANNED ||
        flag?.status === FlagStatus.BOT_DETECT
    ) {
        await kickUser(ctx.api, chatId, userId);
        logger.info(
            { chatId, userId, flag: flag.status },
            "kicked user on join due to global flag",
        );
        return;
    }

    const chat = await prisma.chat.findUnique({ where: { id: bigChat } });
    const captchaEnabled = chat?.captchaEnabled ?? true;

    if (flag?.status === FlagStatus.SUSPECT) {
        logger.info(
            { chatId, userId },
            "SUSPECT user joined — captcha enforced",
        );
    }

    if (!captchaEnabled) {
        await setMembershipStatus(
            bigChat,
            bigUser,
            MemberStatus.VERIFIED,
        ).catch(() => {});
        return;
    }

    await restrictForCaptcha(ctx.api, chatId, userId).catch((err) =>
        logger.warn({ err, chatId, userId }, "restrictForCaptcha failed"),
    );

    const timeoutSec =
        chat?.captchaTimeoutSec ?? config.CAPTCHA_TIMEOUT_SEC ?? 90;

    // Для форумов (супергрупп с топиками) вступление в чат не привязано
    // к конкретной теме — Telegram не сообщает message_thread_id в
    // chat_member апдейте. Поэтому используем явно настроенный админом
    // топик для капч (chat.captchaTopicId), а если он не задан —
    // отправляем без message_thread_id (уйдёт в General; если General
    // закрыт в форуме без назначенного топика, Telegram вернёт ошибку,
    // которую мы логируем через .catch ниже, не роняя обработчик).
    const threadId = chat?.captchaTopicId ?? undefined;

    await sendCaptchaWithTimeout(
            ctx.api,
            chatId,
            userId,
            timeoutSec,
            fullName,
            threadId,
        ).catch((err) => {
            logger.error({ err, chatId, userId }, "failed to send captcha");
        });

    void statusLabel;
}
