import { Request, Response } from 'express';
import * as ChatService from './service';

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
    const data = await ChatService.listShopMessages(auth.authUserId, req.params.conversationId, {
      limit: req.query.limit,
      before: req.query.before,
    }, getShopScope(req));
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
