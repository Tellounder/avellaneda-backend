import { Router } from 'express';
import * as ReelsController from '../controllers/reels.controller';
import { requireAdmin, requireAuth, requireShopOrAdmin } from '../middleware/auth';

const router = Router();

router.get('/', ReelsController.getActiveReels);
router.get('/admin', requireAdmin, ReelsController.getAllReelsAdmin);
router.get('/shop/:shopId', requireShopOrAdmin((req) => req.params.shopId), ReelsController.getReelsByShop);
router.post('/', requireShopOrAdmin((req) => req.body?.shopId), ReelsController.createReel);
router.post('/:id/hide', requireAdmin, ReelsController.hideReel);
router.post('/:id/reactivate', requireAdmin, ReelsController.reactivateReel);
router.post('/:id/view', requireAuth, ReelsController.registerView);

export default router;
