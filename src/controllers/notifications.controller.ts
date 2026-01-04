import { Request, Response } from 'express';
import * as NotificationsService from '../services/notifications.service';

const canAccessUser = (req: Request, userId: string) => {
  if (!req.auth) return false;
  if (req.auth.userType === 'ADMIN') return true;
  return req.auth.authUserId === userId;
};

export const getNotificationsByUser = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    if (!canAccessUser(req, userId)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    const notifications = await NotificationsService.getNotificationsByUser(userId);
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching notifications' });
  }
};

export const markAsRead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!req.auth) {
      return res.status(401).json({ error: 'Autenticacion requerida.' });
    }
    if (req.auth.userType !== 'ADMIN') {
      const existing = await NotificationsService.getNotificationById(id);
      if (!existing || existing.userId !== req.auth.authUserId) {
        return res.status(403).json({ error: 'Acceso denegado' });
      }
    }
    const updated = await NotificationsService.markAsRead(id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error marking notification as read' });
  }
};

export const markAllAsRead = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    if (!canAccessUser(req, userId)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    const updated = await NotificationsService.markAllAsRead(userId);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error marking all notifications as read' });
  }
};
