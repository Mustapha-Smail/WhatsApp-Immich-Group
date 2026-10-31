import fs from 'node:fs';
import { ImmichLibrary, REQUIRED_PERMISSIONS } from './adapters/immich/immichLibrary.js';
import { SqliteJobRepository } from './adapters/sqlite/sqliteJobRepository.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const USAGE = `Usage: node src/cli.js <command>

  status        Queue counts, pause state and recent errors
  pause         Pause uploads and backfill (the running bridge stops within seconds)
  resume        Resume uploads and backfill
  retry-failed  Re-queue jobs that failed permanently
  doctor        Check configuration and Immich access (read-only)

Uses the same environment as the bridge (DATA_DIR, DRY_RUN, ...).`;

function openJobs(config) {
  fs.mkdirSync(config.paths.stateDir, { recursive: true });
  return new SqliteJobRepository(config.paths.database);
}

const commands = {
  status(config) {
    const jobs = openJobs(config);
    console.log(`Mode:    ${config.dryRun ? 'dry-run' : 'live'} (${config.paths.database})`);
    console.log(`Paused:  ${jobs.isPaused() ? 'yes' : 'no'}`);
    console.log('Jobs:   ', jobs.stats());
    for (const job of jobs.recentErrors()) console.log(`  [${job.status}, ${job.attempts} attempts] ${job.id}: ${job.lastError}`);
    jobs.close();
  },
  pause(config) {
    const jobs = openJobs(config);
    jobs.setPaused(true);
    jobs.close();
    console.log('Paused. New media is still downloaded and queued locally, but nothing is sent to Immich.');
  },
  resume(config) {
    const jobs = openJobs(config);
    jobs.setPaused(false);
    jobs.close();
    console.log(`Resumed. The bridge picks this up within ${config.uploads.intervalMs / 1000}s.`);
  },
  'retry-failed'(config) {
    const jobs = openJobs(config);
    console.log(`Re-queued ${jobs.retryFailed()} failed job(s).`);
    jobs.close();
  },
  async doctor(config) {
    let ok = true;
    const check = (pass, message) => {
      console.log(`${pass ? '✔' : '✘'} ${message}`);
      ok &&= pass;
    };
    check(true, `Mode: ${config.dryRun ? 'dry-run' : 'live'}, source: ${config.source}, data: ${config.paths.dataDir}`);
    check(Boolean(config.groupId), config.groupId ? `Group: ${config.groupId}` : 'WHATSAPP_GROUP_ID is not set (start the bridge once to list groups)');
    if (config.source === 'whatsapp') {
      check(fs.existsSync(config.paths.authDir), fs.existsSync(config.paths.authDir) ? 'WhatsApp session found' : 'No WhatsApp session yet (scan the QR code on first start)');
      if (config.chromiumPath) check(fs.existsSync(config.chromiumPath), `Chromium: ${config.chromiumPath}`);
    }
    const { url, apiKey, albumName, deviceId } = config.immich;
    if (url && apiKey) {
      const library = new ImmichLibrary({ url, apiKey, albumName, deviceId, logger: createLogger({ level: 'warn' }) });
      try {
        await library.verifyAccess();
        check(true, `Immich reachable at ${url} and the key can read albums`);
      } catch (err) {
        check(false, err.message);
      }
    } else {
      check(config.dryRun, 'IMMICH_URL / IMMICH_API_KEY not set' + (config.dryRun ? ' (fine for a dry run)' : ''));
    }
    console.log(`\nThe API key needs these non-admin permissions: ${[...new Set(Object.values(REQUIRED_PERMISSIONS))].join(', ')}`);
    if (!ok) process.exitCode = 1;
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.log(USAGE);
  process.exitCode = process.argv[2] ? 1 : 0;
} else {
  try {
    await command(loadConfig());
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
