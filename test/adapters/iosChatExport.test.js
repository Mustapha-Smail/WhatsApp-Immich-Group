import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { chatNameFromPath, openIosExport, parseIosMediaName } from '../../src/adapters/export/iosChatExport.js';
import { tempDir, writeZip } from '../helpers.js';

const exportFiles = {
  '_chat.txt': '[14/05/2023 18:22:31] Mustapha: ‎<attached: 00000005-PHOTO-2023-05-14-18-22-31.jpg>\n',
  '00000005-PHOTO-2023-05-14-18-22-31.jpg': 'jpeg-bytes',
  '00000006-VIDEO-2023-05-14-18-25-02.mp4': 'mp4-bytes',
  '00000007-GIF-2023-05-15-09-00-00.mp4': 'gif-bytes',
  '00000008-AUDIO-2023-05-15-09-01-00.opus': 'voice',
  '00000009-STICKER-2023-05-15-09-02-00.webp': 'sticker',
  'Invoice.pdf': 'pdf',
};

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

describe('parseIosMediaName', () => {
  it('reads type and local send time from iPhone export file names', () => {
    assert.deepEqual(parseIosMediaName('00000005-PHOTO-2023-05-14-18-22-31.jpg'), {
      mimetype: 'image/jpeg', kind: 'image', localTime: { year: 2023, month: 5, day: 14, hour: 18, minute: 22, second: 31 },
    });
    assert.equal(parseIosMediaName('00000007-GIF-2023-05-15-09-00-00.mp4').kind, 'video');
  });

  it('ignores voice notes, stickers and documents', () => {
    assert.equal(parseIosMediaName('00000008-AUDIO-2023-05-15-09-01-00.opus'), null);
    assert.equal(parseIosMediaName('00000009-STICKER-2023-05-15-09-02-00.webp'), null);
    assert.equal(parseIosMediaName('Invoice.pdf'), null);
  });
});

describe('chatNameFromPath', () => {
  it('reads the group name from the export name', () => {
    assert.equal(chatNameFromPath('/data/imports/WhatsApp Chat - Journal de la famille.zip'), 'Journal de la famille');
    assert.equal(chatNameFromPath('/data/imports/WhatsApp Chat - Journal de la famille'), 'Journal de la famille');
    assert.equal(chatNameFromPath('/data/imports/export.zip'), null);
  });
});

describe('openIosExport', () => {
  for (const kind of ['zip', 'folder']) {
    it(`lists photos and videos from a ${kind}`, async () => {
      const dir = tempDir();
      let exportPath = path.join(dir, 'WhatsApp Chat - Journal de la famille');
      if (kind === 'zip') {
        exportPath += '.zip';
        writeZip(exportPath, exportFiles);
      } else {
        fs.mkdirSync(exportPath);
        for (const [name, content] of Object.entries(exportFiles)) fs.writeFileSync(path.join(exportPath, name), content);
      }
      const exp = await openIosExport(exportPath);
      try {
        assert.equal(exp.chatName, 'Journal de la famille');
        assert.deepEqual(exp.media.map(m => m.name).sort(), [
          '00000005-PHOTO-2023-05-14-18-22-31.jpg', '00000006-VIDEO-2023-05-14-18-25-02.mp4', '00000007-GIF-2023-05-15-09-00-00.mp4',
        ]);
        assert.equal(exp.otherFiles, 3);
        const photo = exp.media.find(m => m.kind === 'image');
        assert.equal(await readAll(await photo.open()), 'jpeg-bytes');
      } finally {
        await exp.close();
      }
    });
  }

  it('refuses files that are not chat exports', async () => {
    const file = path.join(tempDir(), 'photos.zip');
    writeZip(file, { 'IMG_0001.jpg': 'x' });
    await assert.rejects(openIosExport(file), /not an iPhone WhatsApp chat export/);
    await assert.rejects(openIosExport(path.join(tempDir(), 'missing.zip')), /not found/);
  });
});
