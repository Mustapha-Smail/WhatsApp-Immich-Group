import { SUPPORTED_KINDS, isSupportedMime, normalizeMime, storageNameFor } from '../domain/media.js';

/**
 * Turns an incoming message into a queued upload job: filter, download, store locally, enqueue.
 * Shared by live messages and backfill, so the same message is never processed twice.
 */
export class MediaImporter {
  #inFlight = new Set();

  /**
   * @param {object} deps
   * @param {string} deps.groupId
   * @param {number} deps.maxBytes
   * @param {import('./ports.js').JobRepository} deps.jobs
   * @param {import('./ports.js').MediaStore} deps.store
   * @param {object} deps.logger
   * @param {() => void} [deps.onQueued]
   */
  constructor({ groupId, maxBytes, jobs, store, logger, onQueued = () => {} }) {
    Object.assign(this, { groupId, maxBytes, jobs, store, logger, onQueued });
  }

  /**
   * Never throws.
   * @param {import('./ports.js').IncomingMessage} message
   * @returns {Promise<'queued'|'ignored'|'known'|'unavailable'|'unsupported'|'too_large'|'failed'>}
   */
  async handle(message) {
    if (message.chatId !== this.groupId || !SUPPORTED_KINDS.has(message.kind)) return 'ignored';
    // In-memory reservation stops concurrent duplicates; SQLite is the durable dedupe.
    if (this.#inFlight.has(message.id) || this.jobs.has(message.id)) return 'known';
    this.#inFlight.add(message.id);
    try {
      return await this.#import(message);
    } catch (err) {
      this.logger.warn('Media download failed; a later backfill can retry it', { id: message.id, err });
      return 'failed';
    } finally {
      this.#inFlight.delete(message.id);
    }
  }

  async #import(message) {
    const media = await message.download();
    if (!media) {
      this.logger.warn('Media no longer available', { id: message.id });
      return 'unavailable';
    }
    if (!isSupportedMime(media.mimetype)) {
      this.logger.warn('Skipping unsupported media type', { id: message.id, mimetype: media.mimetype });
      return 'unsupported';
    }
    if (media.data.length > this.maxBytes) {
      this.logger.warn('Skipping oversized media', { id: message.id, bytes: media.data.length });
      return 'too_large';
    }
    const mimetype = normalizeMime(media.mimetype);
    const filename = storageNameFor(message.id, mimetype);
    await this.store.save(filename, media.data);
    this.jobs.enqueue({ id: message.id, filename, mimetype, takenAt: message.timestamp });
    this.logger.info('Queued media', { id: message.id, mimetype, bytes: media.data.length });
    this.onQueued();
    return 'queued';
  }
}
