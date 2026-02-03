import { Router } from 'express';
import * as ShopsController from '../domains/shops/controller';
import { requireAdmin, requireShopOrAdmin } from '../middleware/auth';

const router = Router();

// --- LÍNEA NUEVA: Habilitamos la creación de tiendas ---
router.post('/', requireAdmin, ShopsController.createShop);
// -------------------------------------------------------

router.get('/', ShopsController.getShops);
router.get('/map-data', ShopsController.getShopsMapData);
router.get('/check-email', ShopsController.checkShopEmail);
router.get('/:id', ShopsController.getShopById);
router.delete('/:id', requireAdmin, ShopsController.deleteShop);
router.put('/:id', requireShopOrAdmin((req) => req.params.id), ShopsController.updateShop);
router.post('/:id/buy-stream-quota', requireShopOrAdmin((req) => req.params.id), ShopsController.buyStreamQuota);
router.post('/:id/buy-reel-quota', requireShopOrAdmin((req) => req.params.id), ShopsController.buyReelQuota);
router.post('/:id/assign-owner', requireAdmin, ShopsController.assignOwner);
router.post('/:id/accept', requireShopOrAdmin((req) => req.params.id), ShopsController.acceptShop);
router.post('/:id/toggle-penalty', requireAdmin, ShopsController.togglePenalty);
router.post('/:id/activate', requireAdmin, ShopsController.activateShop);
router.post('/:id/reject', requireAdmin, ShopsController.rejectShop);
router.post('/:id/suspend-agenda', requireAdmin, ShopsController.suspendAgenda);
router.post('/:id/lift-suspension', requireAdmin, ShopsController.liftAgendaSuspension);
router.post('/:id/reset-password', requireAdmin, ShopsController.resetShopPassword);
router.post('/:id/send-invite', requireAdmin, ShopsController.sendShopInvite);

export default router;

