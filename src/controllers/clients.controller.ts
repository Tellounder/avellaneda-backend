import { Request, Response } from 'express';
import * as ClientsService from '../services/clients.service';

export const createMe = async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.userType !== 'CLIENT') {
    return res.status(403).json({ message: 'Solo clientes pueden crear perfil.' });
  }

  try {
    const data = await ClientsService.createClient(req.auth.authUserId, {
      displayName: req.body?.displayName,
      avatarUrl: req.body?.avatarUrl,
    });
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear cliente', error });
  }
};
