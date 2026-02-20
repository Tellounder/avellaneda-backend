-- Safety patch for staging/prod drift.
-- Some databases were created without Stream.views while code expects it.
ALTER TABLE "Stream"
ADD COLUMN IF NOT EXISTS "views" INTEGER NOT NULL DEFAULT 0;
