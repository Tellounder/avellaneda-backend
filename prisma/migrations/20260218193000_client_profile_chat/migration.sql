-- Alter Client for progressive profile
ALTER TABLE "Client"
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "province" TEXT,
ADD COLUMN     "instagramHandle" TEXT,
ADD COLUMN     "birthDate" TIMESTAMP(3),
ADD COLUMN     "styleTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "profileCompletedAt" TIMESTAMP(3),
ADD COLUMN     "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Create enum types for chat
CREATE TYPE "ChatConversationStatus" AS ENUM ('OPEN', 'ARCHIVED', 'BLOCKED');
CREATE TYPE "ChatParticipantType" AS ENUM ('CLIENT', 'SHOP');
CREATE TYPE "ChatMessageSenderType" AS ENUM ('CLIENT', 'SHOP', 'SYSTEM');
CREATE TYPE "ChatMessageType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'SYSTEM');

-- Create chat tables
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "clientAuthUserId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "status" "ChatConversationStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessagePreview" TEXT,
    "firstClientMessageAt" TIMESTAMP(3),
    "lastClientMessageAt" TIMESTAMP(3),
    "lastShopMessageAt" TIMESTAMP(3),
    "firstShopResponseAt" TIMESTAMP(3),
    "firstResponseSeconds" INTEGER,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderType" "ChatMessageSenderType" NOT NULL,
    "senderAuthUserId" TEXT,
    "messageType" "ChatMessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT,
    "attachments" JSONB,
    "readAt" TIMESTAMP(3),
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatConversationRead" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "participantType" "ChatParticipantType" NOT NULL,
    "participantAuthUserId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatConversationRead_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "ChatConversation_clientAuthUserId_shopId_key" ON "ChatConversation"("clientAuthUserId", "shopId");
CREATE UNIQUE INDEX "ChatConversationRead_conversationId_participantType_key" ON "ChatConversationRead"("conversationId", "participantType");

-- Indexes
CREATE INDEX "ChatConversation_shopId_updatedAt_idx" ON "ChatConversation"("shopId", "updatedAt");
CREATE INDEX "ChatConversation_clientAuthUserId_updatedAt_idx" ON "ChatConversation"("clientAuthUserId", "updatedAt");
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");
CREATE INDEX "ChatMessage_senderAuthUserId_createdAt_idx" ON "ChatMessage"("senderAuthUserId", "createdAt");
CREATE INDEX "ChatConversationRead_participantAuthUserId_updatedAt_idx" ON "ChatConversationRead"("participantAuthUserId", "updatedAt");

-- Foreign keys
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_clientAuthUserId_fkey" FOREIGN KEY ("clientAuthUserId") REFERENCES "AuthUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderAuthUserId_fkey" FOREIGN KEY ("senderAuthUserId") REFERENCES "AuthUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChatConversationRead" ADD CONSTRAINT "ChatConversationRead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatConversationRead" ADD CONSTRAINT "ChatConversationRead_participantAuthUserId_fkey" FOREIGN KEY ("participantAuthUserId") REFERENCES "AuthUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
