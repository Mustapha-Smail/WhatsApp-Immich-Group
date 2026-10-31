import Database from 'better-sqlite3';

// Append-only. Index i upgrades a database from user_version i to i + 1.
const MIGRATIONS = [
  // v1: the original schema, kept so data directories from the first version upgrade in place.
  `CREATE TABLE IF NOT EXISTS jobs (
     id TEXT PRIMARY KEY,
     filename TEXT NOT NULL,
     mimetype TEXT NOT NULL,
     timestamp INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     asset_id TEXT,
     last_error TEXT
   );
   CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v2: retry bookkeeping, so failing jobs back off instead of blocking the queue.
  `ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (status, next_attempt_at, timestamp);`,
];

const PAUSED_KEY = 'paused';

/** @implements {import('../../core/ports.js').JobRepository} */
export class SqliteJobRepository {
  #db;
  #sql;

  constructor(file) {
    this.#db = new Database(file);
    this.#db.pragma('journal_mode = WAL');
    // The control CLI writes to the same file while the bridge runs.
    this.#db.pragma('busy_timeout = 5000');
    this.#migrate();
    const prepare = sql => this.#db.prepare(sql);
    this.#sql = {
      has: prepare('SELECT 1 FROM jobs WHERE id = ?'),
      enqueue: prepare(`INSERT OR IGNORE INTO jobs (id, filename, mimetype, timestamp, status)
                        VALUES (@id, @filename, @mimetype, @takenAt, 'pending')`),
      nextBatch: prepare(`SELECT * FROM jobs WHERE status IN ('pending', 'uploaded') AND next_attempt_at <= ?
                          ORDER BY timestamp, id LIMIT ?`),
      markUploaded: prepare("UPDATE jobs SET status = 'uploaded', asset_id = ?, last_error = NULL WHERE id = ?"),
      markDone: prepare("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = ?"),
      scheduleRetry: prepare('UPDATE jobs SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?'),
      markFailed: prepare("UPDATE jobs SET attempts = attempts + 1, last_error = ?, status = 'failed' WHERE id = ?"),
      retryFailed: prepare(`UPDATE jobs SET status = CASE WHEN asset_id IS NULL THEN 'pending' ELSE 'uploaded' END,
                            attempts = 0, next_attempt_at = 0 WHERE status = 'failed'`),
      stats: prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status'),
      recentErrors: prepare(`SELECT * FROM jobs WHERE last_error IS NOT NULL AND status != 'done'
                             ORDER BY timestamp DESC LIMIT ?`),
      getSetting: prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                           ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    };
  }

  #migrate() {
    const version = this.#db.pragma('user_version', { simple: true });
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.#db.transaction(() => {
        this.#db.exec(MIGRATIONS[v]);
        this.#db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  has(id) {
    return Boolean(this.#sql.has.get(id));
  }

  enqueue(job) {
    return this.#sql.enqueue.run(job).changes > 0;
  }

  nextBatch(now, limit) {
    return this.#sql.nextBatch.all(now, limit).map(toJob);
  }

  markUploaded(id, assetId) {
    this.#sql.markUploaded.run(assetId, id);
  }

  markDone(id) {
    this.#sql.markDone.run(id);
  }

  recordFailure(id, error, retryAt) {
    if (retryAt == null) this.#sql.markFailed.run(error, id);
    else this.#sql.scheduleRetry.run(error, retryAt, id);
  }

  retryFailed() {
    return this.#sql.retryFailed.run().changes;
  }

  stats() {
    const counts = { pending: 0, uploaded: 0, done: 0, failed: 0 };
    for (const { status, count } of this.#sql.stats.all()) counts[status] = count;
    return counts;
  }

  recentErrors(limit = 5) {
    return this.#sql.recentErrors.all(limit).map(toJob);
  }

  isPaused() {
    return this.getSetting(PAUSED_KEY) === 'true';
  }

  setPaused(paused) {
    this.setSetting(PAUSED_KEY, String(paused));
  }

  getSetting(key) {
    return this.#sql.getSetting.get(key)?.value;
  }

  setSetting(key, value) {
    this.#sql.setSetting.run(key, value);
  }

  close() {
    if (this.#db.open) this.#db.close();
  }
}

function toJob(row) {
  return {
    id: row.id,
    filename: row.filename,
    mimetype: row.mimetype,
    takenAt: row.timestamp,
    status: row.status,
    assetId: row.asset_id,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}
