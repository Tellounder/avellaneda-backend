import { Request, Response } from 'express';

const parseBool = (value?: string) => value === 'true' || value === '1';
const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getStatus = (_req: Request, res: Response) => {
  res.json({
    serverTime: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV || 'development',
    notifications: {
      enabled: parseBool(process.env.ENABLE_NOTIFICATION_CRON),
      intervalMinutes: parseNumber(process.env.NOTIFICATION_CRON_MINUTES, 5),
      windowMinutes: parseNumber(process.env.NOTIFICATION_WINDOW_MINUTES, 15),
    },
    sanctions: {
      enabled: parseBool(process.env.ENABLE_SANCTIONS_CRON),
      intervalMinutes: parseNumber(process.env.SANCTIONS_CRON_MINUTES, 30),
    },
    streams: {
      enabled: parseBool(process.env.ENABLE_STREAMS_CRON),
      intervalMinutes: parseNumber(process.env.STREAMS_CRON_MINUTES, 5),
    },
  });
};
