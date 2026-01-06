import { Router } from 'express';
import * as ReviewsController from '../controllers/reviews.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/:streamId', ReviewsController.getReviewsByStream);
router.post('/:streamId', requireAuth, ReviewsController.createReview);

export default router;
