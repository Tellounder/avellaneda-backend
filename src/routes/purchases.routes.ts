import { Router } from 'express';
import * as PurchasesController from '../controllers/purchases.controller';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', requireAdmin, PurchasesController.getPurchases);
router.post('/:id/approve', requireAdmin, PurchasesController.approvePurchase);
router.post('/:id/reject', requireAdmin, PurchasesController.rejectPurchase);

export default router;
