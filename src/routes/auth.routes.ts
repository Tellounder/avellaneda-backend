import { Router } from 'express';
import * as AuthController from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/me', requireAuth, AuthController.getMe);

export default router;
