import { Router } from 'express';
import * as AuthController from '../domains/auth/controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/forgot-password', AuthController.forgotPassword);
router.get('/me', requireAuth, AuthController.getMe);

export default router;

