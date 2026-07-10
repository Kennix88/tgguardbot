# antispam-bot

Self-hosted Telegram-бот для модерации групповых чатов: капча для новых
участников, фильтрация ссылок и запрещённых слов (per-chat), глобальный
список подозрительных/забаненных пользователей, единый для всех чатов.
Управление — командами внутри чата; доступ к боту в новых чатах
контролирует супер-админ.

MVP реализован по ТЗ: TypeScript + grammY + Prisma + PostgreSQL + Redis,
деплой одним `docker-compose` через long polling (без вебхука и домена).

## Возможности

- **Капча при входе** (§6): рандомизированная inline-клавиатура, таймаут,
  кик при превышении попыток. Работает всегда, вне зависимости от лимитов.
- **Модерация сообщений** (§7): пропуск админов, глобальные флаги, фильтр
  ссылок (ALLOW/WHITELIST_ONLY/DELETE_ALL), бан-слова (текст и regex),
  эскалация по варнам (3 → мут на час, 5 → мут/бан).
- **Глобальный бан-лист** (§7.2): SUSPECT / BOT_DETECT / GLOBAL_BANNED.
- **Тарификация** (§4): PENDING / FREE / APPROVED / SUBSCRIBED с лимитами
  по числу пользователей и сообщений в час для FREE.
- **Заготовки** (§8, §9): интерфейс LLM-модератора с Noop-реализацией,
  поля подписки и ручная команда `/grantsub`.

## Стек

| Компонент | Технология |
|---|---|
| Язык | TypeScript, Node.js 20 |
| Bot framework | grammY |
| ORM | Prisma |
| БД | PostgreSQL 16 |
| Кэш/состояние | Redis 7 |
| Логирование | pino |
| Валидация env | zod |

## Структура

```
antispam-bot/
  docker-compose.yml
  Dockerfile
  docker-entrypoint.sh
  package.json
  tsconfig.json
  .env.example
  prisma/schema.prisma
  src/
    index.ts
    config.ts          # zod-валидация env
    db.ts              # Prisma client
    redis.ts           # ioredis client
    logger.ts          # pino
    utils/patterns.ts  # regex-паттерны спама
    middlewares/
      chatAccess.ts    # tier + лимиты
      adminOnly.ts     # проверка админа (кэш 5 мин)
      superAdminOnly.ts
    services/
      captchaService.ts
      moderationService.ts  # pipeline §7
      globalListService.ts
      rateLimiter.ts
      subscriptionService.ts
      llm/llmModerator.ts   # интерфейс + Noop
    handlers/
      onChatMember.ts       # вход участника → капча
      onMyChatMember.ts     # бот добавлен → PENDING + уведомление
      onMessage.ts          # модерация сообщений
      commands/
        adminCommands.ts
        superAdminCommands.ts
```

## Запуск

### 1. Подготовка

```bash
cp .env.example .env
# отредактируйте .env:
#   BOT_TOKEN          — токен от @BotFather
#   SUPER_ADMIN_IDS    — ваш Telegram ID (через запятую)
#   DATABASE_URL/REDIS_URL уже настроены под docker-compose
```

### 2. Сборка и запуск через Docker

```bash
docker compose up -d --build
docker compose logs -f bot
```

При старте контейнера `bot` автоматически выполняется
`prisma migrate deploy`, затем запускается `node dist/index.js`.

### 3. Локальная разработка (без Docker)

```bash
npm install
npm run db:migrate     # создать локальную БД
npm run dev            # ts-node src/index.ts
```

Нужны локальные PostgreSQL и Redis (пропишите их в `.env`).

## Команды

### Админ чата (внутри чата)

| Команда | Действие |
|---|---|
| `/banword <слово или /regex/>` | добавить бан-слово/паттерн |
| `/unbanword <слово>` | удалить бан-слово |
| `/banwords` | список бан-слов чата |
| `/whitelist domain <example.com>` | добавить домен в whitelist |
| `/whitelist word <слово>` | добавить слово-исключение |
| `/unwhitelist <значение>` | удалить из whitelist |
| `/whitelistlist` | список whitelist |
| `/linkmode allow\|whitelist\|delete` | режим ссылок |
| `/captcha on\|off` | вкл/выкл капчу |
| `/muteinsteadofban on\|off` | эскалация мутом вместо бана |
| `/warns @user` (или ответом) | варны пользователя |
| `/unban @user` (или ответом) | снять RESTRICTED |
| `/stats` | статистика модерации за 24ч |
| `/subscribe` | заглушка — «оплата скоро» |

### Супер-админ (в личке с ботом)

| Команда | Действие |
|---|---|
| `/pendingchats` | список ожидающих чатов |
| `/approve <chatId>` | выдать полный доступ |
| `/revoke <chatId>` | отозвать доступ (FREE-лимиты) |
| `/grantsub <chatId> <days>` | выдать подписку (тест потока) |
| `/globalflag <userId> suspect\|bot_detect\|ban` | глобальный флаг |
| `/help` | справка |

Одобрить/отклонить новый чат можно также inline-кнопками из личного
сообщения, которое бот присылает супер-админам при добавлении в группу.

## Модель доступа (§4)

- **PENDING** — бот только добавлен, ждёт одобрения. Работает капча.
- **FREE** — не одобрен, без подписки: лимиты `FREE_TIER_MAX_USERS` и
  `FREE_TIER_MAX_MSGS_PER_HOUR`. После исчерпания — активная модерация
  приостанавливается до конца часа (капча продолжает работать).
- **APPROVED** — супер-админ выдал полный бесплатный доступ.
- **SUBSCRIBED** — подписка активна до `subscriptionExpiresAt`.

Полный доступ = `approved == true OR (subscriptionActive && subscriptionExpiresAt > now)`.

## Заготовки (MVP)

- **LLM-модерация** (§8): интерфейс `LlmModerator` и `NoopLlmModerator`
  в `src/services/llm/llmModerator.ts`. Включается через `LLM_ENABLED`
  (по умолчанию `false`). Точка интеграции — «серая зона» между проверкой
  бан-слов и эскалацией варнов.
- **Telegram Stars** (§9): поля `subscriptionActive`/`subscriptionExpiresAt`
  в схеме; ручная активация `/grantsub`. Команда `/subscribe` отвечает
  заглушкой. Реальный `sendInvoice` с валютой `XTR` не реализован.

## Вне рамок MVP

- Реальный приём Stars-платежей.
- TMA/дашборд для настройки.
- Реальная LLM-классификация.
- Кастомизация регекс-паттернов через команды (правятся в
  `src/utils/patterns.ts`).
- Продажа API глобального бан-листа наружу.
