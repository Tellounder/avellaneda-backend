import { Request, Response } from 'express';
import * as ReportsService from '../services/reports.service';

export const reportStream = async (req: Request, res: Response) => {
  try {
    if (!req.auth || req.auth.userType !== 'CLIENT') {
      return res.status(403).json({ message: 'Debes iniciar sesion como cliente.' });
    }
    const data = await ReportsService.reportStream(
      req.params.id,
      req.auth.authUserId,
      req.body?.reason
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear reporte', error });
  }
};

export const getReports = async (req: Request, res: Response) => {
  try {
    const data = await ReportsService.getReports();
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener reportes', error });
  }
};

export const resolveReport = async (req: Request, res: Response) => {
  try {
    const data = await ReportsService.resolveReport(req.params.id, req.auth?.authUserId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al resolver reporte', error });
  }
};

export const rejectReport = async (req: Request, res: Response) => {
  try {
    const data = await ReportsService.rejectReport(req.params.id, req.auth?.authUserId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error al rechazar reporte', error });
  }
};
