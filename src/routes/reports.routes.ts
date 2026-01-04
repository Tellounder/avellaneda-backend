import { Router } from 'express';
import * as ReportsController from '../controllers/reports.controller';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', requireAdmin, ReportsController.getReports);
router.post('/:id/resolve', requireAdmin, ReportsController.resolveReport);

export default router;
