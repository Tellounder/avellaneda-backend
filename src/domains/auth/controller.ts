import { Request, Response } from 'express';

export const getMe = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  return res.json(req.auth);
};
