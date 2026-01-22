-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('ACTIVE', 'CANCELED', 'SENT');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "Agenda" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "notifyAt" TIMESTAMP(3),
ADD COLUMN     "status" "ReminderStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "payload" JSONB,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED';
