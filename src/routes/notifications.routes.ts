import { Router } from 'express';
import * as NotificationsController from '../controllers/notifications.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/:userId', requireAuth, NotificationsController.getNotificationsByUser);
router.post('/:userId/read-all', requireAuth, NotificationsController.markAllAsRead);
router.post('/:id/read', requireAuth, NotificationsController.markAsRead);

export default router;
