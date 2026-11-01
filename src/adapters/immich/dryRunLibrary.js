import fs from 'node:fs';

/**
 * Stands in for Immich during a dry run: logs what would be uploaded and never writes.
 * With a `probe` (the real ImmichLibrary), verifyAccess still checks credentials, read-only.
 * @implements {import('../../core/ports.js').MediaLibrary}
 */
export class DryRunLibrary {
  /** @type {Array<{deviceAssetId: string, mimetype: string, takenAt: number, bytes: number}>} */
  planned = [];

  constructor({ albumName, logger, probe = null }) {
    Object.assign(this, { albumName, logger, probe });
  }

  async verifyAccess() {
    if (!this.probe) {
      this.logger.info('[dry-run] No Immich credentials set; skipping the Immich check');
      return;
    }
    // A dry run should still exercise the WhatsApp side when Immich is misconfigured.
    try {
      await this.probe.verifyAccess();
    } catch (err) {
      this.logger.warn('[dry-run] Immich check failed; a live run would stop here', { err });
    }
  }

  async upload({ filePath, mimetype, takenAt, deviceAssetId }) {
    const entry = { deviceAssetId, mimetype, takenAt, bytes: fs.statSync(filePath).size };
    this.planned.push(entry);
    this.logger.info('[dry-run] Would upload', {
      id: deviceAssetId, mimetype, bytes: entry.bytes, takenAt: new Date(takenAt * 1000).toISOString(), album: this.albumName,
    });
    return { assetId: `dry-run:${deviceAssetId}`, duplicate: false };
  }

  /** Read-only, so it asks the real Immich when credentials are set. */
  async findExisting(items) {
    return this.probe ? this.probe.findExisting(items) : new Map();
  }

  async addToAlbum() {}
}
