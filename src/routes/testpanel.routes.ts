import { Router } from 'express';
import * as TestPanelController from '../controllers/testpanel.controller';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', requireAdmin, TestPanelController.getTestPanelData);
router.post('/reset', requireAdmin, TestPanelController.resetTestPanel);

export default router;
