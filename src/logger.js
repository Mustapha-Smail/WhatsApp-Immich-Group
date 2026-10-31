const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Minimal structured logger. `pretty` is for humans, `json` for log shippers (one object per line).
 * Pass `err` in fields to log an Error.
 */
export function createLogger({ level = 'info', format = 'pretty', write = line => process.stdout.write(`${line}\n`),
  fields = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const log = (lvl, msg, extra) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = { ...fields, ...serialize(extra) };
    const ts = new Date().toISOString();
    write(format === 'json'
      ? JSON.stringify({ ts, level: lvl, msg, ...entry })
      : `${ts} ${lvl.toUpperCase().padEnd(5)} ${msg}${formatFields(entry)}`);
  };
  return {
    debug: (msg, extra) => log('debug', msg, extra),
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    child: extra => createLogger({ level, format, write, fields: { ...fields, ...extra } }),
  };
}

function serialize(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) =>
    [key, value instanceof Error ? value.message : value]));
}

function formatFields(fields) {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}
