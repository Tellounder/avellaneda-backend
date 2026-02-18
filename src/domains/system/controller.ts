import { Request, Response } from 'express';

const parseBool = (value?: string) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
};
const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getStatus = (_req: Request, res: Response) => {
  const timeZone = 'America/Argentina/Buenos_Aires';
  res.json({
    serverTime: new Date().toISOString(),
    serverTimeBuenosAires: new Date().toLocaleString('sv-SE', { timeZone }),
    timeZone,
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
