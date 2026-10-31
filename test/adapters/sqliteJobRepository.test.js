import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteJobRepository } from '../../src/adapters/sqlite/sqliteJobRepository.js';
import { memoryJobs, tempDir } from '../helpers.js';

const job = (id, takenAt = 100) => ({ id, filename: `${id}.jpg`, mimetype: 'image/jpeg', takenAt });

describe('SqliteJobRepository', () => {
  it('enqueues each message once', () => {
    const jobs = memoryJobs();
    assert.equal(jobs.enqueue(job('a')), true);
    assert.equal(jobs.enqueue(job('a')), false);
    assert.ok(jobs.has('a'));
    assert.ok(!jobs.has('b'));
  });

  it('returns due jobs oldest first and skips done or failed ones', () => {
    const jobs = memoryJobs();
    jobs.enqueue(job('new', 300));
    jobs.enqueue(job('old', 100));
    jobs.enqueue(job('done', 50));
    jobs.enqueue(job('dead', 60));
    jobs.markDone('done');
    jobs.recordFailure('dead', 'boom', null);
    assert.deepEqual(jobs.nextBatch(Date.now(), 10).map(j => j.id), ['old', 'new']);
  });

  it('hides a retrying job until its retry time', () => {
    const jobs = memoryJobs();
    jobs.enqueue(job('a'));
    jobs.recordFailure('a', 'timeout', 5000);
    assert.equal(jobs.nextBatch(4999, 10).length, 0);
    const [due] = jobs.nextBatch(5000, 10);
    assert.equal(due.attempts, 1);
    assert.equal(due.lastError, 'timeout');
  });

  it('keeps the asset id through failures and restores the right step on retry', () => {
    const jobs = memoryJobs();
    jobs.enqueue(job('a'));
    jobs.markUploaded('a', 'asset-1');
    jobs.recordFailure('a', 'album gone', null);
    assert.deepEqual(jobs.stats(), { pending: 0, uploaded: 0, done: 0, failed: 1 });
    assert.equal(jobs.retryFailed(), 1);
    const [retried] = jobs.nextBatch(0, 10);
    assert.equal(retried.status, 'uploaded');
    assert.equal(retried.assetId, 'asset-1');
    assert.equal(retried.attempts, 0);
  });

  it('stores the pause flag and settings', () => {
    const jobs = memoryJobs();
    assert.equal(jobs.isPaused(), false);
    jobs.setPaused(true);
    assert.equal(jobs.isPaused(), true);
    jobs.setSetting('k', 'v1');
    jobs.setSetting('k', 'v2');
    assert.equal(jobs.getSetting('k'), 'v2');
  });

  it('upgrades a database created by the first version of the bridge', () => {
    const file = path.join(tempDir(), 'state.sqlite');
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mimetype TEXT NOT NULL,
      timestamp INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', asset_id TEXT, last_error TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO jobs (id, filename, mimetype, timestamp) VALUES ('old', 'old.jpg', 'image/jpeg', 1);
      INSERT INTO settings VALUES ('backfill:v2:g@g.us:0', 'complete');`);
    legacy.close();

    const jobs = new SqliteJobRepository(file);
    assert.deepEqual(jobs.nextBatch(0, 10).map(j => [j.id, j.attempts]), [['old', 0]]);
    assert.equal(jobs.getSetting('backfill:v2:g@g.us:0'), 'complete');
    jobs.close();
    new SqliteJobRepository(file).close(); // reopening must not re-run migrations
  });
});
