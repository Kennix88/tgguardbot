-- AlterTable: moderation feedback fields (admin confirm / revert)
ALTER TABLE "ModerationLog" ADD COLUMN "confirmed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ModerationLog" ADD COLUMN "reverted"  BOOLEAN NOT NULL DEFAULT false;
