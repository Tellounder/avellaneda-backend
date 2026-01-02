-- CreateEnum
CREATE TYPE "LiveScheduleAction" AS ENUM ('CREATE', 'EDIT', 'CANCEL', 'AUTO_REPROGRAM', 'SET_PENDING_REPROGRAM', 'ADMIN_OVERRIDE', 'AUTO_START', 'AUTO_FINISH');

-- CreateEnum
CREATE TYPE "AuditEntityType" AS ENUM ('SHOP', 'LIVE', 'REEL', 'PURCHASE', 'SUSPENSION', 'NOTIFICATION');

-- CreateTable
CREATE TABLE "AgendaSuspension" (
    "suspensionId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgendaSuspension_pkey" PRIMARY KEY ("suspensionId")
);

-- CreateTable
CREATE TABLE "LiveScheduleEvent" (
    "eventId" TEXT NOT NULL,
    "liveId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "action" "LiveScheduleAction" NOT NULL,
    "fromScheduledAt" TIMESTAMP(3),
    "toScheduledAt" TIMESTAMP(3),
    "reason" TEXT,
    "actorType" "QuotaActorType" NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveScheduleEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "auditId" TEXT NOT NULL,
    "actorType" "QuotaActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" "AuditEntityType" NOT NULL,
    "entityId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("auditId")
);

-- AddForeignKey
ALTER TABLE "AgendaSuspension" ADD CONSTRAINT "AgendaSuspension_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgendaSuspension" ADD CONSTRAINT "AgendaSuspension_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "Admin"("authUserId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveScheduleEvent" ADD CONSTRAINT "LiveScheduleEvent_liveId_fkey" FOREIGN KEY ("liveId") REFERENCES "Stream"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveScheduleEvent" ADD CONSTRAINT "LiveScheduleEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

