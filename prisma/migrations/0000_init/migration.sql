-- CreateEnum
CREATE TYPE "LinkMode" AS ENUM ('ALLOW', 'WHITELIST_ONLY', 'DELETE_ALL');

-- CreateEnum
CREATE TYPE "WhitelistType" AS ENUM ('DOMAIN', 'WORD');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('SUSPECT', 'BOT_DETECT', 'GLOBAL_BANNED');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('PENDING', 'VERIFIED', 'RESTRICTED', 'BANNED');

-- CreateTable
CREATE TABLE "Chat" (
    "id" BIGINT NOT NULL,
    "title" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionActive" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionExpiresAt" TIMESTAMP(3),
    "linkMode" "LinkMode" NOT NULL DEFAULT 'DELETE_ALL',
    "captchaEnabled" BOOLEAN NOT NULL DEFAULT true,
    "captchaTimeoutSec" INTEGER NOT NULL DEFAULT 90,
    "muteInsteadOfBan" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BanWord" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "pattern" TEXT NOT NULL,
    "isRegex" BOOLEAN NOT NULL DEFAULT false,
    "addedBy" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BanWord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhitelistEntry" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "type" "WhitelistType" NOT NULL,
    "value" TEXT NOT NULL,
    "addedBy" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhitelistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalUserFlag" (
    "userId" BIGINT NOT NULL,
    "status" "FlagStatus" NOT NULL DEFAULT 'SUSPECT',
    "reason" TEXT,
    "reportedFrom" BIGINT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalUserFlag_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ChatMembership" (
    "chatId" BIGINT NOT NULL,
    "userId" BIGINT NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'PENDING',
    "captchaAttempts" INTEGER NOT NULL DEFAULT 0,
    "warnCount" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMembership_pkey" PRIMARY KEY ("chatId","userId")
);

-- CreateTable
CREATE TABLE "ModerationLog" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "userId" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "score" INTEGER,
    "text" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BanWord_chatId_pattern_key" ON "BanWord"("chatId", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "WhitelistEntry_chatId_type_value_key" ON "WhitelistEntry"("chatId", "type", "value");

-- CreateIndex
CREATE INDEX "ModerationLog_chatId_createdAt_idx" ON "ModerationLog"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationLog_userId_idx" ON "ModerationLog"("userId");

-- AddForeignKey
ALTER TABLE "BanWord" ADD CONSTRAINT "BanWord_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhitelistEntry" ADD CONSTRAINT "WhitelistEntry_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMembership" ADD CONSTRAINT "ChatMembership_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationLog" ADD CONSTRAINT "ModerationLog_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

