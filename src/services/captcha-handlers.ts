import type { Bot, Context } from "grammy";
import { logger } from "../logger";
import { config } from "../config";
import {
    restorePermissions,
    sendCaptchaWithTimeout,
    getCaptchaState,
    clearCaptchaState,
    deleteCaptchaMessage,
    evaluateCaptchaAnswer,
    flagSuspiciousTiming,
    banPermanently,
    setMembershipStatus,
    bumpCaptchaAttempts,
    parseCallbackSlot,
    MemberStatus,
    MAX_CAPTCHA_ATTEMPTS,
} from "./captchaService";

/**
 * ВАЖНО: этот модуль больше НЕ регистрирует свой bot.on("chat_member", ...).
 *
 * Раньше здесь был второй, независимый обработчик входа участников,
 * который параллельно с onChatMember.ts вызывал restrictForCaptcha +
 * sendCaptcha на один и тот же join. Оба обработчика писали своё
 * состояние капчи в один и тот же ключ Redis (captcha:{chatId}:{userId}),
 * поэтому пользователь видел картинку от первого вызова, а к моменту
 * клика по кнопке в Redis уже лежал correctIndex от второго вызова,
 * перезаписавшего капчу. Внешне это выглядело как "кнопка не совпадает
 * с нарисованной фигурой" — на деле кнопка была верна для другой,
 * никогда не показанной пользователю картинки.
 *
 * Единственный источник обработки входа — onChatMember.ts. Он же
 * отвечает за CAS-проверку (см. isKnownSpammer), восстановление
 * ограничений, тайминги и капчу. Здесь остаётся только обработка
 * нажатия на кнопку капчи.
 */
export function registerCaptchaHandlers(bot: Bot): void {
    bot.on("callback_query:data", async (ctx: Context) => {
        const slot = parseCallbackSlot(ctx.callbackQuery!.data!);
        if (slot === null) return;

        const chatId = BigInt(ctx.chat!.id);
        const userId = BigInt(ctx.from!.id);
        const state = await getCaptchaState(chatId, userId);

        if (!state) {
            await ctx.answerCallbackQuery({
                text: "Капча уже неактуальна.",
                show_alert: true,
            });
            return;
        }

        const verdict = evaluateCaptchaAnswer(state, slot);
        if (verdict.suspiciouslyFast) {
            await flagSuspiciousTiming(chatId, userId);
        }

        if (!verdict.correct) {
            const attempts = await bumpCaptchaAttempts(chatId, userId);
            await clearCaptchaState(chatId, userId);
            await deleteCaptchaMessage(
                ctx.api,
                Number(chatId),
                state.messageId,
            );

            if (attempts >= MAX_CAPTCHA_ATTEMPTS) {
                await banPermanently(ctx.api, Number(chatId), Number(userId));
                await ctx.answerCallbackQuery({
                    text: "Неверно. Превышено число попыток — доступ закрыт.",
                    show_alert: true,
                });
                logger.info(
                    {
                        chatId: chatId.toString(),
                        userId: userId.toString(),
                        attempts,
                    },
                    "banned: max captcha attempts",
                );
                return;
            }

            // не мгновенный кик — даём ещё одну картинку сразу же
            await ctx.answerCallbackQuery({
                text: "Неверно, попробуйте ещё раз.",
                show_alert: true,
            });

            const displayName =
                [ctx.from?.first_name, ctx.from?.last_name]
                    .filter(Boolean)
                    .join(" ") ||
                ctx.from?.username ||
                "участник";

            await sendCaptchaWithTimeout(
                           ctx.api,
                           Number(chatId),
                           Number(userId),
                           config.CAPTCHA_TIMEOUT_SEC,
                           displayName,
                           state.threadId,
                       );
            return;
        }

        // Верно — чистим и состояние, и само сообщение с картинкой,
        // чтобы не оставлять решённые капчи висеть в чате.
        await restorePermissions(ctx.api, Number(chatId), Number(userId));
        await clearCaptchaState(chatId, userId);
        await deleteCaptchaMessage(ctx.api, Number(chatId), state.messageId);
        await setMembershipStatus(chatId, userId, MemberStatus.VERIFIED);
        await ctx.answerCallbackQuery({ text: "✅ Добро пожаловать!" });
    });
}

/**
 * Вызывается из cron/scheduler по истечении timeoutSec, если captcha state
 * всё ещё существует в Redis (пользователь не ответил вовсе).
 *
 * Примечание: основной путь таймаута теперь обрабатывается напрямую
 * через scheduleTimeout() в onChatMember.ts (setTimeout при отправке
 * капчи). Эта функция остаётся как отдельная точка входа на случай,
 * если у вас есть внешний cron/scheduler, который дергает истечение
 * капч по расписанию независимо от onChatMember.ts — в таком случае
 * она тоже подчищает сообщение, а не только кикает пользователя.
 */
export async function expireCaptcha(
    bot: Bot,
    chatId: number,
    userId: number,
): Promise<void> {
    const state = await getCaptchaState(BigInt(chatId), BigInt(userId));
    if (!state) return; // уже решена или отменена
    await clearCaptchaState(BigInt(chatId), BigInt(userId));
    await deleteCaptchaMessage(bot.api, chatId, state.messageId);
    await banPermanently(bot.api, chatId, userId);
}
