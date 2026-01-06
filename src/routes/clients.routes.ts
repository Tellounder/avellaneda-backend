import { Router } from 'express';
import * as ClientsController from '../controllers/clients.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/me', requireAuth, ClientsController.getMe);
router.post('/me', requireAuth, ClientsController.createMe);
router.get('/me/favorites', requireAuth, ClientsController.getMe);
router.post('/me/favorites/:shopId', requireAuth, ClientsController.addFavorite);
router.delete('/me/favorites/:shopId', requireAuth, ClientsController.removeFavorite);
router.get('/me/reminders', requireAuth, ClientsController.getMe);
router.post('/me/reminders/:streamId', requireAuth, ClientsController.addReminder);
router.delete('/me/reminders/:streamId', requireAuth, ClientsController.removeReminder);

export default router;
