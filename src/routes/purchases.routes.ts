import { Router } from 'express';
import * as PurchasesController from '../controllers/purchases.controller';
import { requireAdmin, requireShopOrAdmin } from '../middleware/auth';

const router = Router();

router.get('/', requireAdmin, PurchasesController.getPurchases);
router.get('/shop/:shopId', requireShopOrAdmin((req) => req.params.shopId), PurchasesController.getPurchasesByShop);
router.post('/:id/approve', requireAdmin, PurchasesController.approvePurchase);
router.post('/:id/reject', requireAdmin, PurchasesController.rejectPurchase);

export default router;
