import { Response } from 'express';
import prisma from './repo';
import { createRedisPubSubClient, isRedisConfigured } from '../../lib/redis';

type ChatRealtimeEventName = 'chat:connected' | 'chat:ping' | 'chat:new_message' | 'chat:unread_update';

type ChatRealtimeConnection = {
  id: string;
  res: Response;
};

type ChatRealtimeEnvelope = {
  channel: string;
  event: ChatRealtimeEventName | string;
  payload: unknown;
  sourceInstanceId?: string;
};

type ChatRealtimeRuntime = {
  requestedMode: string;
  effectiveMode: 'memory' | 'redis';
  redisConfigured: boolean;
  redisChannel: string | null;
  instanceId: string;
  lastError: string | null;
};

type ChatRealtimeBroker = {
  publish: (envelope: ChatRealtimeEnvelope) => void;
};

const connectionsByChannel = new Map<string, Map<string, ChatRealtimeConnection>>();

const randomId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const instanceId = `${process.pid}-${randomId()}`;
const requestedMode = String(process.env.CHAT_REALTIME_BUS || 'memory')
  .trim()
  .toLowerCase();
const redisChannel = String(process.env.CHAT_REALTIME_REDIS_CHANNEL || 'chat:events').trim();

const realtimeRuntime: ChatRealtimeRuntime = {
  requestedMode,
  effectiveMode: 'memory',
  redisConfigured: isRedisConfigured(),
  redisChannel: requestedMode === 'redis' ? redisChannel : null,
  instanceId,
  lastError: null,
};

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

const createRedisBroker = (): ChatRealtimeBroker | null => {
  if (!realtimeRuntime.redisConfigured) {
    realtimeRuntime.lastError = 'REDIS_URL no configurado.';
    return null;
  }

  const publisher = createRedisPubSubClient('chat-publisher');
  const subscriber = createRedisPubSubClient('chat-subscriber');

  if (!publisher || !subscriber) {
    realtimeRuntime.lastError = 'No se pudo inicializar cliente Redis pub/sub.';
    return null;
  }

  subscriber.on('message', (_channel, rawMessage) => {
    try {
      const envelope = JSON.parse(rawMessage) as ChatRealtimeEnvelope;
      if (!envelope || typeof envelope.channel !== 'string') return;
      if (envelope.sourceInstanceId === instanceId) return;
      publishToLocalConnections(envelope.channel, envelope.event, envelope.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[chat-realtime] mensaje Redis invalido: ${message}`);
    }
  });

  subscriber
    .subscribe(redisChannel)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      realtimeRuntime.lastError = message;
      console.error(`[chat-realtime] no se pudo suscribir a Redis (${redisChannel}): ${message}`);
    });

  return {
    publish: (envelope) => {
      publishToLocalConnections(envelope.channel, envelope.event, envelope.payload);
      const payload: ChatRealtimeEnvelope = {
        ...envelope,
        sourceInstanceId: instanceId,
      };
      void publisher.publish(redisChannel, JSON.stringify(payload)).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        realtimeRuntime.lastError = message;
        console.error(`[chat-realtime] no se pudo publicar en Redis (${redisChannel}): ${message}`);
      });
    },
  };
};

const createRealtimeBroker = (): ChatRealtimeBroker => {
  if (requestedMode === 'redis') {
    const redisBroker = createRedisBroker();
    if (redisBroker) {
      realtimeRuntime.effectiveMode = 'redis';
      return redisBroker;
    }
    console.warn('[chat-realtime] fallback a broker in-memory por falla en Redis.');
  } else if (requestedMode !== 'memory') {
    console.warn(
      `[chat-realtime] modo "${requestedMode}" no soportado. Se utiliza broker in-memory.`
    );
  }
  realtimeRuntime.effectiveMode = 'memory';
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

export const getChatRealtimeRuntime = () => {
  let activeConnections = 0;
  for (const map of connectionsByChannel.values()) {
    activeConnections += map.size;
  }

  return {
    ...realtimeRuntime,
    activeChannels: connectionsByChannel.size,
    activeConnections,
  };
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
