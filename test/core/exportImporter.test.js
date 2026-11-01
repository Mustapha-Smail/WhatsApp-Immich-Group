import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openIosExport } from '../../src/adapters/export/iosChatExport.js';
import { BridgeMatcher, ExportImporter } from '../../src/core/exportImporter.js';
import { fakeLibrary, memoryJobs, silentLogger, tempDir } from '../helpers.js';

const sha1 = text => crypto.createHash('sha1').update(text).digest('hex');
const at = iso => Math.floor(Date.parse(iso) / 1000);

function exportFolder(files) {
  const dir = path.join(tempDir(), 'WhatsApp Chat - Journal de la famille');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '_chat.txt'), 'chat');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const FILES = {
  // The bridge imported a photo sent at this exact second...
  '00000001-PHOTO-2023-05-14-18-22-31.jpg': 'photo-a',
  // ...but this one was sent in the same second (an album) and is missing.
  '00000002-PHOTO-2023-05-14-18-22-31.jpg': 'photo-b',
  // Immich already has this exact file (e.g. from the phone's camera roll).
  '00000003-VIDEO-2023-05-15-10-00-00.mp4': 'video-c',
  // Missing.
  '00000004-PHOTO-2023-05-16-08-00-00.jpg': 'photo-d',
  '00000005-AUDIO-2023-05-16-08-01-00.opus': 'voice note',
};

function setup({ files = FILES, existing = { [sha1('video-c')]: 'asset-existing' } } = {}) {
  const jobs = memoryJobs();
  jobs.enqueue({ id: 'bridge-1', filename: 'x.jpg', mimetype: 'image/jpeg', takenAt: at('2023-05-14T18:22:31Z') });
  jobs.markDone('bridge-1');
  const library = fakeLibrary();
  library.findExisting = async items => new Map(items.filter(i => existing[i.checksum]).map(i => [i.id, existing[i.checksum]]));
  const importer = new ExportImporter({
    openExport: openIosExport, library, jobs, workDir: path.join(tempDir(), 'work'), logger: silentLogger(),
  });
  const run = options => importer.run({ exportPath: exportFolder(files), timeZone: 'UTC', ...options });
  return { jobs, library, importer, run };
}

describe('ExportImporter', () => {
  it('imports only what is missing', async () => {
    const { library, run } = setup();
    const result = await run();
    assert.equal(result.status, 'done');
    assert.deepEqual(result.counts, { 'imported-by-bridge': 1, imported: 2, 'in-immich': 1 });
    assert.deepEqual(library.uploads.map(u => u.filename), ['00000002-PHOTO-2023-05-14-18-22-31.jpg', '00000004-PHOTO-2023-05-16-08-00-00.jpg']);
    assert.deepEqual(library.uploads.map(u => u.takenAt), [at('2023-05-14T18:22:31Z'), at('2023-05-16T08:00:00Z')]);
    assert.deepEqual(library.albumAdds, ['asset-1', 'asset-existing', 'asset-2'], 'files already in Immich are added to the album');
    assert.equal(result.info.otherFiles, 1);
  });

  it('reads file name dates in the phone time zone', async () => {
    const { library, run } = setup();
    await run({ timeZone: 'Europe/Paris' });
    // 18:22:31 in Paris is 16:22:31 UTC, which no longer matches the bridge message: both photos are imported.
    assert.deepEqual(library.uploads.map(u => u.takenAt), [at('2023-05-14T16:22:31Z'), at('2023-05-14T16:22:31Z'), at('2023-05-16T06:00:00Z')]);
  });

  it('does nothing new when run again', async () => {
    const { library, importer, run } = setup();
    await run();
    const again = await importer.run({ exportPath: exportFolder(FILES), timeZone: 'UTC' });
    assert.deepEqual(again.counts, { 'already-imported': 4 });
    assert.equal(library.uploads.length, 2);
  });

  it('dry run reports without uploading, changing the album or recording anything', async () => {
    const { library, jobs, run } = setup();
    const dry = await run({ dryRun: true });
    assert.deepEqual(dry.counts, { 'imported-by-bridge': 1, imported: 2, 'in-immich': 1 });
    assert.equal(library.uploads.length, 0);
    assert.equal(library.albumAdds.length, 0);
    assert.equal(jobs.exportItem(sha1('photo-d')), undefined);
  });

  it('retries failed files on the next run', async () => {
    const { library, run, importer } = setup();
    library.failUpload = new Error('Immich down');
    const first = await run();
    assert.equal(first.status, 'partial');
    assert.equal(first.counts.failed, 2);

    library.failUpload = null;
    const second = await importer.run({ exportPath: exportFolder(FILES), timeZone: 'UTC' });
    assert.deepEqual(second.counts, { 'already-imported': 2, imported: 2 });
  });

  it('imports identical files in one export once', async () => {
    const { library, run } = setup({
      files: { '00000010-PHOTO-2023-06-01-10-00-00.jpg': 'same', '00000011-PHOTO-2023-06-02-10-00-00.jpg': 'same' }, existing: {},
    });
    const result = await run();
    assert.deepEqual(result.counts, { imported: 1, 'already-imported': 1 });
    assert.equal(library.uploads.length, 1);
  });

  it('stops when the import is not confirmed', async () => {
    const { library, run } = setup();
    const result = await run({ confirm: async info => { assert.equal(info.chatName, 'Journal de la famille'); return false; } });
    assert.equal(result.status, 'cancelled');
    assert.equal(library.uploads.length, 0);
  });

  it('cleans up extracted files', async () => {
    const { importer, run } = setup();
    await run();
    assert.deepEqual(fs.readdirSync(importer.workDir), []);
  });
});

describe('BridgeMatcher', () => {
  it('matches each bridge message once, by kind, within two seconds', () => {
    const matcher = new BridgeMatcher([{ timestamp: 100, kind: 'image' }, { timestamp: 100, kind: 'image' }, { timestamp: 200, kind: 'video' }]);
    assert.equal(matcher.consume(101, 'image'), true);
    assert.equal(matcher.consume(100, 'image'), true);
    assert.equal(matcher.consume(100, 'image'), false, 'only two photos were sent at that time');
    assert.equal(matcher.consume(200, 'image'), false, 'kind must match');
    assert.equal(matcher.consume(203, 'video'), false, 'more than two seconds apart');
    assert.equal(matcher.consume(198, 'video'), true);
  });
});
