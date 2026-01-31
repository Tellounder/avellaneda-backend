import { Request, Response } from 'express';
import * as AgendaService from './service';

const canAccessUser = (req: Request, userId: string) => {
  if (!req.auth) return false;
  if (req.auth.userType === 'ADMIN') return true;
  return req.auth.authUserId === userId;
};

export const getAgendaByUser = async (req: Request, res: Response) => {
  if (!canAccessUser(req, req.params.userId)) {
    return res.status(403).json({ message: 'Acceso denegado.' });
  }
  const data = await AgendaService.getAgendaByUser(req.params.userId);
  res.json(data);
};

export const addToAgenda = async (req: Request, res: Response) => {
  if (!canAccessUser(req, req.params.userId)) {
    return res.status(403).json({ message: 'Acceso denegado.' });
  }
  const data = await AgendaService.addToAgenda(req.params.userId, req.body.streamId);
  res.json(data);
};

export const removeFromAgenda = async (req: Request, res: Response) => {
  if (!canAccessUser(req, req.params.userId)) {
    return res.status(403).json({ message: 'Acceso denegado.' });
  }
  const data = await AgendaService.removeFromAgenda(req.params.userId, req.body.streamId);
  res.json(data);
};

