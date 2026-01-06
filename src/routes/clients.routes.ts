import { Router } from 'express';
import * as ClientsController from '../controllers/clients.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/me', requireAuth, ClientsController.createMe);

export default router;
