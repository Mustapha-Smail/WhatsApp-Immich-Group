const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Imports the group's history and feeds media messages to the importer.
 *
 * It scans right away, so uploads start immediately. WhatsApp then keeps syncing older messages to a
 * newly linked device, sometimes for hours or days and with long pauses, so it follows the sync:
 * whenever the amount of available media grows it scans again (already imported messages are
 * skipped), and whenever nothing has arrived for a while it asks the phone for older history.
 * Requests that bring nothing back off from requestIntervalMs to requestMaxIntervalMs, and the
 * interval resets as soon as media arrives. Uploads run in parallel the whole time.
 *
 * Progress (back-off, last request, last arrival) is saved, so a restart continues where the
 * previous run left off. The backfill is only marked complete once the phone itself reports that it
 * has no older history (or, for sources that cannot be asked, once the count settled), and no
 * download failed. Anything else is picked up again on the next start.
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
    settleMs = 180_000, maxWaitMs = 0, syncPollMs = 15_000, requestIntervalMs = 60_000, requestMaxIntervalMs = 1_800_000,
    sleep = defaultSleep, now = Date.now, pausePollMs = 5000 }) {
    Object.assign(this, { source, importer, jobs, logger, groupId, enabled, limit, once, delayMs, settleMs, maxWaitMs,
      syncPollMs, requestIntervalMs, requestMaxIntervalMs, sleep, now, pausePollMs });
  }

  // Same key format as v1 of the bridge, so completed scans carry over.
  get marker() {
    return `backfill:v2:${this.groupId}:${this.limit}`;
  }

  // Under the backfill: prefix, so `cli rescan` clears it too.
  get progressKey() {
    return `backfill:sync:${this.groupId}`;
  }

  async run() {
    if (!this.enabled) return { status: 'disabled' };
    if (this.once && this.jobs.getSetting(this.marker) === 'complete') {
      this.logger.info('History import already complete; run `cli rescan` to scan again');
      return { status: 'already-complete' };
    }

    const following = Boolean(this.settleMs && this.source.historySize);
    // Measured before the first scan, so media synced while it runs triggers another pass.
    const initialSize = following ? await this.#historySize() : null;
    const outcomes = {};
    let passes = 1;
    await this.#scan(outcomes);

    let result = { settled: true };
    if (following && initialSize != null && !this.#stopped) {
      result = await this.#followSync(initialSize, outcomes, { freshMedia: outcomes.queued > 0 });
      passes += result.passes;
    }
    if (this.#stopped) return { status: 'stopped', passes, outcomes };

    const complete = result.settled && !outcomes.failed;
    if (complete) {
      this.jobs.setSetting(this.marker, 'complete');
      this.jobs.setSetting(this.progressKey, '');
    }
    const reason = !result.settled ? result.reason : outcomes.failed ? 'some downloads failed' : undefined;
    this.logger.info(complete ? 'History import complete' : 'History import paused; it continues on next start',
      { passes, ...outcomes, reason });
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
  async #followSync(initialSize, outcomes, { freshMedia }) {
    const canAsk = Boolean(this.source.requestOlderHistory);
    const saved = canAsk ? this.#loadProgress() : null;
    const started = this.now();
    let last = initialSize;
    let stableSince = started;
    // Request schedule, carried over from the previous run unless media just arrived.
    let interval = this.requestIntervalMs;
    let unanswered = 0;
    let lastRequest = -Infinity;
    let quietSince = started;
    if (saved && !freshMedia) {
      ({ interval, unanswered, lastRequest, quietSince } = saved);
      this.logger.info('Resuming history sync where the last run left off', {
        unanswered, nextRequestInMinutes: minutes(Math.max(0, Math.max(quietSince, lastRequest) + interval - started)),
      });
    }
    const save = () => this.#saveProgress({ interval, unanswered, lastRequest, quietSince });
    // Sources that cannot be asked just wait for the count to settle.
    let stopAsking = !canAsk;
    let confirmedByPhone = false;
    let passes = 0;
    this.logger.info('Following WhatsApp history sync; new media is imported as it arrives',
      { media: last, maxWaitMinutes: this.maxWaitMs ? this.maxWaitMs / 60_000 : 'unlimited' });

    while (!this.#stopped) {
      const size = await this.#historySize();
      if (size == null) return { passes, settled: !canAsk, reason: 'could not check sync progress' };
      if (size !== last) {
        this.logger.info('History sync brought more media', { media: size, added: size - last });
        last = size;
        stableSince = quietSince = this.now();
        interval = this.requestIntervalMs;
        unanswered = 0;
        if (canAsk) save();
        passes++;
        await this.#scan(outcomes);
      }
      const now = this.now();
      if (stopAsking && now - stableSince >= this.settleMs) {
        if (!canAsk || confirmedByPhone) {
          this.logger.info('History sync finished', { media: size });
          return { passes, settled: true };
        }
        return { passes, settled: false, reason: 'the phone did not confirm the end of history' };
      }
      if (this.maxWaitMs && now - started >= this.maxWaitMs) {
        this.logger.warn('History still syncing after BACKFILL_MAX_WAIT_MS', { media: size });
        return { passes, settled: false, reason: 'BACKFILL_MAX_WAIT_MS reached' };
      }
      if (!stopAsking && now - Math.max(quietSince, lastRequest) >= interval) {
        lastRequest = now;
        unanswered++;
        const nextInterval = Math.min(interval * 2, this.requestMaxIntervalMs);
        const answer = await this.#requestOlderHistory({
          attempt: unanswered, quietMinutes: minutes(now - quietSince), nextInMinutes: minutes(nextInterval),
        });
        interval = nextInterval;
        save();
        if (answer !== 'more') {
          stopAsking = true;
          confirmedByPhone = answer === 'end';
          stableSince = now;
        }
      }
      await this.sleep(this.syncPollMs);
    }
    return { passes, settled: false, reason: 'stopped' };
  }

  /** @returns {Promise<'more'|'end'|'error'>} */
  async #requestOlderHistory(progress) {
    try {
      const result = await this.source.requestOlderHistory(this.groupId);
      if (result?.endOfHistory) {
        this.logger.info('The phone has no older history for this group', { phoneState: result.state });
        return 'end';
      }
      this.logger.info('Asked the phone for older history', { phoneState: result?.state, ...progress });
      return 'more';
    } catch (err) {
      this.logger.warn('Could not ask the phone for older history; trying again on next start', { err });
      return 'error';
    }
  }

  #loadProgress() {
    try {
      const saved = JSON.parse(this.jobs.getSetting(this.progressKey) || 'null');
      if (!saved) return null;
      return {
        interval: saved.interval ?? this.requestIntervalMs,
        unanswered: saved.unanswered ?? 0,
        lastRequest: saved.lastRequest ?? -Infinity,
        quietSince: saved.quietSince ?? this.now(),
      };
    } catch {
      return null;
    }
  }

  #saveProgress(progress) {
    // -Infinity is not valid JSON; null means "never asked".
    const lastRequest = Number.isFinite(progress.lastRequest) ? progress.lastRequest : null;
    this.jobs.setSetting(this.progressKey, JSON.stringify({ ...progress, lastRequest }));
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

const minutes = ms => Math.round(ms / 6000) / 10;
