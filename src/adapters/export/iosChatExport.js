import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { mimeFromFilename } from '../../domain/media.js';

// iPhone exports name media "<sequence>-<TYPE>-<YYYY>-<MM>-<DD>-<hh>-<mm>-<ss>.<ext>", in the phone's local
// time. GIFs are short videos. Stickers, audio and documents are not imported.
const MEDIA_NAME = /^\d+-(PHOTO|VIDEO|GIF)-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.[a-z0-9]+$/i;

/** Parses an iPhone export media file name; null for anything that is not a photo or video. */
export function parseIosMediaName(name) {
  const match = MEDIA_NAME.exec(path.basename(name));
  if (!match) return null;
  const mimetype = mimeFromFilename(name);
  if (!mimetype) return null;
  const [, , year, month, day, hour, minute, second] = match.map(Number);
  return { mimetype, kind: mimetype.split('/')[0], localTime: { year, month, day, hour, minute, second } };
}

/** "WhatsApp Chat - Journal de la famille.zip" -> "Journal de la famille" */
export function chatNameFromPath(exportPath) {
  const match = /^WhatsApp Chat - (.+?)(\.zip)?$/i.exec(path.basename(exportPath));
  return match ? match[1].trim() : null;
}

/**
 * Opens an iPhone WhatsApp chat export, as the .zip file or an unzipped folder.
 * @returns {Promise<{chatName: string|null, media: object[], otherFiles: number, close: () => Promise<void>}>}
 *   each media item has name, mimetype, kind, localTime and open() returning a readable stream.
 */
export async function openIosExport(exportPath) {
  const stat = await fs.promises.stat(exportPath).catch(() => null);
  if (!stat) throw new Error(`Export not found: ${exportPath}`);
  const archive = stat.isDirectory() ? await openFolder(exportPath) : await openZip(exportPath);
  if (!archive.names.some(name => path.basename(name) === '_chat.txt')) {
    await archive.close();
    throw new Error(`${exportPath} is not an iPhone WhatsApp chat export (no _chat.txt)`);
  }
  const media = [];
  let otherFiles = 0;
  for (const name of archive.names) {
    if (path.basename(name) === '_chat.txt' || name.endsWith('/')) continue;
    const parsed = parseIosMediaName(name);
    if (parsed) media.push({ name: path.basename(name), ...parsed, open: () => archive.open(name) });
    else otherFiles++;
  }
  return { chatName: chatNameFromPath(exportPath), media, otherFiles, close: archive.close };
}

async function openFolder(dir) {
  const names = (await fs.promises.readdir(dir, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)));
  return { names, open: name => fs.createReadStream(path.join(dir, name)), close: async () => {} };
}

async function openZip(file) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, z) => (err ? reject(err) : resolve(z))));
  const entries = new Map();
  await new Promise((resolve, reject) => {
    zip.on('entry', entry => {
      entries.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  return {
    names: [...entries.keys()],
    open: name => new Promise((resolve, reject) =>
      zip.openReadStream(entries.get(name), (err, stream) => (err ? reject(err) : resolve(stream)))),
    close: async () => zip.close(),
  };
}
