-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "NotificationType" AS ENUM ('SYSTEM', 'REMINDER', 'PURCHASE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "type" "NotificationType" NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "Notification" ADD COLUMN "refId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "notifyAt" TIMESTAMP(3);
