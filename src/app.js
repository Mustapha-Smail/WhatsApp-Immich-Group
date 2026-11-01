import fs from 'node:fs';
import path from 'node:path';
import { openIosExport } from './adapters/export/iosChatExport.js';
import { FixtureSource } from './adapters/fixtures/fixtureSource.js';
import { DryRunLibrary } from './adapters/immich/dryRunLibrary.js';
import { ImmichLibrary } from './adapters/immich/immichLibrary.js';
import { SqliteJobRepository } from './adapters/sqlite/sqliteJobRepository.js';
import { FileMediaStore } from './adapters/storage/fileMediaStore.js';
import { WhatsAppSource } from './adapters/whatsapp/whatsappSource.js';
import { Backfill } from './core/backfill.js';
import { ExportImporter } from './core/exportImporter.js';
import { MediaImporter } from './core/mediaImporter.js';
import { UploadWorker } from './core/uploadWorker.js';
import { createLogger } from './logger.js';

/**
 * Composition root: the only place that knows which adapters exist.
 * Pass `deps` to replace any of them (tests do).
 */
export function createApp(config, deps = {}) {
  const logger = deps.logger ?? createLogger(config.log);
  prepareDataDir(config);

  const jobs = deps.jobs ?? new SqliteJobRepository(config.paths.database);
  const store = new FileMediaStore(config.paths.pendingDir);
  const library = deps.library ?? createLibrary(config, logger, deps.fetch);
  const source = deps.source ?? createSource(config, logger);
  const worker = new UploadWorker({ jobs, store, library, logger: logger.child({ component: 'uploads' }), ...config.uploads });
  const importer = new MediaImporter({
    groupId: config.groupId, maxBytes: config.media.maxBytes, jobs, store,
    logger: logger.child({ component: 'importer' }), onQueued: () => worker.kick(),
  });
  const backfill = new Backfill({
    source, importer, jobs, groupId: config.groupId, ...config.backfill,
    logger: logger.child({ component: 'backfill' }), ...(deps.sleep && { sleep: deps.sleep }),
  });

  const runBackfill = () => backfill.run().catch(err => {
    logger.error('Backfill failed; it will be retried on next start', { err });
    return { status: 'error' };
  });

  async function start() {
    logger.info('Starting bridge', {
      mode: config.dryRun ? 'dry-run' : 'live', source: config.source, album: config.immich.albumName,
      runOnce: config.runOnce, paused: jobs.isPaused(),
    });
    await library.verifyAccess();
    // Registered before connecting so nothing that arrives during backfill is missed.
    if (config.watchNewMessages && !config.runOnce) source.onMessage(message => void importer.handle(message));
    await source.connect();

    if (!config.groupId) {
      const groups = await source.listGroups();
      for (const group of groups) logger.info('Group', { name: group.name, id: group.id });
      logger.warn('Set WHATSAPP_GROUP_ID to one of the ids above and restart');
      return { status: 'needs-group', groups };
    }

    if (config.runOnce) {
      const backfillResult = await runBackfill();
      await worker.drain();
      return { status: 'finished', backfill: backfillResult, jobs: jobs.stats() };
    }
    worker.start();
    return { status: 'running', backfill: await runBackfill() };
  }

  let stopping = null;
  function stop() {
    stopping ??= (async () => {
      backfill.stop();
      await worker.stop();
      await source.disconnect().catch(err => logger.warn('Error while disconnecting', { err }));
      jobs.close?.();
    })();
    return stopping;
  }

  return { start, stop, jobs, library, source, worker };
}

/**
 * Wiring for `cli import-export`. Always uses the real state database, even with DRY_RUN set, so it
 * can see what the bridge imported; `dryRun` only prevents writes.
 */
export function createExportImport(config, { dryRun = false, logger = createLogger(config.log), fetch } = {}) {
  const { url, apiKey, albumName, deviceId, timeoutMs } = config.immich;
  if (!url || !apiKey) throw new Error('IMMICH_URL and IMMICH_API_KEY are required to import a chat export');
  const immich = new ImmichLibrary({ url, apiKey, albumName, deviceId, timeoutMs, fetch, logger: logger.child({ component: 'immich' }) });
  const library = dryRun ? new DryRunLibrary({ albumName, probe: immich, logger: logger.child({ component: 'immich' }) }) : immich;
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  const jobs = new SqliteJobRepository(path.join(config.paths.dataDir, 'state.sqlite'));
  const importer = new ExportImporter({
    openExport: openIosExport, library, jobs, workDir: path.join(config.paths.dataDir, 'imports', '.work'),
    logger: logger.child({ component: 'export' }),
  });
  return { importer, library, close: () => jobs.close() };
}

function prepareDataDir({ dryRun, paths }) {
  // Every dry run starts from a clean slate so it can be repeated; real state is never touched.
  if (dryRun) fs.rmSync(paths.stateDir, { recursive: true, force: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  try {
    fs.accessSync(paths.dataDir, fs.constants.W_OK);
  } catch {
    throw new Error(`Data directory ${paths.dataDir} is not writable. In Docker run: sudo chown -R 1000:1000 ./data`);
  }
}

function createLibrary(config, logger, fetch) {
  const { url, apiKey, albumName, deviceId, timeoutMs } = config.immich;
  const immich = url && apiKey
    ? new ImmichLibrary({ url, apiKey, albumName, deviceId, timeoutMs, fetch, logger: logger.child({ component: 'immich' }) })
    : null;
  return config.dryRun ? new DryRunLibrary({ albumName, probe: immich, logger: logger.child({ component: 'immich' }) }) : immich;
}

function createSource(config, logger) {
  const sourceLogger = logger.child({ component: config.source });
  return config.source === 'fixtures'
    ? new FixtureSource({ dir: config.fixturesDir, logger: sourceLogger })
    : new WhatsAppSource({
      authDir: config.paths.authDir, cacheDir: config.paths.webCacheDir, chromiumPath: config.chromiumPath,
      protocolTimeoutMs: config.whatsappTimeoutMs, readyTimeoutMs: config.whatsappReadyTimeoutMs, logger: sourceLogger,
    });
}
