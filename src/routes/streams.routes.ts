import { Router } from 'express';
import * as StreamsController from '../controllers/streams.controller';
import { requireAdmin, requireAuth, requireShopOrAdmin } from '../middleware/auth';

const router = Router();

router.get('/', StreamsController.getStreams);
router.get('/:id', StreamsController.getStreamById);
router.post('/', requireShopOrAdmin((req) => req.body?.shopId || req.body?.shop?.id), StreamsController.createStream);
router.put('/:id', requireAuth, StreamsController.updateStream);
router.delete('/:id', requireAuth, StreamsController.deleteStream);
router.post('/:id/live', requireAuth, StreamsController.goLive);
router.post('/:id/continue', requireAuth, StreamsController.continueLive);
router.post('/:id/finish', requireAuth, StreamsController.finishStream);
router.post('/:id/report', requireAuth, StreamsController.reportStream);
router.post('/:id/rate', requireAuth, StreamsController.rateStream);
router.post('/:id/hide', requireAdmin, StreamsController.hideStream);
router.post('/:id/show', requireAdmin, StreamsController.showStream);
router.post('/:id/cancel', requireAuth, StreamsController.cancelStream);
router.post('/:id/ban', requireAdmin, StreamsController.banStream);

export default router;
