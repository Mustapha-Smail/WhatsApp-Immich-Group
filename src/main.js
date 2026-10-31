import { createApp } from './app.js';
import { assertRunnable, loadConfig } from './config.js';
import { createLogger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 25_000;

let logger = createLogger();
let app;
let shuttingDown = false;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down');
  setTimeout(() => process.exit(code || 1), SHUTDOWN_TIMEOUT_MS).unref();
  try {
    await app?.stop();
  } catch (err) {
    logger.error('Error during shutdown', { err });
    code ||= 1;
  }
  process.exit(code);
}

try {
  const config = loadConfig();
  assertRunnable(config);
  logger = createLogger(config.log);
  app = createApp(config, { logger });

  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
  process.on('unhandledRejection', err => {
    logger.error('Unhandled rejection', { err });
    shutdown(1);
  });
  // whatsapp-web.js does not reconnect by itself; exit and let Docker restart the bridge.
  app.source.onDisconnect(reason => {
    logger.error('WhatsApp disconnected; exiting so the bridge restarts', { reason });
    shutdown(1);
  });

  const result = await app.start();
  if (config.runOnce) {
    logger.info('Run complete', { status: result.status, ...result.jobs, backfill: result.backfill?.status });
    const failed = result.jobs?.failed > 0 || result.backfill?.status === 'error';
    await shutdown(failed ? 1 : 0);
  }
} catch (err) {
  logger.error('Fatal error', { err, stack: err?.cause?.stack ?? err?.stack });
  await shutdown(1);
}
