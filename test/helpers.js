import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

/** Writes an uncompressed ZIP archive, enough to exercise the export reader. */
export function writeZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, ...centrals, end]));
}
