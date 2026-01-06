import { runReminderNotifications } from '../services/notifications.service';
import { runSanctionsEngine } from '../services/sanctions.service';

const parseBool = (value?: string) => value === 'true' || value === '1';

export const startSchedulers = () => {
  const enableNotifications = parseBool(process.env.ENABLE_NOTIFICATION_CRON);
  const enableSanctions = parseBool(process.env.ENABLE_SANCTIONS_CRON);
  const notificationWindow = Number(process.env.NOTIFICATION_WINDOW_MINUTES || 15);
  const notificationInterval = Number(process.env.NOTIFICATION_CRON_MINUTES || 5);
  const sanctionsInterval = Number(process.env.SANCTIONS_CRON_MINUTES || 30);

  if (enableNotifications) {
    setInterval(() => {
      runReminderNotifications(notificationWindow).catch((error) => {
        console.error('Error running notification scheduler', error);
      });
    }, Math.max(notificationInterval, 1) * 60 * 1000);
  }

  if (enableSanctions) {
    setInterval(() => {
      runSanctionsEngine().catch((error) => {
        console.error('Error running sanctions scheduler', error);
      });
    }, Math.max(sanctionsInterval, 5) * 60 * 1000);
  }
};
