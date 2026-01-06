import { Request, Response } from 'express';
import * as PenaltiesService from '../services/penalties.service';
import { runSanctionsEngine } from '../services/sanctions.service';

export const getPenalties = async (req: Request, res: Response) => {
  const data = await PenaltiesService.getPenalties();
  res.json(data);
};

export const applyPenalty = async (req: Request, res: Response) => {
  const data = await PenaltiesService.applyPenalty(req.params.shopId, req.body?.reason);
  res.json(data);
};

export const removePenalty = async (req: Request, res: Response) => {
  const data = await PenaltiesService.removePenalty(req.params.shopId);
  res.json(data);
};

export const runSanctions = async (_req: Request, res: Response) => {
  try {
    const result = await runSanctionsEngine();
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Error al ejecutar motor de sanciones', error });
  }
};
