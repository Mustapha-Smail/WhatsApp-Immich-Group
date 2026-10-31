import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FIXTURE_GROUP_ID } from '../src/adapters/fixtures/fixtureSource.js';
import { ConfigError, assertRunnable, loadConfig } from '../src/config.js';

describe('config', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    assert.equal(config.dryRun, false);
    assert.equal(config.source, 'whatsapp');
    assert.equal(config.immich.albumName, 'Family WhatsApp');
    assert.equal(config.media.maxBytes, 200 * 1024 * 1024);
    assert.deepEqual(config.backfill, { enabled: true, limit: 0, once: true, delayMs: 250 });
    assert.equal(config.paths.database, path.resolve('data', 'state.sqlite'));
  });

  it('keeps dry-run state apart from real state, but shares the WhatsApp session', () => {
    const config = loadConfig({ DATA_DIR: '/srv/bridge', DRY_RUN: 'true' });
    assert.equal(config.paths.database, '/srv/bridge/dry-run/state.sqlite');
    assert.equal(config.paths.pendingDir, '/srv/bridge/dry-run/pending');
    assert.equal(config.paths.authDir, '/srv/bridge/auth');
  });

  it('strips trailing slashes from IMMICH_URL', () => {
    assert.equal(loadConfig({ IMMICH_URL: 'http://immich:2283//' }).immich.url, 'http://immich:2283');
  });

  it('reports every invalid value at once', () => {
    assert.throws(() => loadConfig({ BACKFILL_LIMIT: '-1', DRY_RUN: 'maybe', IMMICH_URL: 'immich:2283', LOG_LEVEL: 'loud' }), err => {
      assert.ok(err instanceof ConfigError);
      for (const name of ['BACKFILL_LIMIT', 'DRY_RUN', 'IMMICH_URL', 'LOG_LEVEL']) assert.match(err.message, new RegExp(name));
      return true;
    });
  });

  it('uses the fixture group when reading fixtures', () => {
    assert.equal(loadConfig({ MESSAGE_SOURCE: 'fixtures', FIXTURES_DIR: 'x' }).groupId, FIXTURE_GROUP_ID);
    assert.throws(() => loadConfig({ MESSAGE_SOURCE: 'fixtures' }), /FIXTURES_DIR/);
  });

  it('requires Immich credentials only for live runs', () => {
    assert.throws(() => assertRunnable(loadConfig({})), /IMMICH_URL and IMMICH_API_KEY/);
    assert.doesNotThrow(() => assertRunnable(loadConfig({ DRY_RUN: 'true' })));
    assert.throws(() => assertRunnable(loadConfig({ DRY_RUN: 'true', IMMICH_URL: 'http://x' })), /both/);
    assert.doesNotThrow(() => assertRunnable(loadConfig({ IMMICH_URL: 'http://x', IMMICH_API_KEY: 'k' })));
  });
});
