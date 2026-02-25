import { Request, Response } from 'express';
import * as AuthService from './service';

export const getMe = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  return res.json(req.auth);
};

export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim();
    const data = await AuthService.requestPasswordReset(email);
    return res.json(data);
  } catch (error: any) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({
      message: error?.message || 'No se pudo procesar la solicitud.',
    });
  }
};

export const sendVerification = async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim();
    const data = await AuthService.requestEmailVerification(email);
    return res.json(data);
  } catch (error: any) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({
      message: error?.message || 'No se pudo procesar la solicitud.',
    });
  }
};
