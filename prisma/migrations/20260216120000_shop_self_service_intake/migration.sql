-- Shop self-service intake fields for map-only DIMMED flow
CREATE TYPE "ShopRegistrationSource" AS ENUM ('ADMIN', 'SELF_SERVICE');
CREATE TYPE "ShopVisibilityState" AS ENUM ('LIT', 'DIMMED', 'HIDDEN');
CREATE TYPE "ShopVerificationState" AS ENUM ('VERIFIED', 'UNVERIFIED', 'REJECTED');
CREATE TYPE "ShopPlanTier" AS ENUM ('NONE', 'BASICO', 'MEDIA', 'MAXIMA');

ALTER TABLE "Shop"
  ADD COLUMN "planTier" "ShopPlanTier" NOT NULL DEFAULT 'BASICO',
  ADD COLUMN "registrationSource" "ShopRegistrationSource" NOT NULL DEFAULT 'ADMIN',
  ADD COLUMN "visibilityState" "ShopVisibilityState" NOT NULL DEFAULT 'LIT',
  ADD COLUMN "verificationState" "ShopVerificationState" NOT NULL DEFAULT 'VERIFIED',
  ADD COLUMN "contactsPublic" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "contactEmailPrivate" TEXT,
  ADD COLUMN "contactWhatsappPrivate" TEXT,
  ADD COLUMN "isGallery" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "galleryName" TEXT,
  ADD COLUMN "galleryLocal" TEXT,
  ADD COLUMN "galleryFloor" TEXT,
  ADD COLUMN "addressBase" TEXT,
  ADD COLUMN "addressDisplay" TEXT,
  ADD COLUMN "normalizedAddressBase" TEXT,
  ADD COLUMN "normalizedName" TEXT,
  ADD COLUMN "intakeMeta" JSONB;

CREATE INDEX "Shop_visibilityState_verificationState_idx" ON "Shop"("visibilityState", "verificationState");
CREATE INDEX "Shop_normalizedAddressBase_idx" ON "Shop"("normalizedAddressBase");
CREATE INDEX "Shop_normalizedName_idx" ON "Shop"("normalizedName");
