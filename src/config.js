import path from 'node:path';
import { FIXTURE_GROUP_ID } from './adapters/fixtures/fixtureSource.js';

export class ConfigError extends Error {
  name = 'ConfigError';
}

/** Parses and validates the environment. Reports every problem at once. */
export function loadConfig(env = process.env) {
  const errors = [];
  const str = name => env[name]?.trim() || undefined;
  const bool = (name, fallback) => {
    const raw = str(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (['true', '1', 'yes'].includes(raw)) return true;
    if (['false', '0', 'no'].includes(raw)) return false;
    errors.push(`${name} must be true or false`);
    return fallback;
  };
  const int = (name, fallback, min = 0) => {
    const raw = str(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= min) return value;
    errors.push(`${name} must be an integer >= ${min}`);
    return fallback;
  };
  const oneOf = (name, values, fallback) => {
    const raw = str(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (values.includes(raw)) return raw;
    errors.push(`${name} must be one of: ${values.join(', ')}`);
    return fallback;
  };

  const dryRun = bool('DRY_RUN', false);
  const source = oneOf('MESSAGE_SOURCE', ['whatsapp', 'fixtures'], 'whatsapp');
  const dataDir = path.resolve(str('DATA_DIR') ?? 'data');
  // Dry runs keep their own queue and state so they never mark real messages as imported.
  const stateDir = dryRun ? path.join(dataDir, 'dry-run') : dataDir;
  const fixturesDir = str('FIXTURES_DIR');
  const immichUrl = str('IMMICH_URL')?.replace(/\/+$/, '');
  if (immichUrl && !/^https?:\/\/[^/]+/.test(immichUrl)) errors.push('IMMICH_URL must start with http:// or https://');
  if (source === 'fixtures' && !fixturesDir) errors.push('FIXTURES_DIR is required when MESSAGE_SOURCE=fixtures');

  const config = {
    dryRun,
    runOnce: bool('RUN_ONCE', false),
    source,
    fixturesDir: fixturesDir && path.resolve(fixturesDir),
    groupId: str('WHATSAPP_GROUP_ID') ?? (source === 'fixtures' ? FIXTURE_GROUP_ID : undefined),
    chromiumPath: str('PUPPETEER_EXECUTABLE_PATH'),
    watchNewMessages: bool('WATCH_NEW_MESSAGES', true),
    paths: {
      dataDir,
      stateDir,
      authDir: path.join(dataDir, 'auth'),
      pendingDir: path.join(stateDir, 'pending'),
      database: path.join(stateDir, 'state.sqlite'),
    },
    immich: {
      url: immichUrl,
      apiKey: str('IMMICH_API_KEY'),
      albumName: str('ALBUM_NAME') ?? 'Family WhatsApp',
      deviceId: str('DEVICE_ID') ?? 'wa-family-bridge',
      timeoutMs: int('IMMICH_TIMEOUT_MS', 120_000, 1000),
    },
    media: { maxBytes: int('MAX_MEDIA_MB', 200, 1) * 1024 * 1024 },
    backfill: {
      enabled: bool('BACKFILL_ENABLED', true),
      limit: int('BACKFILL_LIMIT', 0),
      once: bool('BACKFILL_ONCE', true),
      delayMs: int('BACKFILL_DELAY_MS', 250),
    },
    uploads: {
      intervalMs: int('UPLOAD_INTERVAL_MS', 60_000, 1000),
      maxAttempts: int('MAX_ATTEMPTS', 8, 1),
    },
    log: {
      level: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info'),
      format: oneOf('LOG_FORMAT', ['pretty', 'json'], 'pretty'),
    },
  };
  if (errors.length) throw new ConfigError(errors.join('; '));
  return config;
}

/** Checks needed to run the bridge itself (the control CLI needs fewer). */
export function assertRunnable(config) {
  const { url, apiKey } = config.immich;
  if (!config.dryRun && !(url && apiKey)) {
    throw new ConfigError('IMMICH_URL and IMMICH_API_KEY are required (or set DRY_RUN=true)');
  }
  if (Boolean(url) !== Boolean(apiKey)) {
    throw new ConfigError('Set both IMMICH_URL and IMMICH_API_KEY, or neither (dry run only)');
  }
}
