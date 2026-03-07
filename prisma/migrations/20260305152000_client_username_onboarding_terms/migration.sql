ALTER TABLE "Client"
  ADD COLUMN "username" TEXT,
  ADD COLUMN "onboardingTermsAcceptedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Client_username_key" ON "Client"("username");
