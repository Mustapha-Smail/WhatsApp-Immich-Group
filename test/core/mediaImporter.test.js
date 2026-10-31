import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { MediaImporter } from '../../src/core/mediaImporter.js';
import { GROUP, fakeMessage, memoryJobs, silentLogger, tempStore } from '../helpers.js';

function setup(overrides = {}) {
  const jobs = memoryJobs();
  const store = tempStore();
  let queued = 0;
  const importer = new MediaImporter({
    groupId: GROUP, maxBytes: 1000, jobs, store, logger: silentLogger(), onQueued: () => queued++, ...overrides,
  });
  return { jobs, store, importer, queued: () => queued };
}

describe('MediaImporter', () => {
  it('stores the media and queues a job', async () => {
    const { jobs, store, importer, queued } = setup();
    assert.equal(await importer.handle(fakeMessage({ mimetype: 'image/jpeg; charset=binary' })), 'queued');
    const [job] = jobs.nextBatch(Date.now(), 10);
    assert.equal(job.id, 'msg-1');
    assert.equal(job.mimetype, 'image/jpeg');
    assert.equal(job.takenAt, 1_700_000_000);
    assert.equal(fs.readFileSync(store.pathOf(job.filename), 'utf8'), 'jpeg-bytes');
    assert.equal(queued(), 1);
  });

  it('ignores other chats and non-photo/video messages', async () => {
    const { importer } = setup();
    assert.equal(await importer.handle(fakeMessage({ chatId: 'other@g.us' })), 'ignored');
    assert.equal(await importer.handle(fakeMessage({ kind: 'sticker' })), 'ignored');
    assert.equal(await importer.handle(fakeMessage({ kind: 'document' })), 'ignored');
  });

  it('skips unavailable, unsupported and oversized media', async () => {
    const { importer, jobs } = setup();
    assert.equal(await importer.handle(fakeMessage({ id: 'a', download: async () => null })), 'unavailable');
    assert.equal(await importer.handle(fakeMessage({ id: 'b', mimetype: 'image/x-weird' })), 'unsupported');
    assert.equal(await importer.handle(fakeMessage({ id: 'c', data: Buffer.alloc(1001) })), 'too_large');
    assert.deepEqual(jobs.stats(), { pending: 0, uploaded: 0, done: 0, failed: 0 });
  });

  it('reports download errors without throwing, so a later scan can retry', async () => {
    const { importer, jobs } = setup();
    const outcome = await importer.handle(fakeMessage({ download: async () => { throw new Error('network'); } }));
    assert.equal(outcome, 'failed');
    assert.ok(!jobs.has('msg-1'));
  });

  it('downloads a message only once, even when live and backfill race', async () => {
    const { importer } = setup();
    let downloads = 0;
    const message = fakeMessage({
      download: async () => {
        downloads++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { mimetype: 'image/png', data: Buffer.from('x') };
      },
    });
    const outcomes = await Promise.all([importer.handle(message), importer.handle(message)]);
    assert.deepEqual(outcomes.sort(), ['known', 'queued']);
    assert.equal(await importer.handle(message), 'known');
    assert.equal(downloads, 1);
  });
});
