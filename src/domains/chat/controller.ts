import { Request, Response } from 'express';
import * as ChatService from './service';
import {
  buildClientChannel,
  buildShopChannel,
  registerRealtimeConnection,
  resolveShopScope,
  writeRealtimeEvent,
} from './realtime';

const ensureClient = (req: Request, res: Response) => {
  if (!req.auth) {
    res.status(401).json({ message: 'Autenticacion requerida.' });
    return null;
  }
  if (req.auth.userType !== 'CLIENT') {
    res.status(403).json({ message: 'Solo clientes pueden usar este recurso.' });
    return null;
  }
  return req.auth;
};

const ensureShop = (req: Request, res: Response) => {
  if (!req.auth) {
    res.status(401).json({ message: 'Autenticacion requerida.' });
    return null;
  }
  if (req.auth.userType !== 'SHOP') {
    res.status(403).json({ message: 'Solo tiendas pueden usar este recurso.' });
    return null;
  }
  return req.auth;
};

const getShopScope = (req: Request) => {
  const fromQuery = typeof req.query?.shopId === 'string' ? req.query.shopId.trim() : '';
  if (fromQuery) return fromQuery;
  const fromBody = typeof req.body?.shopId === 'string' ? req.body.shopId.trim() : '';
  return fromBody || undefined;
};

export const openClientConversation = async (req: Request, res: Response) => {
  const auth = ensureClient(req, res);
  if (!auth) return;

  try {
    const data = await ChatService.getOrCreateClientConversation(auth.authUserId, req.params.shopId);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al abrir conversacion.', error });
  }
};

export const listClientConversations = async (req: Request, res: Response) => {
  const auth = ensureClient(req, res);
  if (!auth) return;

  try {
    const data = await ChatService.listClientConversations(auth.authUserId);
    res.json({ items: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al listar conversaciones.', error });
  }
};

export const listClientMessages = async (req: Request, res: Response) => {
  const auth = ensureClient(req, res);
  if (!auth) return;

  try {
    const data = await ChatService.listClientMessages(auth.authUserId, req.params.conversationId, {
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ items: data });
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al cargar mensajes.', error });
  }
};

export const sendClientMessage = async (req: Request, res: Response) => {
  const auth = ensureClient(req, res);
  if (!auth) return;

  try {
    const data = await ChatService.sendClientMessage(auth.authUserId, req.params.conversationId, req.body || {});
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al enviar mensaje.', error });
  }
};

export const markClientConversationRead = async (req: Request, res: Response) => {
  const auth = ensureClient(req, res);
  if (!auth) return;

  try {
    const data = await ChatService.markClientConversationRead(auth.authUserId, req.params.conversationId);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al marcar lectura.', error });
  }
};

export const listShopConversations = async (req: Request, res: Response) => {
  const auth = ensureShop(req, res);
  if (!auth) return;

  try {
    const data = await ChatService.listShopConversations(auth.authUserId, getShopScope(req));
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al listar conversaciones.', error });
  }
};

export const listShopMessages = async (req: Request, res: Response) => {
  const auth = ensureShop(req, res);
  if (!auth) return;

  try {
    const data = await ChatService.listShopMessages(
      auth.authUserId,
      req.params.conversationId,
      {
        limit: req.query.limit,
        before: req.query.before,
      },
      getShopScope(req)
    );
    res.json({ items: data });
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al cargar mensajes.', error });
  }
};

export const sendShopMessage = async (req: Request, res: Response) => {
  const auth = ensureShop(req, res);
  if (!auth) return;

  try {
    const data = await ChatService.sendShopMessage(
      auth.authUserId,
      req.params.conversationId,
      req.body || {},
      getShopScope(req)
    );
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al enviar mensaje.', error });
  }
};

export const markShopConversationRead = async (req: Request, res: Response) => {
  const auth = ensureShop(req, res);
  if (!auth) return;

  try {
    const data = await ChatService.markShopConversationRead(
      auth.authUserId,
      req.params.conversationId,
      getShopScope(req)
    );
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al marcar lectura.', error });
  }
};

export const streamEvents = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.status === 'SUSPENDED') {
    return res.status(403).json({ message: 'Usuario suspendido.' });
  }

  let channel = '';
  try {
    if (req.auth.userType === 'CLIENT') {
      channel = buildClientChannel(req.auth.authUserId);
    } else if (req.auth.userType === 'SHOP') {
      const scopedShopId = getShopScope(req);
      const scopedShop = await resolveShopScope(req.auth.authUserId, scopedShopId);
      channel = buildShopChannel(scopedShop.id);
    } else {
      return res.status(403).json({ message: 'Solo clientes y tiendas pueden usar chat en tiempo real.' });
    }
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'No se pudo abrir el stream de chat.', error });
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const unregister = registerRealtimeConnection(channel, res);
  writeRealtimeEvent(res, 'chat:connected', {
    ok: true,
    channel,
    at: new Date().toISOString(),
  });

  const heartbeat = setInterval(() => {
    writeRealtimeEvent(res, 'chat:ping', { at: new Date().toISOString() });
  }, 25_000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unregister();
    if (!res.writableEnded) {
      res.end();
    }
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
};
