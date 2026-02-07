import 'dotenv/config';
import app from './app';
import { startSchedulers } from './scheduler';

const PORT = process.env.PORT || 3000;
const parseBool = (value?: string) => value === 'true' || value === '1';

const logFatal = (label: string) => (error: any) => {
  console.error(`[${label}]`, error);
};

process.on('unhandledRejection', logFatal('unhandledRejection'));
process.on('uncaughtException', logFatal('uncaughtException'));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (parseBool(process.env.RUN_SCHEDULERS_IN_API)) {
    startSchedulers();
  }
});
