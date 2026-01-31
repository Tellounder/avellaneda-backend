import { Router } from 'express';
import { requireAdmin } from '../middleware/auth';
import * as SystemController from '../domains/system/controller';

const router = Router();

router.get('/status', requireAdmin, SystemController.getStatus);

export default router;

