import { Router } from 'express';
import * as ReelsController from '../domains/reels/controller';
import { requireAdmin, requireAuth, requireShopOrAdmin } from '../middleware/auth';

const router = Router();

router.get('/', ReelsController.getActiveReels);
router.get('/admin', requireAdmin, ReelsController.getAllReelsAdmin);
router.get('/shop/:shopId', requireShopOrAdmin((req) => req.params.shopId), ReelsController.getReelsByShop);
router.get('/:id', requireAuth, ReelsController.getReelById);
router.post('/', requireShopOrAdmin((req) => req.body?.shopId), ReelsController.createReel);
router.post('/:id/hide', requireAuth, ReelsController.hideReel);
router.post('/:id/reactivate', requireAdmin, ReelsController.reactivateReel);
router.post('/:id/view', requireAuth, ReelsController.registerView);
router.delete('/:id', requireAuth, ReelsController.deleteReel);

export default router;

