import { Request, Response } from 'express';
import * as PenaltiesService from './service';
import { runSanctionsEngine } from '../../services/sanctions.service';

export const getPenalties = async (req: Request, res: Response) => {
  const data = await PenaltiesService.getPenalties();
  res.json(data);
};

export const applyPenalty = async (req: Request, res: Response) => {
  return res.status(410).json({
    message: 'Penalty legacy desactivado. Usar motor de sanciones por reportes.',
  });
};

export const removePenalty = async (req: Request, res: Response) => {
  return res.status(410).json({
    message: 'Penalty legacy desactivado. Usar suspension de agenda y auditoria.',
  });
};

export const runSanctions = async (_req: Request, res: Response) => {
  try {
    const result = await runSanctionsEngine();
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Error al ejecutar motor de sanciones', error });
  }
};

