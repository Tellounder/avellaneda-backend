import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import streamsRoutes from '../routes/streams.routes';
import reelsRoutes from '../routes/reels.routes';
import shopsRoutes from '../routes/shops.routes';
import reviewsRoutes from '../routes/reviews.routes';
import reportsRoutes from '../routes/reports.routes';
import penaltiesRoutes from '../routes/penalties.routes';
import purchasesRoutes from '../routes/purchases.routes';
import agendaRoutes from '../routes/agenda.routes';
import testPanelRoutes from '../routes/testpanel.routes';
import notificationsRoutes from '../routes/notifications.routes';
import authRoutes from '../routes/auth.routes';
import clientsRoutes from '../routes/clients.routes';
import systemRoutes from '../routes/system.routes';
import paymentsRoutes from '../routes/payments.routes';
import storageRoutes from '../routes/storage.routes';
import { optionalAuth } from '../middleware/auth';

const app = express();

const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  cors(
    corsOrigins.length
      ? {
          origin: (origin, callback) => {
            if (!origin || corsOrigins.includes(origin)) {
              return callback(null, true);
            }
            return callback(new Error('Origen no permitido por CORS'));
          },
        }
      : undefined
  )
);
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);
app.use(morgan('dev'));
app.use(optionalAuth);

app.use('/streams', streamsRoutes);
app.use('/reels', reelsRoutes);
app.use('/shops', shopsRoutes);
app.use('/reviews', reviewsRoutes);
app.use('/reports', reportsRoutes);
app.use('/penalties', penaltiesRoutes);
app.use('/purchases', purchasesRoutes);
app.use('/agenda', agendaRoutes);
app.use('/testpanel', testPanelRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/auth', authRoutes);
app.use('/clients', clientsRoutes);
app.use('/system', systemRoutes);
app.use('/payments', paymentsRoutes);
app.use('/storage', storageRoutes);

export default app;
