import { Router } from 'express';
import * as ReportsController from '../domains/reports/controller';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', requireAdmin, ReportsController.getReports);
router.post('/:id/resolve', requireAdmin, ReportsController.resolveReport);
router.post('/:id/reject', requireAdmin, ReportsController.rejectReport);

export default router;

