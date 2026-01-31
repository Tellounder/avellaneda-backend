import { Request, Response } from 'express';
import * as ReviewsService from './service';

export const getReviewsByStream = async (req: Request, res: Response) => {
  const data = await ReviewsService.getReviewsByStream(req.params.streamId);
  res.json(data);
};

export const createReview = async (req: Request, res: Response) => {
  if (!req.auth || req.auth.userType !== 'CLIENT') {
    return res.status(403).json({ message: 'Debes iniciar sesion como cliente.' });
  }
  try {
    const data = await ReviewsService.createReview(req.params.streamId, req.body, req.auth.authUserId);
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ message: error.message || 'Error al crear review', error });
  }
};

