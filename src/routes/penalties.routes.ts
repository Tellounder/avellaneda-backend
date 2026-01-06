import { Router } from 'express';
import * as PenaltiesController from '../controllers/penalties.controller';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', requireAdmin, PenaltiesController.getPenalties);
router.post('/run', requireAdmin, PenaltiesController.runSanctions);
router.post('/:shopId/apply', requireAdmin, PenaltiesController.applyPenalty);
router.post('/:shopId/remove', requireAdmin, PenaltiesController.removePenalty);

export default router;
