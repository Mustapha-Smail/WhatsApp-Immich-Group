import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { errorMessage } from '../domain/errors.js';
import { localToUtc } from '../domain/time.js';

const BATCH_SIZE = 50;
// Export file names and message timestamps can disagree by a second.
const SAME_MESSAGE_SECONDS = 2;

/**
 * Imports the media from a phone chat export that is not in Immich yet.
 *
 * A file counts as already there, and is not uploaded, when:
 *   1. an earlier run of this import uploaded it (recorded by content),
 *   2. Immich already has the exact same file (it is still added to the album), or
 *   3. the bridge already imported a photo/video of the same kind sent at the same second.
 *      Matched one to one, so several photos sent at once are not skipped wrongly.
 * Everything else is uploaded with the date it was sent and added to the album.
 */
export class ExportImporter {
  /**
   * @param {object} deps
   * @param {(path: string) => Promise<object>} deps.openExport
   * @param {import('./ports.js').MediaLibrary} deps.library
   * @param {object} deps.jobs  JobRepository with exportItem/recordExportItem/bridgeMedia
   * @param {string} deps.workDir  scratch directory for extracted files
   */
  constructor({ openExport, library, jobs, workDir, logger }) {
    Object.assign(this, { openExport, library, jobs, workDir, logger });
  }

  /**
   * @param {object} options
   * @param {string} options.exportPath
   * @param {string} options.timeZone  the phone's time zone, for the dates in file names
   * @param {boolean} [options.dryRun]  report only: no uploads, album changes or records
   * @param {(info: object) => Promise<boolean>} [options.confirm]
   */
  async run({ exportPath, timeZone, dryRun = false, confirm = async () => true }) {
    const exp = await this.openExport(exportPath);
    try {
      const media = exp.media
        .map(item => ({ ...item, takenAt: Math.floor(localToUtc(item.localTime, timeZone) / 1000) }))
        .sort((a, b) => a.takenAt - b.takenAt);
      const info = {
        chatName: exp.chatName, media: media.length, otherFiles: exp.otherFiles,
        photos: media.filter(m => m.kind === 'image').length, videos: media.filter(m => m.kind === 'video').length,
        from: media[0] && new Date(media[0].takenAt * 1000).toISOString(),
        to: media.at(-1) && new Date(media.at(-1).takenAt * 1000).toISOString(),
      };
      this.logger.info('Opened chat export', { ...info, timeZone, dryRun });
      if (!media.length) return { status: 'empty', info, counts: {} };
      if (!(await confirm(info))) return { status: 'cancelled', info, counts: {} };

      fs.mkdirSync(this.workDir, { recursive: true });
      const bridge = new BridgeMatcher(this.jobs.bridgeMedia());
      const counts = {};
      const seen = new Set(); // dry runs record nothing, so remember duplicates within the export here
      for (let i = 0; i < media.length; i += BATCH_SIZE) {
        await this.#importBatch(media.slice(i, i + BATCH_SIZE), { bridge, counts, seen, dryRun });
        this.logger.info('Export import progress', { processed: Math.min(i + BATCH_SIZE, media.length), total: media.length, ...counts });
      }
      return { status: counts.failed ? 'partial' : 'done', info, counts };
    } finally {
      await exp.close();
    }
  }

  async #importBatch(items, { bridge, counts, seen, dryRun }) {
    const count = outcome => { counts[outcome] = (counts[outcome] ?? 0) + 1; };
    const pending = [];
    for (const item of items) {
      try {
        const file = await this.#extract(item);
        const previous = this.jobs.exportItem(file.sha1);
        if (seen.has(file.sha1) || previous?.status === 'imported' || previous?.status === 'in-immich'
          || previous?.status === 'imported-by-bridge') {
          // Keep its bridge message claimed, or another photo from the same second could take it.
          if (previous?.status === 'imported-by-bridge') bridge.consume(item.takenAt, item.kind);
          count('already-imported');
          await fs.promises.rm(file.path, { force: true });
          continue;
        }
        seen.add(file.sha1);
        pending.push({ item, file });
      } catch (err) {
        count('failed');
        this.logger.warn('Could not read file from export', { name: item.name, err });
      }
    }

    const existing = await this.library.findExisting(pending.map(({ file }) => ({ id: file.sha1, checksum: file.sha1 })));
    for (const { item, file } of pending) {
      try {
        const record = (status, assetId) => {
          count(status);
          if (!dryRun) this.jobs.recordExportItem({ sha1: file.sha1, name: item.name, takenAt: item.takenAt, status, assetId });
        };
        const assetId = existing.get(file.sha1);
        if (assetId) {
          if (!dryRun) await this.library.addToAlbum(assetId);
          record('in-immich', assetId);
        } else if (bridge.consume(item.takenAt, item.kind)) {
          record('imported-by-bridge', null);
        } else if (dryRun) {
          this.logger.info('[dry-run] Would import', { name: item.name, takenAt: new Date(item.takenAt * 1000).toISOString() });
          count('imported');
        } else {
          const uploaded = await this.library.upload({
            filePath: file.path, filename: item.name, mimetype: item.mimetype, takenAt: item.takenAt,
            deviceAssetId: `export:${file.sha1}`,
          });
          await this.library.addToAlbum(uploaded.assetId);
          record('imported', uploaded.assetId);
        }
      } catch (err) {
        count('failed');
        this.logger.warn('Could not import file; run the import again to retry', { name: item.name, err: errorMessage(err) });
      } finally {
        await fs.promises.rm(file.path, { force: true });
      }
    }
  }

  /** Copies an export entry to the work dir, hashing it on the way. */
  async #extract(item) {
    const hash = crypto.createHash('sha1');
    const filePath = `${this.workDir}/${crypto.randomUUID()}-${item.name}`;
    await pipeline(await item.open(), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    }, fs.createWriteStream(filePath));
    return { path: filePath, sha1: hash.digest('hex') };
  }
}

/** One-to-one matching of export items against messages the bridge already imported. */
export class BridgeMatcher {
  #byKind = new Map();

  constructor(bridgeMedia) {
    for (const { timestamp, kind } of bridgeMedia) {
      if (!this.#byKind.has(kind)) this.#byKind.set(kind, []);
      this.#byKind.get(kind).push(timestamp);
    }
    for (const times of this.#byKind.values()) times.sort((a, b) => a - b);
  }

  /** Claims a bridge message of `kind` sent within a couple of seconds of `takenAt`, if any is left. */
  consume(takenAt, kind) {
    const times = this.#byKind.get(kind);
    if (!times) return false;
    let best = -1;
    for (let i = 0; i < times.length; i++) {
      const distance = Math.abs(times[i] - takenAt);
      if (distance <= SAME_MESSAGE_SECONDS && (best < 0 || distance < Math.abs(times[best] - takenAt))) best = i;
      if (times[i] > takenAt + SAME_MESSAGE_SECONDS) break;
    }
    if (best < 0) return false;
    times.splice(best, 1);
    return true;
  }
}
