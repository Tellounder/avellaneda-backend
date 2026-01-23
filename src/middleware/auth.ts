import { Request, Response, NextFunction } from 'express';
import { firebaseAuth, firebaseReady } from '../lib/firebaseAdmin';
import { resolveAuthContext } from '../services/auth.service';

export const optionalAuth = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    req.auth = null;
    return next();
  }

  if (!firebaseReady || !firebaseAuth) {
    return res.status(500).json({ message: 'Firebase Admin no configurado.' });
  }

  const token = header.replace('Bearer ', '').trim();
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    if (!decoded.email) {
      req.auth = null;
      return res.status(401).json({ message: 'Token sin email valido.' });
    }
    const context = await resolveAuthContext(decoded.uid, decoded.email);
    if (context.status === 'SUSPENDED') {
      req.auth = null;
      return res.status(403).json({ message: 'Usuario suspendido.' });
    }
    req.auth = context;
    return next();
  } catch (error) {
    req.auth = null;
    return next();
  }
};

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  return next();
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Autenticacion requerida.' });
  }
  if (req.auth.userType !== 'ADMIN') {
    return res.status(403).json({ message: 'Permisos insuficientes.' });
  }
  return next();
};

export const requireShopOrAdmin = (shopIdResolver: (req: Request) => string | undefined) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ message: 'Autenticacion requerida.' });
    }
    if (req.auth.userType === 'ADMIN') return next();
    if (req.auth.userType === 'SHOP') {
      const shopId = shopIdResolver(req);
      if (!shopId || req.auth.shopId !== shopId) {
        return res.status(403).json({ message: 'Acceso denegado.' });
      }
      return next();
    }
    return res.status(403).json({ message: 'Permisos insuficientes.' });
  };
};
