import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ImmichError } from '../../src/adapters/immich/immichLibrary.js';
import { UploadWorker, defaultBackoff } from '../../src/core/uploadWorker.js';
import { fakeLibrary, memoryJobs, silentLogger, tempStore } from '../helpers.js';

async function setup({ count = 1, ...options } = {}) {
  const jobs = memoryJobs();
  const store = tempStore();
  const library = fakeLibrary();
  let clock = 1_000_000;
  for (let i = 1; i <= count; i++) {
    await store.save(`f${i}.jpg`, Buffer.from(`data-${i}`));
    jobs.enqueue({ id: `m${i}`, filename: `f${i}.jpg`, mimetype: 'image/jpeg', takenAt: i });
  }
  const worker = new UploadWorker({ jobs, store, library, logger: silentLogger(), now: () => clock, ...options });
  return { jobs, store, library, worker, advance: ms => { clock += ms; } };
}

describe('UploadWorker', () => {
  it('uploads, adds to the album, then deletes the local file', async () => {
    const { jobs, store, library, worker } = await setup({ count: 2 });
    await worker.drain();
    assert.deepEqual(library.uploads.map(u => [u.deviceAssetId, u.takenAt, u.mimetype]), [['m1', 1, 'image/jpeg'], ['m2', 2, 'image/jpeg']]);
    assert.deepEqual(library.albumAdds, ['asset-1', 'asset-2']);
    assert.deepEqual(jobs.stats(), { pending: 0, uploaded: 0, done: 2, failed: 0 });
    assert.ok(!store.exists('f1.jpg'));
  });

  it('does not upload again when only the album step failed', async () => {
    const { jobs, library, worker, advance } = await setup();
    library.failAlbum = new Error('album unavailable');
    await worker.drain();
    assert.equal(library.uploads.length, 1);
    assert.equal(jobs.stats().uploaded, 1);

    library.failAlbum = null;
    advance(defaultBackoff(1));
    await worker.drain();
    assert.equal(library.uploads.length, 1);
    assert.deepEqual(library.albumAdds, ['asset-1']);
    assert.equal(jobs.stats().done, 1);
  });

  it('backs off between retries and gives up after maxAttempts', async () => {
    const { jobs, library, worker, advance } = await setup({ maxAttempts: 3 });
    library.failUpload = new Error('Immich down');
    await worker.drain();
    await worker.drain(); // not due yet
    assert.equal(jobs.recentErrors()[0].attempts, 1);
    advance(defaultBackoff(1));
    await worker.drain();
    advance(defaultBackoff(2));
    await worker.drain();
    assert.equal(jobs.stats().failed, 1);
    assert.equal(jobs.recentErrors()[0].attempts, 3);
  });

  it('fails permanently on errors retrying cannot fix', async () => {
    const { jobs, library, worker } = await setup();
    library.failUpload = new ImmichError('unsupported file', { status: 400, permanent: true });
    await worker.drain();
    assert.equal(jobs.stats().failed, 1);
  });

  it('fails permanently when the local file is missing', async () => {
    const { jobs, store, library, worker } = await setup();
    await store.remove('f1.jpg');
    await worker.drain();
    assert.equal(library.uploads.length, 0);
    assert.match(jobs.recentErrors()[0].lastError, /missing/);
    assert.equal(jobs.stats().failed, 1);
  });

  it('does not let failing jobs block newer ones', async () => {
    const { jobs, library, worker } = await setup({ count: 3, batchSize: 1 });
    let calls = 0;
    library.upload = async req => {
      if (++calls <= 2) throw new Error('flaky');
      return { assetId: `asset-${req.deviceAssetId}`, duplicate: false };
    };
    await worker.drain();
    assert.deepEqual(jobs.stats(), { pending: 2, uploaded: 0, done: 1, failed: 0 });
  });

  it('sends nothing while paused and continues after resume', async () => {
    const { jobs, library, worker } = await setup({ count: 2 });
    jobs.setPaused(true);
    await worker.drain();
    assert.equal(library.uploads.length, 0);
    jobs.setPaused(false);
    await worker.drain();
    assert.equal(library.uploads.length, 2);
  });

  it('stops between jobs when paused mid-drain', async () => {
    const { jobs, library, worker } = await setup({ count: 3 });
    const upload = library.upload;
    library.upload = async req => {
      jobs.setPaused(true);
      return upload(req);
    };
    await worker.drain();
    assert.equal(library.uploads.length, 1);
    assert.deepEqual(jobs.stats(), { pending: 2, uploaded: 0, done: 1, failed: 0 });
  });

  it('shares one run between concurrent drains and catches late arrivals', async () => {
    const { jobs, store, library, worker } = await setup();
    await store.save('late.jpg', Buffer.from('late'));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const upload = library.upload;
    library.upload = async req => {
      await gate;
      return upload(req);
    };
    const first = worker.drain();
    // The first run already fetched its batch; this job arrives while it is uploading.
    jobs.enqueue({ id: 'late', filename: 'late.jpg', mimetype: 'image/jpeg', takenAt: 9 });
    const second = worker.drain();
    assert.equal(first, second);
    release();
    await first;
    assert.equal(library.uploads.length, 2);
  });
});
