import { runReminderNotifications } from '../domains/notifications/service';
import { runSanctionsEngine } from '../services/sanctions.service';
import { runStreamLifecycle } from '../domains/streams/service';

const parseBool = (value?: string) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
};

interface SchedulerOptions {
  forceEnableStreams?: boolean;
}

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

export const startSchedulers = (options: SchedulerOptions = {}) => {
  const enableNotifications = parseBool(process.env.ENABLE_NOTIFICATION_CRON);
  const enableSanctions = parseBool(process.env.ENABLE_SANCTIONS_CRON);
  const enableStreams = options.forceEnableStreams || parseBool(process.env.ENABLE_STREAMS_CRON);
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
    console.log(
      `[scheduler] streams-lifecycle: enabled interval=${Math.max(streamsInterval, 1)}m source=${
        options.forceEnableStreams ? 'forced' : 'env'
      }`
    );
    const runStreamsJob = buildLockedJob('streams-lifecycle', async () => {
      const result = await runStreamLifecycle();
      if (result.started > 0 || result.finished > 0) {
        console.log(
          `[scheduler] streams-lifecycle: started=${result.started} finished=${result.finished} at=${new Date().toISOString()}`
        );
      }
    });
    void runStreamsJob();
    setInterval(() => {
      void runStreamsJob();
    }, Math.max(streamsInterval, 1) * 60 * 1000);
  } else {
    console.log('[scheduler] streams-lifecycle: disabled');
  }
};
