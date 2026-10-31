import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Backfill } from '../../src/core/backfill.js';
import { MediaImporter } from '../../src/core/mediaImporter.js';
import { GROUP, fakeMessage, memoryJobs, silentLogger, tempStore } from '../helpers.js';

function setup(messages, options = {}) {
  const jobs = memoryJobs();
  const importer = new MediaImporter({ groupId: GROUP, maxBytes: 1e6, jobs, store: tempStore(), logger: silentLogger() });
  const source = { fetches: 0, async fetchHistory() { this.fetches++; return [...messages]; } };
  const backfill = new Backfill({ source, importer, jobs, logger: silentLogger(), groupId: GROUP, sleep: async () => {}, ...options });
  return { jobs, source, backfill };
}

describe('Backfill', () => {
  it('imports media oldest first and records completion', async () => {
    const { jobs, backfill } = setup([
      fakeMessage({ id: 'b', timestamp: 20 }),
      fakeMessage({ id: 'a', timestamp: 10 }),
      fakeMessage({ id: 'x', chatId: 'other@g.us' }),
    ]);
    const result = await backfill.run();
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.outcomes, { queued: 2, ignored: 1 });
    assert.deepEqual(jobs.nextBatch(Date.now(), 10).map(j => j.id), ['a', 'b']);
    assert.equal(jobs.getSetting(backfill.marker), 'complete');
  });

  it('runs once unless BACKFILL_ONCE is off', async () => {
    const { source, backfill } = setup([fakeMessage()]);
    await backfill.run();
    assert.deepEqual(await backfill.run(), { status: 'already-complete' });
    assert.equal(source.fetches, 1);

    backfill.once = false;
    const rescan = await backfill.run();
    assert.deepEqual(rescan.outcomes, { known: 1 });
    assert.equal(source.fetches, 2);
  });

  it('does not mark the scan complete when a download failed', async () => {
    const { jobs, backfill } = setup([fakeMessage({ download: async () => { throw new Error('timeout'); } })]);
    assert.equal((await backfill.run()).status, 'incomplete');
    assert.equal(jobs.getSetting(backfill.marker), undefined);
  });

  it('does nothing when disabled', async () => {
    const { source, backfill } = setup([fakeMessage()], { enabled: false });
    assert.deepEqual(await backfill.run(), { status: 'disabled' });
    assert.equal(source.fetches, 0);
  });

  it('waits while paused', async () => {
    let polls = 0;
    const { jobs, backfill } = setup([fakeMessage()], {
      sleep: async () => { if (++polls === 3) jobs.setPaused(false); },
    });
    jobs.setPaused(true);
    const result = await backfill.run();
    assert.equal(polls, 3);
    assert.equal(result.outcomes.queued, 1);
  });

  it('paces only messages that hit WhatsApp', async () => {
    let sleeps = 0;
    const { backfill } = setup([fakeMessage({ id: 'a' }), fakeMessage({ id: 'b', chatId: 'other@g.us' })], {
      delayMs: 100, sleep: async () => { sleeps++; },
    });
    await backfill.run();
    assert.equal(sleeps, 1);
  });
});
