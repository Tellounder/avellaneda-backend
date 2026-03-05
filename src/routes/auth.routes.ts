import { Router } from 'express';
import * as AuthController from '../domains/auth/controller';
import { requireAdmin, requireAuth } from '../middleware/auth';

const router = Router();

router.post('/forgot-password', AuthController.forgotPassword);
router.post('/send-verification', AuthController.sendVerification);
router.get('/me', requireAuth, AuthController.getMe);
router.post('/onboarding-intent', requireAuth, AuthController.completeOnboarding);
router.get('/admin/users', requireAdmin, AuthController.listUsersAdmin);

export default router;

