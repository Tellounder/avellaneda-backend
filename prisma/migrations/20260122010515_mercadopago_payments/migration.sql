-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "paymentPreferenceId" TEXT,
ADD COLUMN     "paymentProvider" TEXT,
ADD COLUMN     "paymentRef" TEXT,
ADD COLUMN     "paymentStatus" TEXT;
