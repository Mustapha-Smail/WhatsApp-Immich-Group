import fs from 'node:fs';

/**
 * Every endpoint this adapter calls, and the API key permission each needs.
 * None are admin-only, so a regular user's scoped API key is enough.
 */
export const REQUIRED_PERMISSIONS = {
  'GET /albums': 'album.read',
  'POST /albums': 'album.create',
  'POST /assets': 'asset.upload',
  'PUT /albums/{id}/assets': 'albumAsset.create',
};

// Retrying the same request cannot fix these. 401/403 are not included: they mean the key or
// its permissions need fixing, after which retries succeed.
const PERMANENT_STATUSES = new Set([400, 413, 415, 422]);

export class ImmichError extends Error {
  constructor(message, { status, permanent = false } = {}) {
    super(message);
    this.name = 'ImmichError';
    this.status = status;
    this.permanent = permanent;
  }
}

/** @implements {import('../../core/ports.js').MediaLibrary} */
export class ImmichLibrary {
  #albumId = null;

  constructor({ url, apiKey, albumName, deviceId, timeoutMs = 120_000, fetch = globalThis.fetch, logger }) {
    Object.assign(this, { url, apiKey, albumName, deviceId, timeoutMs, fetch, logger });
  }

  async verifyAccess() {
    let albums;
    try {
      albums = await this.#request('GET', '/albums');
    } catch (err) {
      if (err.status === 401) throw new Error('Immich rejected IMMICH_API_KEY (401). Create a new key in Account Settings > API Keys.');
      if (err.status === 403) throw new Error(`IMMICH_API_KEY lacks permissions. It needs: ${Object.values(REQUIRED_PERMISSIONS).join(', ')}.`);
      throw new Error(`Cannot reach Immich at ${this.url}: ${err.message}`);
    }
    const album = albums.find(a => a.albumName === this.albumName);
    this.logger.info('Immich access verified', { album: this.albumName, albumExists: Boolean(album) });
  }

  async upload({ filePath, filename, mimetype, takenAt, deviceAssetId }) {
    const date = new Date(takenAt * 1000).toISOString();
    const form = new FormData();
    // Streamed from disk rather than loaded into memory.
    form.append('assetData', await fs.openAsBlob(filePath, { type: mimetype }), filename);
    // Required by Immich v1 and v2; v3 drops them and ignores unknown fields.
    form.append('deviceAssetId', deviceAssetId);
    form.append('deviceId', this.deviceId);
    form.append('fileCreatedAt', date);
    form.append('fileModifiedAt', date);
    const result = await this.#request('POST', '/assets', { form });
    if (!result?.id) throw new ImmichError(`Upload returned no asset id: ${JSON.stringify(result)}`);
    return { assetId: result.id, duplicate: result.status === 'duplicate' };
  }

  async addToAlbum(assetId) {
    const albumId = await this.#resolveAlbum();
    let results;
    try {
      results = await this.#request('PUT', `/albums/${albumId}/assets`, { json: { ids: [assetId] } });
    } catch (err) {
      // The album may have been deleted; look it up again on the next attempt.
      if (err.status === 400 || err.status === 404) this.#albumId = null;
      throw err;
    }
    const result = results?.find(r => r.id === assetId);
    if (result && !result.success && result.error !== 'duplicate') {
      throw new ImmichError(`Could not add asset ${assetId} to album: ${result.error ?? 'unknown error'}`);
    }
  }

  async #resolveAlbum() {
    if (this.#albumId) return this.#albumId;
    const albums = await this.#request('GET', '/albums');
    const existing = albums.find(a => a.albumName === this.albumName);
    if (existing) {
      this.#albumId = existing.id;
    } else {
      this.#albumId = (await this.#request('POST', '/albums', { json: { albumName: this.albumName } })).id;
      this.logger.info('Created Immich album', { album: this.albumName });
    }
    return this.#albumId;
  }

  async #request(method, endpoint, { json, form } = {}) {
    const headers = { 'x-api-key': this.apiKey, Accept: 'application/json' };
    let body = form;
    if (json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await this.fetch(`${this.url}/api${endpoint}`, {
      method, headers, body, signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      throw new ImmichError(`Immich ${method} ${endpoint} failed with ${res.status}: ${text}`,
        { status: res.status, permanent: PERMANENT_STATUSES.has(res.status) });
    }
    return res.status === 204 ? null : res.json();
  }
}
