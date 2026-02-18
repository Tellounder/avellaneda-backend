import { Response } from 'express';
import prisma from './repo';

type ChatRealtimeEventName = 'chat:connected' | 'chat:ping' | 'chat:new_message' | 'chat:unread_update';

type ChatRealtimeConnection = {
  id: string;
  res: Response;
};

type ChatRealtimeEnvelope = {
  channel: string;
  event: ChatRealtimeEventName | string;
  payload: unknown;
};

type ChatRealtimeBroker = {
  publish: (envelope: ChatRealtimeEnvelope) => void;
};

const connectionsByChannel = new Map<string, Map<string, ChatRealtimeConnection>>();

const randomId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const buildClientChannel = (authUserId: string) => `client:${authUserId}`;
export const buildShopChannel = (shopId: string) => `shop:${shopId}`;

const getChannelMap = (channel: string) => {
  let map = connectionsByChannel.get(channel);
  if (!map) {
    map = new Map<string, ChatRealtimeConnection>();
    connectionsByChannel.set(channel, map);
  }
  return map;
};

const publishToLocalConnections = (
  channel: string,
  event: ChatRealtimeEventName | string,
  payload: unknown
) => {
  const map = connectionsByChannel.get(channel);
  if (!map || map.size === 0) return;

  const stale: string[] = [];
  for (const [id, connection] of map.entries()) {
    try {
      writeRealtimeEvent(connection.res, event, payload);
    } catch {
      stale.push(id);
    }
  }

  if (stale.length) {
    for (const id of stale) {
      map.delete(id);
    }
    if (map.size === 0) {
      connectionsByChannel.delete(channel);
    }
  }
};

const createInMemoryBroker = (): ChatRealtimeBroker => ({
  publish: (envelope) => {
    publishToLocalConnections(envelope.channel, envelope.event, envelope.payload);
  },
});

const createRealtimeBroker = (): ChatRealtimeBroker => {
  const mode = String(process.env.CHAT_REALTIME_BUS || 'memory').trim().toLowerCase();
  if (mode !== 'memory') {
    console.warn(
      `[chat-realtime] modo "${mode}" no soportado en este build. Se utiliza broker in-memory.`
    );
  }
  return createInMemoryBroker();
};

const realtimeBroker = createRealtimeBroker();

export const writeRealtimeEvent = (
  res: Response,
  event: ChatRealtimeEventName | string,
  payload: unknown
) => {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const registerRealtimeConnection = (channel: string, res: Response) => {
  const id = randomId();
  const channelMap = getChannelMap(channel);
  channelMap.set(id, { id, res });

  return () => {
    const map = connectionsByChannel.get(channel);
    if (!map) return;
    map.delete(id);
    if (map.size === 0) {
      connectionsByChannel.delete(channel);
    }
  };
};

const emitToChannel = (channel: string, event: ChatRealtimeEventName | string, payload: unknown) => {
  realtimeBroker.publish({ channel, event, payload });
};

export const emitToClient = (
  authUserId: string,
  event: ChatRealtimeEventName | string,
  payload: unknown
) => {
  emitToChannel(buildClientChannel(authUserId), event, payload);
};

export const emitToShop = (shopId: string, event: ChatRealtimeEventName | string, payload: unknown) => {
  emitToChannel(buildShopChannel(shopId), event, payload);
};

export const resolveShopScope = async (authUserId: string, requestedShopId?: string | null) => {
  const where = requestedShopId
    ? {
        id: requestedShopId,
        authUserId,
      }
    : {
        authUserId,
      };

  const shop = await prisma.shop.findFirst({
    where,
    select: { id: true, name: true },
  });

  if (!shop) {
    if (requestedShopId) {
      throw new Error('No encontramos la tienda seleccionada para esta cuenta.');
    }
    throw new Error('No encontramos una tienda asociada a esta cuenta.');
  }

  return shop;
};
