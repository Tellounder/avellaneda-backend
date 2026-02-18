import { Request, Response } from 'express';
import * as ClientsService from './service';

const ensureClientAuth = (req: Request, res: Response) => {
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

export const createMe = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.createClient(auth.authUserId, {
      displayName: req.body?.displayName,
      avatarUrl: req.body?.avatarUrl,
    });
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear cliente', error });
  }
};

export const getMe = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.getClientState(auth.authUserId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al cargar cliente', error });
  }
};

export const getProfile = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.getClientProfile(auth.authUserId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al cargar perfil', error });
  }
};

export const updateProfile = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.updateClientProfile(auth.authUserId, req.body || {});
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al actualizar perfil', error });
  }
};

export const getActivity = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.getClientActivity(auth.authUserId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al cargar actividad', error });
  }
};

export const addFavorite = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.addFavorite(auth.authUserId, req.params.shopId);
    res.json({ favorites: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar favorito', error });
  }
};

export const removeFavorite = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.removeFavorite(auth.authUserId, req.params.shopId);
    res.json({ favorites: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al quitar favorito', error });
  }
};

export const getFavoriteList = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.getFavoriteList(auth.authUserId);
    res.json({ items: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al listar favoritos', error });
  }
};

export const addReminder = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.addReminder(auth.authUserId, req.params.streamId);
    res.json({ reminders: data });
  } catch (error: any) {
    res.status(400).json({ message: error?.message || 'Error al agendar recordatorio', error });
  }
};

export const removeReminder = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.removeReminder(auth.authUserId, req.params.streamId);
    res.json({ reminders: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al quitar recordatorio', error });
  }
};

export const getReminderList = async (req: Request, res: Response) => {
  const auth = ensureClientAuth(req, res);
  if (!auth) return;

  try {
    const data = await ClientsService.getReminderList(auth.authUserId);
    res.json({ items: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al listar recordatorios', error });
  }
};
