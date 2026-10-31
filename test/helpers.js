import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteJobRepository } from '../src/adapters/sqlite/sqliteJobRepository.js';
import { FileMediaStore } from '../src/adapters/storage/fileMediaStore.js';
import { loadConfig } from '../src/config.js';

export const GROUP = '1203630@g.us';

/** Logger that records entries instead of printing them. */
export function silentLogger() {
  const entries = [];
  const make = fields => {
    const log = level => (msg, extra) => entries.push({ level, msg, ...fields, ...extra });
    return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), child: more => make({ ...fields, ...more }), entries };
  };
  return make({});
}

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-immich-test-'));
}

export function fakeMessage({ id = 'msg-1', chatId = GROUP, kind = 'image', timestamp = 1_700_000_000,
  mimetype = 'image/jpeg', data = Buffer.from('jpeg-bytes'), download } = {}) {
  return { id, chatId, kind, timestamp, download: download ?? (async () => ({ mimetype, data })) };
}

/** MediaLibrary double that records calls; set `failUpload`/`failAlbum` to an Error to make calls throw. */
export function fakeLibrary() {
  const library = {
    uploads: [],
    albumAdds: [],
    failUpload: null,
    failAlbum: null,
    async verifyAccess() {},
    async upload(req) {
      if (library.failUpload) throw library.failUpload;
      library.uploads.push(req);
      return { assetId: `asset-${library.uploads.length}`, duplicate: false };
    },
    async addToAlbum(assetId) {
      if (library.failAlbum) throw library.failAlbum;
      library.albumAdds.push(assetId);
    },
  };
  return library;
}

export function memoryJobs() {
  return new SqliteJobRepository(':memory:');
}

export function tempStore() {
  return new FileMediaStore(path.join(tempDir(), 'pending'));
}

export function testConfig(env = {}) {
  return loadConfig({ DATA_DIR: tempDir(), WHATSAPP_GROUP_ID: GROUP, BACKFILL_DELAY_MS: '0', ...env });
}
