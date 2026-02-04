import { Router } from 'express';
import * as ShareController from '../domains/share/controller';

const router = Router();

router.get('/reels/:id', ShareController.getReelSharePage);
router.get('/streams/:id', ShareController.getStreamSharePage);

export default router;
