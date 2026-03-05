-- Add role-based auth fields
CREATE TYPE "AuthRole" AS ENUM ('UNDEFINED', 'USER', 'PENDING_STORE', 'STORE', 'ADMIN', 'SUPERADMIN');

ALTER TABLE "AuthUser"
  ADD COLUMN "firebaseUid" TEXT,
  ADD COLUMN "role" "AuthRole" NOT NULL DEFAULT 'UNDEFINED',
  ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AuthUser_firebaseUid_key" ON "AuthUser"("firebaseUid");
CREATE INDEX "AuthUser_role_idx" ON "AuthUser"("role");

-- Backfill roles from legacy userType/admin role
UPDATE "AuthUser" AS au
SET "role" = CASE
  WHEN au."userType" = 'ADMIN' AND (
    SELECT ad."role"
    FROM "Admin" ad
    WHERE ad."authUserId" = au."id"
    LIMIT 1
  ) = 'SUPERADMIN' THEN 'SUPERADMIN'::"AuthRole"
  WHEN au."userType" = 'ADMIN' THEN 'ADMIN'::"AuthRole"
  WHEN au."userType" = 'SHOP' THEN 'STORE'::"AuthRole"
  WHEN au."userType" = 'CLIENT' THEN 'USER'::"AuthRole"
  ELSE 'UNDEFINED'::"AuthRole"
END;

UPDATE "AuthUser"
SET "onboardingCompletedAt" = COALESCE("lastLoginAt", "createdAt")
WHERE "role" <> 'UNDEFINED' AND "onboardingCompletedAt" IS NULL;
