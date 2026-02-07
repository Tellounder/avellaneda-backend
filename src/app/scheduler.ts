import { runReminderNotifications } from '../domains/notifications/service';
import { runSanctionsEngine } from '../services/sanctions.service';
import { runStreamLifecycle } from '../domains/streams/service';

const parseBool = (value?: string) => value === 'true' || value === '1';

const buildLockedJob = (name: string, task: () => Promise<unknown>) => {
  let isRunning = false;
  return async () => {
    if (isRunning) {
      console.log(`[scheduler] ${name}: omitido, ciclo anterior sigue en ejecucion`);
      return;
    }
    isRunning = true;
    try {
      await task();
    } catch (error) {
      console.error(`[scheduler] ${name}: error`, error);
    } finally {
      isRunning = false;
    }
  };
};

export const startSchedulers = () => {
  const enableNotifications = parseBool(process.env.ENABLE_NOTIFICATION_CRON);
  const enableSanctions = parseBool(process.env.ENABLE_SANCTIONS_CRON);
  const enableStreams = parseBool(process.env.ENABLE_STREAMS_CRON);
  const notificationWindow = Number(process.env.NOTIFICATION_WINDOW_MINUTES || 15);
  const notificationInterval = Number(process.env.NOTIFICATION_CRON_MINUTES || 5);
  const sanctionsInterval = Number(process.env.SANCTIONS_CRON_MINUTES || 30);
  const streamsInterval = Number(process.env.STREAMS_CRON_MINUTES || 5);

  if (enableNotifications) {
    const runNotificationsJob = buildLockedJob('notifications', () =>
      runReminderNotifications(notificationWindow)
    );
    void runNotificationsJob();
    setInterval(() => {
      void runNotificationsJob();
    }, Math.max(notificationInterval, 1) * 60 * 1000);
  }

  if (enableSanctions) {
    const runSanctionsJob = buildLockedJob('sanctions', runSanctionsEngine);
    void runSanctionsJob();
    setInterval(() => {
      void runSanctionsJob();
    }, Math.max(sanctionsInterval, 5) * 60 * 1000);
  }

  if (enableStreams) {
    const runStreamsJob = buildLockedJob('streams-lifecycle', runStreamLifecycle);
    void runStreamsJob();
    setInterval(() => {
      void runStreamsJob();
    }, Math.max(streamsInterval, 1) * 60 * 1000);
  }
};
