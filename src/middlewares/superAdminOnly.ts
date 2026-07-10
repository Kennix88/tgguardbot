import type { Context, NextFunction } from "grammy";
import { config } from "../config";

declare module "grammy" {
  interface Context {
    /** true if the sender is one of the SUPER_ADMIN_IDS. */
    isSuperAdmin?: boolean;
  }
}

/** Resolve whether the sender is a configured super-admin (owner). */
export async function resolveSuperAdmin(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  ctx.isSuperAdmin = !!ctx.from && config.SUPER_ADMIN_IDS.includes(ctx.from.id);
  return next();
}

/**
 * Guard: only super-admins proceed. Super-admin commands are restricted to
 * DMs with the bot (private chat) per the spec.
 */
export async function superAdminOnly(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const inDm = ctx.chat?.type === "private";
  if (!ctx.isSuperAdmin) {
    // Silently ignore non-superadmins to avoid leaking command surface.
    return;
  }
  if (!inDm) {
    await ctx.reply?.(
      "ℹ️ Команды супер-админа доступны только в личных сообщениях с ботом.",
    );
    return;
  }
  return next();
}
