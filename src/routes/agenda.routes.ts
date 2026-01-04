import { Router } from 'express';
import * as AgendaController from '../controllers/agenda.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/:userId', requireAuth, AgendaController.getAgendaByUser);
router.post('/:userId/add', requireAuth, AgendaController.addToAgenda);
router.post('/:userId/remove', requireAuth, AgendaController.removeFromAgenda);

export default router;
