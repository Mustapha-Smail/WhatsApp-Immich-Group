const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Scans the group's available history once and feeds media messages to the importer.
 * The scan is only marked complete when no download failed, so transient errors get
 * retried on the next start.
 */
export class Backfill {
  #stopped = false;

  /**
   * @param {object} deps
   * @param {import('./ports.js').MessageSource} deps.source
   * @param {import('./mediaImporter.js').MediaImporter} deps.importer
   * @param {import('./ports.js').JobRepository} deps.jobs
   */
  constructor({ source, importer, jobs, logger, groupId, enabled = true, limit = 0, once = true, delayMs = 0,
    sleep = defaultSleep, pausePollMs = 5000 }) {
    Object.assign(this, { source, importer, jobs, logger, groupId, enabled, limit, once, delayMs, sleep, pausePollMs });
  }

  // Same key format as v1 of the bridge, so completed scans carry over.
  get marker() {
    return `backfill:v2:${this.groupId}:${this.limit}`;
  }

  async run() {
    if (!this.enabled) return { status: 'disabled' };
    if (this.once && this.jobs.getSetting(this.marker) === 'complete') {
      this.logger.info('Backfill already completed; set BACKFILL_ONCE=false to rescan');
      return { status: 'already-complete' };
    }
    this.logger.info('Fetching available history; this can take a while');
    const messages = await this.source.fetchHistory(this.groupId, this.limit);
    messages.sort((a, b) => a.timestamp - b.timestamp);
    this.logger.info('Fetched history', { messages: messages.length });

    const outcomes = {};
    for (const [index, message] of messages.entries()) {
      await this.#waitWhilePaused();
      if (this.#stopped) return { status: 'stopped', scanned: index, outcomes };
      const outcome = await this.importer.handle(message);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if ((index + 1) % 100 === 0) this.logger.info('Backfill progress', { scanned: index + 1, total: messages.length });
      // Only pace requests that actually hit WhatsApp.
      if (this.delayMs && outcome !== 'ignored' && outcome !== 'known') await this.sleep(this.delayMs);
    }

    const complete = !outcomes.failed;
    if (complete) this.jobs.setSetting(this.marker, 'complete');
    this.logger.info(complete ? 'Backfill scan complete' : 'Backfill finished with download failures; will rescan on next start',
      { scanned: messages.length, ...outcomes });
    return { status: complete ? 'complete' : 'incomplete', scanned: messages.length, outcomes };
  }

  stop() {
    this.#stopped = true;
  }

  async #waitWhilePaused() {
    if (!this.jobs.isPaused()) return;
    this.logger.info('Backfill paused');
    while (this.jobs.isPaused() && !this.#stopped) await this.sleep(this.pausePollMs);
    if (!this.#stopped) this.logger.info('Backfill resumed');
  }
}
