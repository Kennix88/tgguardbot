import { PrismaClient } from "@prisma/client";
import { config } from "./config";
import { logger } from "./logger";

/**
 * Single shared Prisma client.
 * Logs queries only at debug level.
 */
export const prisma = new PrismaClient({
  log: [
    { level: "error", emit: "event" },
    { level: "warn", emit: "event" },
  ],
});

prisma.$on("error", (e) => {
  logger.error({ err: e }, "prisma error");
});
prisma.$on("warn", (e) => {
  logger.warn({ msg: e.message }, "prisma warning");
});

export async function connectPrisma(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info("prisma connected");
  } catch (err) {
    logger.fatal({ err }, "failed to connect prisma");
    throw err;
  }
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

export type { Chat, BanWord, WhitelistEntry, GlobalUserFlag, ChatMembership, ModerationLog } from "@prisma/client";
export { LinkMode, WhitelistType, FlagStatus, MemberStatus } from "@prisma/client";
