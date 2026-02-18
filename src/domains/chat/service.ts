import {
  ChatMessageSenderType,
  ChatMessageType,
  ChatParticipantType,
  ChatConversationStatus,
} from '@prisma/client';
import prisma from './repo';

const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;

type SendMessagePayload = {
  content?: unknown;
  messageType?: unknown;
  attachments?: unknown;
};

type AttachmentItem = {
  kind: 'image' | 'video';
  url: string;
  sizeBytes?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
};

const normalizeContent = (value: unknown) => {
  const content = String(value || '').trim();
  if (!content) return null;
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`El mensaje supera el maximo de ${MAX_MESSAGE_LENGTH} caracteres.`);
  }
  return content;
};

const normalizeMessageType = (value: unknown) => {
  const raw = String(value || 'TEXT').trim().toUpperCase();
  if (raw === 'TEXT' || raw === 'IMAGE' || raw === 'VIDEO' || raw === 'SYSTEM') {
    return raw as ChatMessageType;
  }
  return ChatMessageType.TEXT;
};

const normalizeAttachments = (value: unknown): AttachmentItem[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      kind: String((item as any)?.kind || '').toLowerCase(),
      url: String((item as any)?.url || '').trim(),
      sizeBytes: Number((item as any)?.sizeBytes || 0) || undefined,
      durationSeconds: Number((item as any)?.durationSeconds || 0) || undefined,
      width: Number((item as any)?.width || 0) || undefined,
      height: Number((item as any)?.height || 0) || undefined,
    }))
    .filter((item) => (item.kind === 'image' || item.kind === 'video') && Boolean(item.url))
    .slice(0, 4) as AttachmentItem[];
};

const buildPreview = (content: string | null, type: ChatMessageType, attachments: AttachmentItem[]) => {
  if (content) {
    return content.length > 120 ? `${content.slice(0, 117)}...` : content;
  }
  if (type === ChatMessageType.IMAGE || attachments.some((item) => item.kind === 'image')) {
    return '[Imagen]';
  }
  if (type === ChatMessageType.VIDEO || attachments.some((item) => item.kind === 'video')) {
    return '[Video]';
  }
  return '[Mensaje]';
};

const toPageSize = (value: unknown) => {
  const numeric = Number(value || DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(numeric)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(numeric)));
};

const toBeforeDate = (value: unknown): Date | null => {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const buildMessageResponse = (
  message: {
    id: string;
    conversationId: string;
    senderType: ChatMessageSenderType;
    senderAuthUserId: string | null;
    messageType: ChatMessageType;
    content: string | null;
    attachments: unknown;
    readAt: Date | null;
    createdAt: Date;
  },
  authUserId: string
) => ({
  id: message.id,
  conversationId: message.conversationId,
  senderType: message.senderType,
  senderAuthUserId: message.senderAuthUserId,
  messageType: message.messageType,
  content: message.content,
  attachments: message.attachments,
  readAt: message.readAt,
  createdAt: message.createdAt,
  isMine: message.senderAuthUserId === authUserId,
});

const resolveShopByAuthUser = async (authUserId: string) => {
  const shop = await prisma.shop.findFirst({
    where: { authUserId },
    select: { id: true, name: true, logoUrl: true, authUserId: true },
  });
  if (!shop) {
    throw new Error('No encontramos una tienda asociada a esta cuenta.');
  }
  return shop;
};

const getConversationForClient = async (conversationId: string, clientAuthUserId: string) => {
  const conversation = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation || conversation.clientAuthUserId !== clientAuthUserId) {
    throw new Error('Conversacion no encontrada.');
  }
  return conversation;
};

const getConversationForShop = async (conversationId: string, shopAuthUserId: string) => {
  const shop = await resolveShopByAuthUser(shopAuthUserId);
  const conversation = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation || conversation.shopId !== shop.id) {
    throw new Error('Conversacion no encontrada.');
  }
  return { conversation, shop };
};

const loadUnreadCount = async (
  conversationId: string,
  participantType: ChatParticipantType,
  lastReadAt: Date | null
) => {
  const senderType =
    participantType === ChatParticipantType.CLIENT
      ? ChatMessageSenderType.SHOP
      : ChatMessageSenderType.CLIENT;

  return prisma.chatMessage.count({
    where: {
      conversationId,
      senderType,
      ...(lastReadAt
        ? {
            createdAt: {
              gt: lastReadAt,
            },
          }
        : {}),
    },
  });
};

export const getOrCreateClientConversation = async (clientAuthUserId: string, shopId: string) => {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      authUserId: true,
      status: true,
      visibilityState: true,
    },
  });

  if (!shop) {
    throw new Error('Tienda no encontrada.');
  }

  const now = new Date();

  const conversation = await prisma.chatConversation.upsert({
    where: {
      clientAuthUserId_shopId: {
        clientAuthUserId,
        shopId,
      },
    },
    update: {},
    create: {
      clientAuthUserId,
      shopId,
      status: ChatConversationStatus.OPEN,
    },
    select: {
      id: true,
      status: true,
      lastMessagePreview: true,
      updatedAt: true,
      createdAt: true,
      firstResponseSeconds: true,
      firstShopResponseAt: true,
      firstClientMessageAt: true,
      lastClientMessageAt: true,
      lastShopMessageAt: true,
    },
  });

  await prisma.chatConversationRead.upsert({
    where: {
      conversationId_participantType: {
        conversationId: conversation.id,
        participantType: ChatParticipantType.CLIENT,
      },
    },
    update: {
      participantAuthUserId: clientAuthUserId,
      lastReadAt: now,
    },
    create: {
      conversationId: conversation.id,
      participantType: ChatParticipantType.CLIENT,
      participantAuthUserId: clientAuthUserId,
      lastReadAt: now,
    },
  });

  if (shop.authUserId) {
    await prisma.chatConversationRead
      .upsert({
        where: {
          conversationId_participantType: {
            conversationId: conversation.id,
            participantType: ChatParticipantType.SHOP,
          },
        },
        update: {
          participantAuthUserId: shop.authUserId,
        },
        create: {
          conversationId: conversation.id,
          participantType: ChatParticipantType.SHOP,
          participantAuthUserId: shop.authUserId,
        },
      })
      .catch(() => {
        // Keep conversation alive if shop read marker cannot be persisted.
      });
  }

  return {
    ...conversation,
    unreadCount: 0,
    shop: {
      id: shop.id,
      name: shop.name,
      logoUrl: shop.logoUrl,
      status: shop.status,
      visibilityState: shop.visibilityState,
    },
  };
};

export const listClientConversations = async (clientAuthUserId: string) => {
  const conversations = await prisma.chatConversation.findMany({
    where: { clientAuthUserId },
    orderBy: { updatedAt: 'desc' },
    include: {
      shop: {
        select: {
          id: true,
          name: true,
          logoUrl: true,
          status: true,
          visibilityState: true,
        },
      },
      reads: {
        where: { participantType: ChatParticipantType.CLIENT },
        select: { lastReadAt: true },
        take: 1,
      },
    },
    take: 50,
  });

  const withUnread = await Promise.all(
    conversations.map(async (conversation) => {
      const lastReadAt = conversation.reads[0]?.lastReadAt || null;
      const unreadCount = await loadUnreadCount(
        conversation.id,
        ChatParticipantType.CLIENT,
        lastReadAt
      );
      return {
        id: conversation.id,
        status: conversation.status,
        lastMessagePreview: conversation.lastMessagePreview,
        updatedAt: conversation.updatedAt,
        createdAt: conversation.createdAt,
        firstResponseSeconds: conversation.firstResponseSeconds,
        firstShopResponseAt: conversation.firstShopResponseAt,
        firstClientMessageAt: conversation.firstClientMessageAt,
        lastClientMessageAt: conversation.lastClientMessageAt,
        lastShopMessageAt: conversation.lastShopMessageAt,
        unreadCount,
        shop: conversation.shop,
      };
    })
  );

  return withUnread;
};

export const listShopConversations = async (shopAuthUserId: string) => {
  const shop = await resolveShopByAuthUser(shopAuthUserId);
  const conversations = await prisma.chatConversation.findMany({
    where: { shopId: shop.id },
    orderBy: { updatedAt: 'desc' },
    include: {
      clientAuthUser: {
        select: {
          id: true,
          email: true,
          client: {
            select: {
              displayName: true,
              avatarUrl: true,
            },
          },
        },
      },
      reads: {
        where: { participantType: ChatParticipantType.SHOP },
        select: { lastReadAt: true },
        take: 1,
      },
    },
    take: 80,
  });

  const withUnread = await Promise.all(
    conversations.map(async (conversation) => {
      const lastReadAt = conversation.reads[0]?.lastReadAt || null;
      const unreadCount = await loadUnreadCount(
        conversation.id,
        ChatParticipantType.SHOP,
        lastReadAt
      );
      return {
        id: conversation.id,
        status: conversation.status,
        lastMessagePreview: conversation.lastMessagePreview,
        updatedAt: conversation.updatedAt,
        createdAt: conversation.createdAt,
        firstResponseSeconds: conversation.firstResponseSeconds,
        firstShopResponseAt: conversation.firstShopResponseAt,
        firstClientMessageAt: conversation.firstClientMessageAt,
        lastClientMessageAt: conversation.lastClientMessageAt,
        lastShopMessageAt: conversation.lastShopMessageAt,
        unreadCount,
        client: {
          authUserId: conversation.clientAuthUser.id,
          email: conversation.clientAuthUser.email,
          displayName: conversation.clientAuthUser.client?.displayName || null,
          avatarUrl: conversation.clientAuthUser.client?.avatarUrl || null,
        },
      };
    })
  );

  return {
    shop: {
      id: shop.id,
      name: shop.name,
      logoUrl: shop.logoUrl,
    },
    conversations: withUnread,
  };
};

export const listClientMessages = async (
  clientAuthUserId: string,
  conversationId: string,
  options: { limit?: unknown; before?: unknown }
) => {
  await getConversationForClient(conversationId, clientAuthUserId);

  const limit = toPageSize(options.limit);
  const before = toBeforeDate(options.before);

  const messages = await prisma.chatMessage.findMany({
    where: {
      conversationId,
      ...(before
        ? {
            createdAt: {
              lt: before,
            },
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return messages.reverse().map((item) => buildMessageResponse(item, clientAuthUserId));
};

export const listShopMessages = async (
  shopAuthUserId: string,
  conversationId: string,
  options: { limit?: unknown; before?: unknown }
) => {
  const { conversation } = await getConversationForShop(conversationId, shopAuthUserId);

  const limit = toPageSize(options.limit);
  const before = toBeforeDate(options.before);

  const messages = await prisma.chatMessage.findMany({
    where: {
      conversationId: conversation.id,
      ...(before
        ? {
            createdAt: {
              lt: before,
            },
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return messages.reverse().map((item) => buildMessageResponse(item, shopAuthUserId));
};

export const markClientConversationRead = async (clientAuthUserId: string, conversationId: string) => {
  await getConversationForClient(conversationId, clientAuthUserId);
  const now = new Date();
  await prisma.chatConversationRead.upsert({
    where: {
      conversationId_participantType: {
        conversationId,
        participantType: ChatParticipantType.CLIENT,
      },
    },
    update: {
      participantAuthUserId: clientAuthUserId,
      lastReadAt: now,
    },
    create: {
      conversationId,
      participantType: ChatParticipantType.CLIENT,
      participantAuthUserId: clientAuthUserId,
      lastReadAt: now,
    },
  });

  return { ok: true, readAt: now };
};

export const markShopConversationRead = async (shopAuthUserId: string, conversationId: string) => {
  await getConversationForShop(conversationId, shopAuthUserId);

  const now = new Date();
  await prisma.chatConversationRead.upsert({
    where: {
      conversationId_participantType: {
        conversationId,
        participantType: ChatParticipantType.SHOP,
      },
    },
    update: {
      participantAuthUserId: shopAuthUserId,
      lastReadAt: now,
    },
    create: {
      conversationId,
      participantType: ChatParticipantType.SHOP,
      participantAuthUserId: shopAuthUserId,
      lastReadAt: now,
    },
  });

  return { ok: true, readAt: now };
};

export const sendClientMessage = async (
  clientAuthUserId: string,
  conversationId: string,
  payload: SendMessagePayload
) => {
  const conversation = await getConversationForClient(conversationId, clientAuthUserId);
  if (conversation.status !== ChatConversationStatus.OPEN) {
    throw new Error('La conversacion no esta disponible para nuevos mensajes.');
  }

  const content = normalizeContent(payload.content);
  const attachments = normalizeAttachments(payload.attachments);
  const requestedType = normalizeMessageType(payload.messageType);
  const messageType =
    requestedType === ChatMessageType.TEXT && attachments.length
      ? attachments.some((item) => item.kind === 'video')
        ? ChatMessageType.VIDEO
        : ChatMessageType.IMAGE
      : requestedType;

  if (!content && attachments.length === 0) {
    throw new Error('Debes enviar texto o al menos un archivo.');
  }

  const now = new Date();
  const preview = buildPreview(content, messageType, attachments);

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.chatMessage.create({
      data: {
        conversationId,
        senderType: ChatMessageSenderType.CLIENT,
        senderAuthUserId: clientAuthUserId,
        messageType,
        content,
        attachments: attachments.length ? (attachments as any) : undefined,
      },
    });

    await tx.chatConversation.update({
      where: { id: conversationId },
      data: {
        status: ChatConversationStatus.OPEN,
        firstClientMessageAt: conversation.firstClientMessageAt || now,
        lastClientMessageAt: now,
        lastMessagePreview: preview,
      },
    });

    await tx.chatConversationRead.upsert({
      where: {
        conversationId_participantType: {
          conversationId,
          participantType: ChatParticipantType.CLIENT,
        },
      },
      update: {
        participantAuthUserId: clientAuthUserId,
        lastReadAt: now,
      },
      create: {
        conversationId,
        participantType: ChatParticipantType.CLIENT,
        participantAuthUserId: clientAuthUserId,
        lastReadAt: now,
      },
    });

    return created;
  });

  return buildMessageResponse(message, clientAuthUserId);
};

export const sendShopMessage = async (
  shopAuthUserId: string,
  conversationId: string,
  payload: SendMessagePayload
) => {
  const { conversation } = await getConversationForShop(conversationId, shopAuthUserId);
  if (conversation.status !== ChatConversationStatus.OPEN) {
    throw new Error('La conversacion no esta disponible para nuevos mensajes.');
  }

  const content = normalizeContent(payload.content);
  const attachments = normalizeAttachments(payload.attachments);
  const requestedType = normalizeMessageType(payload.messageType);
  const messageType =
    requestedType === ChatMessageType.TEXT && attachments.length
      ? attachments.some((item) => item.kind === 'video')
        ? ChatMessageType.VIDEO
        : ChatMessageType.IMAGE
      : requestedType;

  if (!content && attachments.length === 0) {
    throw new Error('Debes enviar texto o al menos un archivo.');
  }

  const now = new Date();
  const preview = buildPreview(content, messageType, attachments);

  const firstClientAt = conversation.firstClientMessageAt || conversation.lastClientMessageAt;
  const shouldMarkFirstResponse = !conversation.firstShopResponseAt && Boolean(firstClientAt);

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.chatMessage.create({
      data: {
        conversationId,
        senderType: ChatMessageSenderType.SHOP,
        senderAuthUserId: shopAuthUserId,
        messageType,
        content,
        attachments: attachments.length ? (attachments as any) : undefined,
      },
    });

    await tx.chatConversation.update({
      where: { id: conversationId },
      data: {
        status: ChatConversationStatus.OPEN,
        lastShopMessageAt: now,
        lastMessagePreview: preview,
        ...(shouldMarkFirstResponse
          ? {
              firstShopResponseAt: now,
              firstResponseSeconds: Math.max(
                0,
                Math.round((now.getTime() - (firstClientAt as Date).getTime()) / 1000)
              ),
            }
          : {}),
      },
    });

    await tx.chatConversationRead.upsert({
      where: {
        conversationId_participantType: {
          conversationId,
          participantType: ChatParticipantType.SHOP,
        },
      },
      update: {
        participantAuthUserId: shopAuthUserId,
        lastReadAt: now,
      },
      create: {
        conversationId,
        participantType: ChatParticipantType.SHOP,
        participantAuthUserId: shopAuthUserId,
        lastReadAt: now,
      },
    });

    return created;
  });

  return buildMessageResponse(message, shopAuthUserId);
};
