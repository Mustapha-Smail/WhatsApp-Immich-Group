import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DryRunLibrary } from '../src/adapters/immich/dryRunLibrary.js';
import { createApp } from '../src/app.js';
import { fakeLibrary, fakeMessage, silentLogger, testConfig } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('../examples/fixtures', import.meta.url));

describe('app (end to end with test doubles)', () => {
  it('dry run with fixtures plans every image and writes nothing to Immich', async () => {
    const config = testConfig({ DRY_RUN: 'true', RUN_ONCE: 'true', MESSAGE_SOURCE: 'fixtures', FIXTURES_DIR: FIXTURES, WHATSAPP_GROUP_ID: '' });
    const app = createApp(config, { logger: silentLogger() });
    assert.ok(app.library instanceof DryRunLibrary);
    const result = await app.start();
    await app.stop();

    assert.equal(result.status, 'finished');
    assert.deepEqual(result.jobs, { pending: 0, uploaded: 0, done: 3, failed: 0 });
    assert.deepEqual(app.library.planned.map(p => p.deviceAssetId).sort(),
      ['fixture:sample-blue.jpg', 'fixture:sample-green.png', 'fixture:sample-red.png']);
    assert.ok(!fs.existsSync(path.join(config.paths.dataDir, 'state.sqlite')), 'real state must stay untouched');
  });

  it('dry runs are repeatable', async () => {
    const config = testConfig({ DRY_RUN: 'true', RUN_ONCE: 'true', MESSAGE_SOURCE: 'fixtures', FIXTURES_DIR: FIXTURES, WHATSAPP_GROUP_ID: '' });
    for (let run = 0; run < 2; run++) {
      const app = createApp(config, { logger: silentLogger() });
      await app.start();
      await app.stop();
      assert.equal(app.library.planned.length, 3);
    }
  });

  it('dry run probes Immich read-only when credentials are set', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return Response.json([]);
    };
    const config = testConfig({ DRY_RUN: 'true', RUN_ONCE: 'true', MESSAGE_SOURCE: 'fixtures', FIXTURES_DIR: FIXTURES,
      WHATSAPP_GROUP_ID: '', IMMICH_URL: 'http://immich', IMMICH_API_KEY: 'k' });
    const app = createApp(config, { logger: silentLogger(), fetch });
    await app.start();
    await app.stop();
    assert.deepEqual(calls, ['GET /api/albums']);
  });

  it('live mode imports history and new messages into the library', async () => {
    const library = fakeLibrary();
    let onMessage;
    const source = {
      onMessage: handler => { onMessage = handler; },
      onDisconnect() {},
      async connect() {},
      async listGroups() { return []; },
      async fetchHistory() { return [fakeMessage({ id: 'history' })]; },
      async disconnect() {},
    };
    const app = createApp(testConfig({ UPLOAD_INTERVAL_MS: '1000' }), { logger: silentLogger(), library, source });
    const result = await app.start();
    assert.equal(result.backfill.status, 'complete');

    onMessage(fakeMessage({ id: 'live', timestamp: 1_800_000_000 }));
    for (let i = 0; i < 50 && library.albumAdds.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await app.stop();
    assert.deepEqual(library.uploads.map(u => u.deviceAssetId), ['history', 'live']);
  });

  it('lists groups and stops when no group is configured', async () => {
    const source = {
      onMessage() {}, onDisconnect() {}, async connect() {}, async disconnect() {},
      async listGroups() { return [{ id: 'g1@g.us', name: 'Family' }]; },
    };
    const app = createApp(testConfig({ WHATSAPP_GROUP_ID: '', DRY_RUN: 'true' }), { logger: silentLogger(), source });
    assert.deepEqual(await app.start(), { status: 'needs-group', groups: [{ id: 'g1@g.us', name: 'Family' }] });
    await app.stop();
  });

  it('fails fast when Immich access is misconfigured', async () => {
    const library = { ...fakeLibrary(), verifyAccess: async () => { throw new Error('bad key'); } };
    const app = createApp(testConfig(), { logger: silentLogger(), library, source: {} });
    await assert.rejects(app.start(), /bad key/);
  });
});
