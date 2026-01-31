import { AuthContext } from '../domains/auth/service';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext | null;
      rawBody?: string;
    }
  }
}

export {};
