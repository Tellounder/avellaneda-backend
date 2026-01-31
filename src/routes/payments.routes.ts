import { Router } from 'express';
import * as PaymentsController from '../domains/payments/controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/mercadopago/preference', requireAuth, PaymentsController.createMercadoPagoPreference);
router.post('/mercadopago/confirm', requireAuth, PaymentsController.confirmMercadoPagoPayment);
router.post('/mercadopago/webhook', PaymentsController.mercadoPagoWebhook);

export default router;

