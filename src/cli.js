import fs from 'node:fs';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ImmichLibrary, REQUIRED_PERMISSIONS } from './adapters/immich/immichLibrary.js';
import { SqliteJobRepository } from './adapters/sqlite/sqliteJobRepository.js';
import { createExportImport } from './app.js';
import { loadConfig, shadowedEnvVars } from './config.js';
import { isValidTimeZone } from './domain/time.js';
import { createLogger } from './logger.js';

const USAGE = `Usage: node src/cli.js <command>

  status        Queue counts, pause state and recent errors
  pause         Pause uploads and backfill (the running bridge stops within seconds)
  resume        Resume uploads and backfill
  retry-failed  Re-queue jobs that failed permanently
  rescan        Scan the group's history again on next start (already imported media is skipped)
  doctor        Check configuration and Immich access (read-only)
  import-export <zip-or-folder> [--dry-run] [--yes] [--timezone Area/City]
                Import what's missing from an iPhone WhatsApp chat export
                (WhatsApp > group > Export Chat > Attach Media)

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
  rescan(config) {
    const jobs = openJobs(config);
    const cleared = jobs.resetBackfill();
    jobs.close();
    console.log(cleared ? 'History will be scanned again on next start (restart the bridge).' : 'No completed history scan to reset.');
  },
  async 'import-export'(config, argv) {
    const { values, positionals } = parseArgs({
      args: argv, allowPositionals: true,
      options: { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, timezone: { type: 'string' } },
    });
    const [exportPath] = positionals;
    if (!exportPath) throw new Error('Usage: import-export <zip-or-folder> [--dry-run] [--yes] [--timezone Area/City]');
    // File names carry the phone's local time; containers usually run in UTC.
    const timeZone = values.timezone ?? process.env.EXPORT_TIMEZONE ?? process.env.TZ
      ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!isValidTimeZone(timeZone)) throw new Error(`Unknown time zone: ${timeZone} (use e.g. Europe/Paris)`);
    const dryRun = Boolean(values['dry-run']);

    const { importer, close } = createExportImport(config, { dryRun });
    try {
      const result = await importer.run({
        exportPath, timeZone, dryRun,
        confirm: info => confirmImport(info, { albumName: config.immich.albumName, timeZone, dryRun, yes: values.yes }),
      });
      printImportSummary(result, dryRun);
      if (result.status === 'partial') process.exitCode = 1;
    } finally {
      close();
    }
  },
  async doctor(config) {
    let ok = true;
    const check = (pass, message) => {
      console.log(`${pass ? '✔' : '✘'} ${message}`);
      ok &&= pass;
    };
    check(true, `Mode: ${config.dryRun ? 'dry-run' : 'live'}, source: ${config.source}, data: ${config.paths.dataDir}`);
    const shadowed = shadowedEnvVars();
    check(!shadowed.length, shadowed.length
      ? `Your shell overrides .env for: ${shadowed.join(', ')} (unset them, e.g. in ~/.zshrc)`
      : 'No shell variables override .env');
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

async function confirmImport(info, { albumName, timeZone, dryRun, yes }) {
  console.log(`\nChat:      ${info.chatName ?? '(unknown, the file was renamed)'}`);
  console.log(`Media:     ${info.photos} photos, ${info.videos} videos (${info.otherFiles} other files ignored)`);
  console.log(`Sent:      ${info.from?.slice(0, 10)} to ${info.to?.slice(0, 10)} (dates read as ${timeZone})`);
  console.log(`Album:     ${albumName}${dryRun ? ' (dry run: nothing will be uploaded)' : ''}\n`);
  if (yes || dryRun) return true;
  if (!process.stdin.isTTY) throw new Error('Add --yes to import without confirmation');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question('Import the missing media from this chat? [y/N] ')).trim());
  } finally {
    rl.close();
  }
}

function printImportSummary({ status, counts }, dryRun) {
  if (status === 'cancelled') return console.log('Cancelled.');
  if (status === 'empty') return console.log('No photos or videos found in this export.');
  const line = (label, key) => console.log(`  ${label.padEnd(36)} ${counts[key] ?? 0}`);
  console.log(`\n${dryRun ? 'Dry run, nothing was changed:' : 'Done:'}`);
  line(dryRun ? 'Would import (missing)' : 'Imported (were missing)', 'imported');
  line('Already in Immich (added to album)', 'in-immich');
  line('Already imported by the bridge', 'imported-by-bridge');
  line('Already imported by an earlier run', 'already-imported');
  line('Failed (run again to retry)', 'failed');
}

const command = commands[process.argv[2]];
if (!command) {
  console.log(USAGE);
  process.exitCode = process.argv[2] ? 1 : 0;
} else {
  try {
    await command(loadConfig(), process.argv.slice(3));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
