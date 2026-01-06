import { Request, Response } from 'express';
import * as ClientsService from '../services/clients.service';

export const createMe = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.userType !== 'CLIENT') {
    return res.status(403).json({ message: 'Solo clientes pueden crear perfil.' });
  }

  try {
    const data = await ClientsService.createClient(req.auth.authUserId, {
      displayName: req.body?.displayName,
      avatarUrl: req.body?.avatarUrl,
    });
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear cliente', error });
  }
};

export const getMe = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.userType !== 'CLIENT') {
    return res.status(403).json({ message: 'Solo clientes pueden consultar perfil.' });
  }

  try {
    const data = await ClientsService.getClientState(req.auth.email, req.auth.email);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al cargar cliente', error });
  }
};

export const addFavorite = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.userType !== 'CLIENT') {
    return res.status(403).json({ message: 'Solo clientes pueden guardar favoritos.' });
  }
  try {
    const data = await ClientsService.addFavorite(req.auth.email, req.auth.email, req.params.shopId);
    res.json({ favorites: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar favorito', error });
  }
};

export const removeFavorite = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.userType !== 'CLIENT') {
    return res.status(403).json({ message: 'Solo clientes pueden quitar favoritos.' });
  }
  try {
    const data = await ClientsService.removeFavorite(req.auth.email, req.auth.email, req.params.shopId);
    res.json({ favorites: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al quitar favorito', error });
  }
};

export const addReminder = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.userType !== 'CLIENT') {
    return res.status(403).json({ message: 'Solo clientes pueden agendar recordatorios.' });
  }
  try {
    const data = await ClientsService.addReminder(req.auth.email, req.auth.email, req.params.streamId);
    res.json({ reminders: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al agendar recordatorio', error });
  }
};

export const removeReminder = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.userType !== 'CLIENT') {
    return res.status(403).json({ message: 'Solo clientes pueden quitar recordatorios.' });
  }
  try {
    const data = await ClientsService.removeReminder(req.auth.email, req.auth.email, req.params.streamId);
    res.json({ reminders: data });
  } catch (error) {
    res.status(500).json({ message: 'Error al quitar recordatorio', error });
  }
};
