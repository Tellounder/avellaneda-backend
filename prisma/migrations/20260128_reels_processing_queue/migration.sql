-- Add PROCESSING status and processingJobId for reels
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'ReelStatus' AND e.enumlabel = 'PROCESSING'
  ) THEN
    ALTER TYPE "ReelStatus" ADD VALUE 'PROCESSING';
  END IF;
END $$;

ALTER TABLE "Reel" ADD COLUMN IF NOT EXISTS "processingJobId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Reel_processingJobId_key'
  ) THEN
    CREATE UNIQUE INDEX "Reel_processingJobId_key" ON "Reel"("processingJobId");
  END IF;
END $$;
