import { Request, Response } from 'express';
import * as NotificationsService from './service';
import { NotificationType } from '@prisma/client';

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

export const getAllNotifications = async (req: Request, res: Response) => {
  try {
    if (!req.auth || req.auth.userType !== 'ADMIN') {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    const limit = Number(req.query?.limit || 50);
    const unreadOnly = String(req.query?.unread || '').toLowerCase() === 'true';
    const type = String(req.query?.type || '').toUpperCase();
    const parsedType = ['SYSTEM', 'REMINDER', 'PURCHASE'].includes(type) ? (type as NotificationType) : undefined;
    const data = await NotificationsService.getAllNotifications({
      limit,
      unreadOnly,
      type: parsedType,
    });
    res.json(data);
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

export const runReminderNotifications = async (req: Request, res: Response) => {
  try {
    const minutes = Number(req.body?.minutesAhead || 15);
    const data = await NotificationsService.runReminderNotifications(minutes);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Error running reminder notifications' });
  }
};

