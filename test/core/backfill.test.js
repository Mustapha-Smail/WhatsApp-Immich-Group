import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Backfill } from '../../src/core/backfill.js';
import { MediaImporter } from '../../src/core/mediaImporter.js';
import { GROUP, fakeMessage, memoryJobs, silentLogger, tempStore } from '../helpers.js';

function setup(messages, options = {}) {
  const jobs = memoryJobs();
  const importer = new MediaImporter({ groupId: GROUP, maxBytes: 1e6, jobs, store: tempStore(), logger: silentLogger() });
  const source = { fetches: 0, async fetchHistory() { this.fetches++; return [...messages]; } };
  const backfill = new Backfill({ source, importer, jobs, logger: silentLogger(), groupId: GROUP, sleep: async () => {}, ...options });
  return { jobs, source, backfill };
}

describe('Backfill', () => {
  it('imports media oldest first and records completion', async () => {
    const { jobs, backfill } = setup([
      fakeMessage({ id: 'b', timestamp: 20 }),
      fakeMessage({ id: 'a', timestamp: 10 }),
      fakeMessage({ id: 'x', chatId: 'other@g.us' }),
    ]);
    const result = await backfill.run();
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.outcomes, { queued: 2, ignored: 1 });
    assert.deepEqual(jobs.nextBatch(Date.now(), 10).map(j => j.id), ['a', 'b']);
    assert.equal(jobs.getSetting(backfill.marker), 'complete');
  });

  it('runs once unless BACKFILL_ONCE is off', async () => {
    const { source, backfill } = setup([fakeMessage()]);
    await backfill.run();
    assert.deepEqual(await backfill.run(), { status: 'already-complete' });
    assert.equal(source.fetches, 1);

    backfill.once = false;
    const rescan = await backfill.run();
    assert.deepEqual(rescan.outcomes, { known: 1 });
    assert.equal(source.fetches, 2);
  });

  it('does not mark the scan complete when a download failed', async () => {
    const { jobs, backfill } = setup([fakeMessage({ download: async () => { throw new Error('timeout'); } })]);
    assert.equal((await backfill.run()).status, 'incomplete');
    assert.equal(jobs.getSetting(backfill.marker), undefined);
  });

  it('does nothing when disabled', async () => {
    const { source, backfill } = setup([fakeMessage()], { enabled: false });
    assert.deepEqual(await backfill.run(), { status: 'disabled' });
    assert.equal(source.fetches, 0);
  });

  it('waits while paused', async () => {
    let polls = 0;
    const { jobs, backfill } = setup([fakeMessage()], {
      sleep: async () => { if (++polls === 3) jobs.setPaused(false); },
    });
    jobs.setPaused(true);
    const result = await backfill.run();
    assert.equal(polls, 3);
    assert.equal(result.outcomes.queued, 1);
  });

  it('paces only messages that hit WhatsApp', async () => {
    let sleeps = 0;
    const { backfill } = setup([fakeMessage({ id: 'a' }), fakeMessage({ id: 'b', chatId: 'other@g.us' })], {
      delayMs: 100, sleep: async () => { sleeps++; },
    });
    await backfill.run();
    assert.equal(sleeps, 1);
  });

  describe('following the history sync', () => {
    /**
     * Source whose media count follows `sizes` (last value repeats) on a fake clock driven by sleep.
     * `history` is what fetchHistory returns and can grow during the test.
     */
    function syncing(sizes, history, options = {}) {
      let clock = 0;
      const fetchedAt = [];
      const ctx = setup(history, {
        settleMs: 30, maxWaitMs: 1000, syncPollMs: 10, now: () => clock, sleep: async ms => { clock += ms; }, ...options,
      });
      ctx.source.fetchHistory = async () => { fetchedAt.push(clock); return [...history]; };
      ctx.source.historySize = async () => {
        const size = sizes.length > 1 ? sizes.shift() : sizes[0];
        if (size instanceof Error) throw size;
        if (typeof size === 'function') return size();
        return size;
      };
      return { ...ctx, fetchedAt, clock: () => clock };
    }

    it('imports right away, then again whenever the sync brings more media', async () => {
      const history = [fakeMessage({ id: 'recent', timestamp: 30 })];
      const grow = () => { history.unshift(fakeMessage({ id: 'older', timestamp: 10 })); return 2; };
      const { backfill, jobs, fetchedAt } = syncing([1, 1, 1, grow, 2], history);
      const result = await backfill.run();

      assert.equal(fetchedAt[0], 0, 'first scan must not wait for the sync');
      assert.deepEqual(fetchedAt, [0, 20]);
      assert.equal(result.status, 'complete');
      assert.equal(result.passes, 2);
      assert.deepEqual(result.outcomes, { queued: 2, known: 1 });
      assert.deepEqual(jobs.nextBatch(Date.now(), 10).map(j => j.id), ['older', 'recent']);
      assert.equal(jobs.getSetting(backfill.marker), 'complete');
    });

    it('rescans when media arrived while the first scan was running', async () => {
      const { backfill, fetchedAt } = syncing([1, 3, 3], [fakeMessage()]);
      await backfill.run();
      assert.equal(fetchedAt.length, 2);
    });

    it('stays incomplete when history is still growing at the maximum time', async () => {
      let n = 0;
      const { backfill, jobs } = syncing([() => ++n], [fakeMessage()], { maxWaitMs: 100 });
      const result = await backfill.run();
      assert.equal(result.status, 'incomplete');
      assert.equal(jobs.getSetting(backfill.marker), undefined);
    });

    it('stops following when the progress check fails', async () => {
      const { backfill, fetchedAt } = syncing([1, new Error('page reloaded')], [fakeMessage()]);
      const result = await backfill.run();
      assert.equal(result.status, 'complete');
      assert.equal(fetchedAt.length, 1);
    });

    it('scans once when disabled or when the source cannot report progress', async () => {
      const disabled = syncing([() => { throw new Error('should not be called'); }], [fakeMessage()], { settleMs: 0 });
      assert.equal((await disabled.backfill.run()).passes, 1);

      const { backfill, source } = setup([fakeMessage()], { settleMs: 30, sleep: async () => { throw new Error('should not wait'); } });
      assert.equal((await backfill.run()).status, 'complete');
      assert.equal(source.fetches, 1);
    });
  });

  describe('asking the phone for older history', () => {
    function requesting(replies, { sizes = [1], ...options } = {}) {
      let clock = 0;
      const requestsAt = [];
      const ctx = setup([fakeMessage()], {
        settleMs: 30, syncPollMs: 10, requestIntervalMs: 20, now: () => clock, sleep: async ms => { clock += ms; }, ...options,
      });
      ctx.source.historySize = async () => {
        const size = sizes.length > 1 ? sizes.shift() : sizes[0];
        return typeof size === 'function' ? size() : size;
      };
      ctx.source.requestOlderHistory = async () => {
        requestsAt.push(clock);
        const reply = replies.length > 1 ? replies.shift() : replies[0];
        if (reply instanceof Error) throw reply;
        return reply;
      };
      return { ...ctx, requestsAt, clock: () => clock, tick: ms => { clock += ms; } };
    }

    it('keeps asking while the sync is quiet, backing off, until the phone has nothing older', async () => {
      const { backfill, jobs, requestsAt, clock } = requesting([{ endOfHistory: false }, { endOfHistory: false }, { endOfHistory: true }]);
      const result = await backfill.run();
      assert.deepEqual(requestsAt, [20, 60, 140], 'waits 20, then 40, then 80');
      assert.equal(clock(), 170, 'settles settleMs after the phone reported the end of history');
      assert.equal(result.status, 'complete');
      assert.equal(jobs.getSetting(backfill.marker), 'complete');
    });

    it('caps the back-off and resets it when media arrives', async () => {
      let size = 1;
      let ctx;
      ctx = requesting([{ endOfHistory: false }], {
        sizes: [() => size], requestMaxIntervalMs: 50,
        sleep: async () => {
          ctx.tick(10);
          if (ctx.requestsAt.length === 4 && size === 1) size = 2; // media arrives after the 4th request
          if (ctx.requestsAt.length >= 6) ctx.backfill.stop();
        },
      });
      await ctx.backfill.run();
      const gaps = ctx.requestsAt.slice(1).map((t, i) => t - ctx.requestsAt[i]);
      assert.deepEqual(gaps.slice(0, 3), [40, 50, 50], 'doubles, then stays at the cap');
      assert.ok(gaps[4] <= 40, 'back to the short interval after media arrived');
    });

    it('does not ask while media is still arriving', async () => {
      let n = 0;
      const { backfill, requestsAt } = requesting([{ endOfHistory: true }], { sizes: [0, () => (n < 5 ? ++n : n)] });
      await backfill.run();
      // Media grew on every poll until t=40; the first request comes requestIntervalMs after that.
      assert.deepEqual(requestsAt, [60]);
    });

    it('leaves history open when the request fails, so the next start asks again', async () => {
      const { backfill, jobs, requestsAt } = requesting([new Error('not supported')]);
      const result = await backfill.run();
      assert.equal(requestsAt.length, 1);
      assert.equal(result.status, 'incomplete');
      assert.equal(jobs.getSetting(backfill.marker), undefined);
    });

    it('has no time limit by default', async () => {
      let clock = 0;
      let ctx;
      ctx = requesting([{ endOfHistory: false }], {
        requestMaxIntervalMs: 40,
        now: () => clock,
        sleep: async ms => {
          clock += ms;
          if (ctx.requestsAt.length >= 50) ctx.backfill.stop();
        },
      });
      const result = await ctx.backfill.run();
      assert.equal(ctx.requestsAt.length, 50);
      assert.equal(result.status, 'stopped');
      assert.equal(ctx.jobs.getSetting(ctx.backfill.marker), undefined);
    });
  });

  describe('restarts', () => {
    /** Two runs sharing one database and one clock, like a pod restart. */
    function restartable() {
      let clock = 1_000_000;
      const jobs = memoryJobs();
      const history = [fakeMessage({ id: 'a' })];
      const requestsAt = [];
      let replies = [];
      const make = ({ stopAfter = Infinity, ...options } = {}) => {
        const importer = new MediaImporter({ groupId: GROUP, maxBytes: 1e6, jobs, store: tempStore(), logger: silentLogger() });
        const source = {
          async fetchHistory() { return [...history]; },
          async historySize() { return history.length; },
          async requestOlderHistory() {
            requestsAt.push(clock);
            if (requestsAt.length >= stopAfter) backfill.stop();
            const reply = replies.length > 1 ? replies.shift() : replies[0];
            if (reply instanceof Error) throw reply;
            return reply;
          },
        };
        const backfill = new Backfill({
          source, importer, jobs, logger: silentLogger(), groupId: GROUP, settleMs: 30, syncPollMs: 10,
          requestIntervalMs: 20, now: () => clock, sleep: async ms => { clock += ms; }, ...options,
        });
        return backfill;
      };
      return { make, jobs, history, requestsAt, setReplies: r => { replies = r; }, tick: ms => { clock += ms; }, now: () => clock };
    }

    it('continues the request back-off from the previous run', async () => {
      const ctx = restartable();
      ctx.setReplies([{ endOfHistory: false }]);
      await ctx.make({ stopAfter: 3 }).run(); // asked at +20, +60, +140; next due 160 later
      const [, , third] = ctx.requestsAt;
      ctx.tick(5); // restart

      await ctx.make({ stopAfter: 4 }).run();
      assert.equal(ctx.requestsAt.length, 4);
      const gap = ctx.requestsAt[3] - third;
      // Due 160 after the 3rd request; it goes out on the first poll (every 10) after that.
      assert.ok(gap >= 160 && gap < 170, `the 4th request keeps the doubled interval instead of starting over (gap ${gap})`);
    });

    it('starts the back-off over when the restart finds new media', async () => {
      const ctx = restartable();
      ctx.setReplies([{ endOfHistory: false }]);
      await ctx.make({ stopAfter: 3 }).run();
      ctx.history.push(fakeMessage({ id: 'b' })); // synced while the bridge was down
      ctx.tick(5);
      const restartedAt = ctx.now();

      await ctx.make({ stopAfter: 4 }).run();
      assert.equal(ctx.requestsAt[3] - restartedAt, 20);
    });

    it('asks again after a restart when the previous run could not reach the phone', async () => {
      const ctx = restartable();
      ctx.setReplies([new Error('page reloaded')]);
      assert.equal((await ctx.make().run()).status, 'incomplete');

      ctx.setReplies([{ endOfHistory: true }]);
      assert.equal((await ctx.make().run()).status, 'complete');
      assert.equal(ctx.requestsAt.length, 2);
    });

    it('stops asking for good once the phone reported the end of history', async () => {
      const ctx = restartable();
      ctx.setReplies([{ endOfHistory: true }]);
      assert.equal((await ctx.make().run()).status, 'complete');
      assert.equal(ctx.jobs.getSetting('backfill:sync:' + GROUP), '');
      assert.deepEqual(await ctx.make().run(), { status: 'already-complete' });
      assert.equal(ctx.requestsAt.length, 1);
    });
  });
});
