import type { Api, InputFile } from "grammy";
import { prisma, MemberStatus } from "../db";
import { redis } from "../redis";
import { config } from "../config";
import { logger } from "../logger";
import { generateImageCaptcha } from "./captcha-image";

/**
 * Captcha flow on new-member join — v2, hardened against:
 *  1) скриптовых ботов, решающих капчу string-match'ем текста кнопки
 *     с текстом вопроса (см. разбор в captcha-image.ts)
 *  2) мгновенных ответов (человек физически не жмёт кнопку за <600мс)
 *  3) бесконечных ретраев через join→fail→kick→rejoin
 *
 * v2.1: капча теперь явно обращается к вошедшему пользователю (mention),
 * подчищает за собой сообщения в чате и умеет писать в конкретный топик
 * форума (message_thread_id), а не только в General.
 *
 * v2.2: устранён баг "нажал верную кнопку — всё равно забанен".
 * Причина была в том, что таймаут капчи ставился ОДИН РАЗ при первом
 * входе (setTimeout в onChatMember.ts) и не был привязан к конкретному
 * сообщению. Когда капча перевыпускалась после неверного ответа (новая
 * картинка, новый correctIndex, новый messageId в Redis), для НЕЁ новый
 * таймер не создавался — оставался только исходный, "осиротевший".
 * Он срабатывал по расписанию первой капчи, видел в Redis состояние
 * УЖЕ ДРУГОЙ (перевыпущенной) капчи и, не зная об этом, стирал его и
 * слал третью капчу / банил. Если пользователь в этот момент кликал по
 * кнопке под второй (актуальной) картинкой, его ответ сверялся с
 * correctIndex третьей — почти всегда "неверно" → бан, хотя визуально
 * клик был правильным.
 *
 * Фикс: единая точка входа sendCaptchaWithTimeout() — она же отправляет
 * капчу, она же планирует таймер, который перед любым действием сверяет
 * state.messageId с тем messageId, за которым он "следит". Если они не
 * совпадают — капча уже неактуальна для этого таймера, и он просто
 * молча завершается, не трогая чужое активное состояние.
 *
 * Это НЕ защита от продвинутого vision-LLM бота, который реально
 * "смотрит" картинку и рассуждает с человекоподобной задержкой —
 * такого не существует в природе полностью надёжных решений.
 * Цель — поднять порог входа так, чтобы отсеять массовый / дешёвый
 * спам, а не единичного целевого атакующего.
 */

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

const RESTRICTED_PERMISSIONS = {
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

/** Минимальное правдоподобное время реакции человека на новый визуальный стимул. */
const MIN_HUMAN_RESPONSE_MS = 600;

/**
 * После скольких провалов — постоянный бан вместо разрешения ретрая.
 * 2 = одна ошибка (в т.ч. мисклик) прощается новой капчей, вторая — бан.
 */
const MAX_CAPTCHA_ATTEMPTS = config.CAPTCHA_MAX_ATTEMPTS ?? 2;

function captchaKey(chatId: bigint, userId: bigint): string {
    return `captcha:${chatId.toString()}:${userId.toString()}`;
}

function suspiciousKey(chatId: bigint, userId: bigint): string {
    return `captcha:suspicious:${chatId.toString()}:${userId.toString()}`;
}

export interface CaptchaState {
    /** индекс правильной кнопки среди optionLabels */
    correctIndex: number;
    optionLabels: string[];
    messageId: number;
    /** id топика форума, куда было отправлено сообщение (если применимо) */
    threadId?: number;
    startedAt: number;
}

/** callback_data кодирует только позицию, никогда — правильность или текст задания */
export const CAPTCHA_CB_PREFIX = "cap:";
export function buttonCallbackData(slot: number): string {
    return `${CAPTCHA_CB_PREFIX}${slot}`;
}
export function parseCallbackSlot(data: string): number | null {
    if (!data.startsWith(CAPTCHA_CB_PREFIX)) return null;
    const n = Number(data.slice(CAPTCHA_CB_PREFIX.length));
    return Number.isInteger(n) ? n : null;
}

export async function restrictForCaptcha(
    api: Api,
    chatId: number,
    userId: number,
): Promise<void> {
    await api.restrictChatMember(chatId, userId, RESTRICTED_PERMISSIONS, {
        use_independent_chat_permissions: true,
    });
}

export async function restorePermissions(
    api: Api,
    chatId: number,
    userId: number,
): Promise<void> {
    await api.restrictChatMember(chatId, userId, FULL_PERMISSIONS, {
        use_independent_chat_permissions: true,
    });
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Отправляет картиночную капчу и сохраняет состояние в Redis.
 * Кнопки подписаны нейтральными буквами — их текст никак не связан
 * текстово с promptText, так что апдейт, отданный Telegram (message + markup),
 * не содержит ответа в машиночитаемом виде.
 *
 * Возвращает message_id отправленного сообщения — вызывающий код
 * (sendCaptchaWithTimeout) использует его, чтобы привязать к этой
 * конкретной капче свой таймер.
 *
 * ВАЖНО: эта функция сама по себе НЕ планирует таймаут. Если нужен
 * таймаут (а он нужен почти всегда) — используйте sendCaptchaWithTimeout.
 * Голый sendCaptcha оставлен экспортированным на случай точечных
 * сценариев (например, ручной re-send без изменения существующего
 * таймера), но в обычном flow не должен вызываться напрямую.
 *
 * @param displayName имя вошедшего пользователя для явного обращения в подписи
 * @param threadId    id топика форума (message_thread_id), если чат — форум
 *                     и настроен конкретный топик для капч; иначе сообщение
 *                     уйдёт в дефолтный поток (General)
 */
export async function sendCaptcha(
    api: Api,
    chatId: number,
    userId: number,
    timeoutSec: number,
    displayName: string,
    threadId?: number,
): Promise<number> {
    const { imageBuffer, promptText, correctIndex, optionLabels } =
        generateImageCaptcha();

    const keyboard = {
        inline_keyboard: [
            optionLabels.map((label, slot) => ({
                text: label,
                callback_data: buttonCallbackData(slot),
            })),
        ],
    };

    const mention = `<a href="tg://user?id=${userId}">${escapeHtml(displayName)}</a>`;

    const { InputFile: IF } = await import("grammy");
    const sent = await api.sendPhoto(
        chatId,
        new IF(imageBuffer, "captcha.png"),
        {
            caption: `👋 ${mention}, ${promptText}\n\nУ вас есть ${timeoutSec} сек., иначе вы будете исключены из группы.`,
            parse_mode: "HTML",
            reply_markup: keyboard,
            message_thread_id: threadId,
        },
    );

    await redis.set(
        captchaKey(BigInt(chatId), BigInt(userId)),
        JSON.stringify({
            correctIndex,
            optionLabels,
            messageId: sent.message_id,
            threadId,
            startedAt: Date.now(),
        } satisfies CaptchaState),
        "EX",
        Math.max(30, timeoutSec + 10),
    );

    return sent.message_id;
}

/**
 * Единая точка входа для отправки капчи. Используйте ЭТУ функцию
 * везде — при первом входе, при ретрае после неверного ответа и при
 * ретрае после таймаута. Она гарантирует, что у каждой отправленной
 * капчи есть ровно один "живой" таймер, привязанный к её messageId.
 */
export async function sendCaptchaWithTimeout(
    api: Api,
    chatId: number,
    userId: number,
    timeoutSec: number,
    displayName: string,
    threadId?: number,
): Promise<void> {
    const messageId = await sendCaptcha(
        api,
        chatId,
        userId,
        timeoutSec,
        displayName,
        threadId,
    );
    scheduleCaptchaTimeout(
        api,
        chatId,
        userId,
        messageId,
        timeoutSec,
        displayName,
        threadId,
    );
}

/**
 * Планирует проверку по истечении timeoutSec для КОНКРЕТНОГО messageId.
 * Если к моменту срабатывания в Redis лежит состояние другого сообщения
 * (капча уже была перевыпущена — неверный ответ или более ранний
 * таймер), таймер молча завершается, ничего не трогая. Это делает
 * функцию безопасной даже при гонках между несколькими таймерами одного
 * пользователя.
 */
function scheduleCaptchaTimeout(
    api: Api,
    chatId: number,
    userId: number,
    watchedMessageId: number,
    timeoutSec: number,
    displayName: string,
    threadId?: number,
): void {
    setTimeout(async () => {
        const bigChat = BigInt(chatId);
        const bigUser = BigInt(userId);
        const state = await getCaptchaState(bigChat, bigUser);
        if (!state) return; // уже решена или отменена (пользователь вышел и т.п.)

        if (state.messageId !== watchedMessageId) {
            // Капча уже перевыпущена под другим сообщением — этот таймер
            // "устарел" и не имеет права трогать чужое активное состояние.
            logger.debug(
                { chatId, userId, watchedMessageId, actual: state.messageId },
                "stale captcha timeout ignored (captcha already reissued)",
            );
            return;
        }

        const attempts = await bumpCaptchaAttempts(bigChat, bigUser);
        await clearCaptchaState(bigChat, bigUser);
        await deleteCaptchaMessage(api, chatId, state.messageId);

        if (attempts >= MAX_CAPTCHA_ATTEMPTS) {
            await banPermanently(api, chatId, userId);
            logger.info(
                { chatId, userId, attempts },
                "banned after captcha timeout & max attempts",
            );
            return;
        }

        await restrictForCaptcha(api, chatId, userId).catch(() => {});
        await sendCaptchaWithTimeout(
            api,
            chatId,
            userId,
            timeoutSec,
            displayName,
            threadId,
        ).catch((err) => {
            logger.error({ err, chatId, userId }, "failed to resend captcha");
        });
    }, timeoutSec * 1000);
}

export async function getCaptchaState(
    chatId: bigint,
    userId: bigint,
): Promise<CaptchaState | null> {
    const raw = await redis.get(captchaKey(chatId, userId));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as CaptchaState;
    } catch {
        return null;
    }
}

export async function clearCaptchaState(
    chatId: bigint,
    userId: bigint,
): Promise<void> {
    await redis.del(captchaKey(chatId, userId));
}

/**
 * Удаляет капча-сообщение из чата, чтобы не засорять его картинками,
 * которые уже не актуальны (решено / истекло / пользователь вышел).
 * Молча проглатывает ошибку — сообщение могло быть уже удалено вручную
 * администратором или самим Telegram (например, после бана автора).
 */
export async function deleteCaptchaMessage(
    api: Api,
    chatId: number,
    messageId: number | undefined,
): Promise<void> {
    if (!messageId) return;
    await api.deleteMessage(chatId, messageId).catch((err) => {
        logger.debug(
            { err, chatId, messageId },
            "deleteCaptchaMessage: not critical, message likely gone already",
        );
    });
}

/**
 * Планирует отложенное удаление сообщения бота из чата.
 * Молча проглатывает ошибки — сообщение могло быть уже удалено.
 * Используется для самоочистки: капча, модерационные анонсы, уведомления.
 */
export function scheduleSelfDestruct(
    api: Api,
    chatId: number,
    messageId: number,
    delaySec: number,
): void {
    setTimeout(async () => {
        try {
            await api.deleteMessage(chatId, messageId);
        } catch {
            // not critical — message may already be gone
        }
    }, delaySec * 1000);
}

export interface CaptchaVerdict {
    correct: boolean;
    /** true если ответ пришёл подозрительно быстро для только что показанной картинки */
    suspiciouslyFast: boolean;
}

/** Проверяет ответ пользователя, включая тайминг-эвристику. */
export function evaluateCaptchaAnswer(
    state: CaptchaState,
    chosenSlot: number,
): CaptchaVerdict {
    const elapsed = Date.now() - state.startedAt;
    return {
        correct: chosenSlot === state.correctIndex,
        suspiciouslyFast: elapsed < MIN_HUMAN_RESPONSE_MS,
    };
}

/** Копим сигнал "подозрительно быстрый ответ" отдельно от факта провала капчи. */
export async function flagSuspiciousTiming(
    chatId: bigint,
    userId: bigint,
): Promise<number> {
    const key = suspiciousKey(chatId, userId);
    const n = await redis.incr(key);
    await redis.expire(key, 60 * 60 * 24); // сутки
    if (n === 1) {
        logger.info(
            { chatId: chatId.toString(), userId: userId.toString() },
            "captcha: suspiciously fast answer",
        );
    }
    return n;
}

/**
 * Кик = ban + unban, оставляет возможность повторного входа.
 * Используем ТОЛЬКО для первых провалов — см. banPermanently для последних.
 */
export async function kickUser(
    api: Api,
    chatId: number,
    userId: number,
): Promise<void> {
    try {
        await api.banChatMember(chatId, userId);
        await api.unbanChatMember(chatId, userId);
    } catch (err) {
        logger.warn({ err, chatId, userId }, "kickUser: ban/unban failed");
    }
}

/**
 * Настоящий бан без анбана — применяется после MAX_CAPTCHA_ATTEMPTS.
 * В отличие от kickUser, не даёт бесконечно ретраить join→fail→rejoin.
 */
export async function banPermanently(
    api: Api,
    chatId: number,
    userId: number,
): Promise<void> {
    try {
        await api.banChatMember(chatId, userId);
    } catch (err) {
        logger.warn({ err, chatId, userId }, "banPermanently failed");
    }
}

export async function setMembershipStatus(
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

export async function bumpCaptchaAttempts(
    chatId: bigint,
    userId: bigint,
): Promise<number> {
    const m = await prisma.chatMembership.upsert({
        where: { chatId_userId: { chatId, userId } },
        create: { chatId, userId, captchaAttempts: 1 },
        update: { captchaAttempts: { increment: 1 } },
    });
    return m.captchaAttempts;
}

export { MemberStatus, MAX_CAPTCHA_ATTEMPTS };
