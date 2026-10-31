import { PermanentError, errorMessage, isPermanent } from '../domain/errors.js';

/** 30s, 1m, 2m, 4m ... capped at 1h. */
export const defaultBackoff = attempt => Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);

/**
 * Drains the job queue into the media library. Each job runs in two persisted steps
 * (upload, then add to album) so a crash in between never re-uploads the file.
 * Checks the pause flag before every job.
 */
export class UploadWorker {
  #running = null;
  #rerun = false;
  #stopped = false;
  #timer = null;

  /**
   * @param {object} deps
   * @param {import('./ports.js').JobRepository} deps.jobs
   * @param {import('./ports.js').MediaStore} deps.store
   * @param {import('./ports.js').MediaLibrary} deps.library
   * @param {object} deps.logger
   */
  constructor({ jobs, store, library, logger, maxAttempts = 8, batchSize = 25, intervalMs = 60_000,
    backoff = defaultBackoff, now = Date.now }) {
    Object.assign(this, { jobs, store, library, logger, maxAttempts, batchSize, intervalMs, backoff, now });
  }

  /** Drain now, then again on every interval (picks up retries and resumes after a pause). */
  start() {
    this.#timer = setInterval(() => this.kick(), this.intervalMs);
    this.kick();
  }

  kick() {
    this.drain().catch(err => this.logger.error('Upload drain crashed', { err }));
  }

  /** Processes due jobs until none are left, or until paused or stopped. Concurrent calls share one run. */
  drain() {
    if (this.#running) {
      this.#rerun = true;
      return this.#running;
    }
    this.#running = this.#loop().finally(() => { this.#running = null; });
    return this.#running;
  }

  async #loop() {
    do {
      this.#rerun = false;
      for (;;) {
        const batch = this.#canRun() ? this.jobs.nextBatch(this.now(), this.batchSize) : [];
        if (!batch.length) break;
        for (const job of batch) {
          if (!this.#canRun()) return;
          await this.process(job);
        }
      }
    } while (this.#rerun && this.#canRun());
  }

  #canRun() {
    return !this.#stopped && !this.jobs.isPaused();
  }

  /** @param {import('./ports.js').Job} job */
  async process(job) {
    try {
      let assetId = job.assetId;
      if (!assetId) {
        if (!this.store.exists(job.filename)) throw new PermanentError(`Pending file is missing: ${job.filename}`);
        const result = await this.library.upload({
          filePath: this.store.pathOf(job.filename),
          filename: job.filename,
          mimetype: job.mimetype,
          takenAt: job.takenAt,
          deviceAssetId: job.id,
        });
        assetId = result.assetId;
        this.jobs.markUploaded(job.id, assetId);
      }
      await this.library.addToAlbum(assetId);
      this.jobs.markDone(job.id);
      await this.store.remove(job.filename);
      this.logger.info('Imported media', { id: job.id, assetId });
      return 'done';
    } catch (err) {
      const attempts = job.attempts + 1;
      const permanent = isPermanent(err) || attempts >= this.maxAttempts;
      this.jobs.recordFailure(job.id, errorMessage(err), permanent ? null : this.now() + this.backoff(attempts));
      if (permanent) this.logger.error('Job failed permanently (see `cli retry-failed`)', { id: job.id, attempts, err });
      else this.logger.warn('Job failed; will retry', { id: job.id, attempts, err });
      return permanent ? 'failed' : 'retry';
    }
  }

  async stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    await this.#running;
  }
}
