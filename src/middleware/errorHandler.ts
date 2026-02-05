import { NextFunction, Request, Response } from 'express';

const PRISMA_CONNECTION_CODES = new Set(['P1001', 'P1002', 'P2024']);

const isPrismaConnectionError = (error: any) => {
  const code = error?.code;
  if (code && PRISMA_CONNECTION_CODES.has(code)) return true;
  const message = String(error?.message || '');
  return (
    message.includes("Can't reach database server") ||
    message.includes('Timed out fetching a new connection')
  );
};

export const errorHandler = (error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  const status = typeof error?.status === 'number'
    ? error.status
    : isPrismaConnectionError(error)
      ? 503
      : 500;
  const message =
    typeof error?.message === 'string' && error.message.trim()
      ? error.message
      : status === 503
        ? 'Base de datos temporalmente no disponible. Intenta en unos minutos.'
        : 'Error interno del servidor.';
  if (status >= 500) {
    console.error('Unhandled error:', error);
  }
  res.status(status).json({ message });
};
