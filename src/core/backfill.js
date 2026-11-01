const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Imports the group's history and feeds media messages to the importer.
 *
 * It scans right away, so uploads start immediately. WhatsApp then keeps syncing older messages to a
 * newly linked device, sometimes for hours or days and with long pauses, so it follows the sync:
 * whenever the amount of available media grows it scans again (already queued messages are
 * skipped), and whenever nothing has arrived for requestIntervalMs it asks the phone for older
 * history. It stops once the phone reports there is no older history and nothing new has arrived
 * for settleMs (or after maxWaitMs, when set). Uploads run in parallel the whole time.
 *
 * The backfill is only marked complete once the sync settled without download failures, so
 * anything missed gets picked up on the next start.
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
    settleMs = 180_000, maxWaitMs = 0, syncPollMs = 15_000, requestIntervalMs = 60_000, sleep = defaultSleep,
    now = Date.now, pausePollMs = 5000 }) {
    Object.assign(this, { source, importer, jobs, logger, groupId, enabled, limit, once, delayMs, settleMs, maxWaitMs,
      syncPollMs, requestIntervalMs, sleep, now, pausePollMs });
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

    const following = Boolean(this.settleMs && this.source.historySize);
    // Measured before the first scan, so media synced while it runs triggers another pass.
    const initialSize = following ? await this.#historySize() : null;
    const outcomes = {};
    let passes = 1;
    await this.#scan(outcomes);

    let settled = true;
    if (following && initialSize != null && !this.#stopped) {
      const result = await this.#followSync(initialSize, outcomes);
      passes += result.passes;
      settled = result.settled;
    }
    if (this.#stopped) return { status: 'stopped', passes, outcomes };

    const complete = settled && !outcomes.failed;
    if (complete) this.jobs.setSetting(this.marker, 'complete');
    this.logger.info(complete ? 'Backfill complete' : 'Backfill incomplete; it continues on next start',
      { passes, ...outcomes, ...(!settled && { reason: 'history still syncing' }) });
    return { status: complete ? 'complete' : 'incomplete', passes, outcomes };
  }

  stop() {
    this.#stopped = true;
  }

  /** One pass over the history available right now. */
  async #scan(outcomes) {
    const messages = await this.source.fetchHistory(this.groupId, this.limit);
    messages.sort((a, b) => a.timestamp - b.timestamp);
    this.logger.info('Scanning history', { media: messages.length });
    for (const [index, message] of messages.entries()) {
      await this.#waitWhilePaused();
      if (this.#stopped) return;
      const outcome = await this.importer.handle(message);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if ((index + 1) % 100 === 0) this.logger.info('Backfill progress', { scanned: index + 1, total: messages.length });
      // Only pace requests that actually hit WhatsApp.
      if (this.delayMs && outcome !== 'ignored' && outcome !== 'known') await this.sleep(this.delayMs);
    }
  }

  /**
   * Rescans whenever the media count grows and asks the phone for older history while it is quiet.
   * Ends once the phone has no older history and the count has been stable for settleMs.
   */
  async #followSync(initialSize, outcomes) {
    const started = this.now();
    let last = initialSize;
    let stableSince = started;
    let lastRequest = -Infinity;
    // Sources that cannot ask for more history just wait for the count to settle.
    let endOfHistory = !this.source.requestOlderHistory;
    let passes = 0;
    this.logger.info('Following WhatsApp history sync; new media is imported as it arrives',
      { media: last, maxWaitMinutes: this.maxWaitMs ? this.maxWaitMs / 60_000 : 'unlimited' });
    while (!this.#stopped) {
      const size = await this.#historySize();
      if (size == null) return { passes, settled: true };
      if (size !== last) {
        this.logger.info('History sync brought more media', { media: size, added: size - last });
        last = size;
        stableSince = this.now();
        passes++;
        await this.#scan(outcomes);
      }
      const now = this.now();
      if (endOfHistory && now - stableSince >= this.settleMs) {
        this.logger.info('History sync finished', { media: size });
        return { passes, settled: true };
      }
      if (this.maxWaitMs && now - started >= this.maxWaitMs) {
        this.logger.warn('History still syncing after BACKFILL_MAX_WAIT_MS; continuing on next start', { media: size });
        return { passes, settled: false };
      }
      if (!endOfHistory && now - Math.max(stableSince, lastRequest) >= this.requestIntervalMs) {
        lastRequest = now;
        endOfHistory = await this.#requestOlderHistory();
        if (endOfHistory) stableSince = now;
      }
      await this.sleep(this.syncPollMs);
    }
    return { passes, settled: false };
  }

  /** Asks the phone for older messages. Returns true when there is nothing more to ask for. */
  async #requestOlderHistory() {
    try {
      const result = await this.source.requestOlderHistory(this.groupId);
      if (result?.endOfHistory) {
        this.logger.info('The phone has no older history for this group');
        return true;
      }
      this.logger.info('Asked the phone for older history');
      return false;
    } catch (err) {
      this.logger.warn('Could not ask the phone for older history; waiting for the sync instead', { err });
      return true;
    }
  }

  /** Never throws: a failed check just ends sync following. */
  async #historySize() {
    try {
      return await this.source.historySize(this.groupId);
    } catch (err) {
      this.logger.warn('Could not check history sync progress', { err });
      return null;
    }
  }

  async #waitWhilePaused() {
    if (!this.jobs.isPaused()) return;
    this.logger.info('Backfill paused');
    while (this.jobs.isPaused() && !this.#stopped) await this.sleep(this.pausePollMs);
    if (!this.#stopped) this.logger.info('Backfill resumed');
  }
}
