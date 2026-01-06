import { Router } from 'express';
import * as NotificationsController from '../controllers/notifications.controller';
import { requireAdmin, requireAuth } from '../middleware/auth';

const router = Router();

router.post('/run', requireAdmin, NotificationsController.runReminderNotifications);
router.get('/', requireAdmin, NotificationsController.getAllNotifications);
router.get('/:userId', requireAuth, NotificationsController.getNotificationsByUser);
router.post('/:userId/read-all', requireAuth, NotificationsController.markAllAsRead);
router.post('/:id/read', requireAuth, NotificationsController.markAsRead);

export default router;
