# WhatsApp group → Immich

Copies every photo and video from one WhatsApp group into an Immich album. It imports the group's available history once, then keeps watching for new media, including what you send yourself.

> **Read first.** This uses WhatsApp Web through unofficial automation (`whatsapp-web.js`). WhatsApp may restrict accounts that use it. Get your family's consent before archiving shared media.

## Contents

- [How it works](#how-it-works)
- [Immich API key (no admin needed)](#immich-api-key-no-admin-needed)
- [1. Dry run](#1-dry-run)
- [2. Run locally](#2-run-locally)
- [3. Run in production (Docker)](#3-run-in-production-docker)
- [Operating the bridge](#operating-the-bridge)
- [Configuration](#configuration)
- [Development and tests](#development-and-tests)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## How it works

```
 WhatsApp group ──► MediaImporter ──► SQLite queue + ./data/pending ──► UploadWorker ──► Immich album
   (live + backfill)   filter, download,     durable, deduplicated          upload, add to album,
                       store locally                                        retry with backoff
```

1. **Source.** A headless Chromium logs into WhatsApp Web as a linked device. The session is saved in `data/auth`, so you scan the QR code only once.
2. **History, right away.** As soon as WhatsApp is connected, the bridge scans the group's available history and starts uploading. Your phone then keeps sending older messages to the linked device, sometimes for hours or days, with pauses. The bridge follows that sync: it checks the amount of media every 15 s and scans again whenever it grows, importing only what's new. When nothing has arrived for a minute, it **asks the phone for older history**, the same request WhatsApp Web makes when you scroll to the top of a chat. It stops once the phone reports there's no older history and nothing new has arrived for `BACKFILL_SETTLE_MS` (3 min). Uploads run in parallel the whole time. See [Getting the full history](#getting-the-full-history).
3. **Import.** Each image or video from the configured group is downloaded, written to `data/pending/`, and recorded in `data/state.sqlite`. The record is keyed by the WhatsApp message id, so no message is processed twice.
4. **Upload.** The worker uploads each file to Immich with its original WhatsApp date, adds it to the album, and deletes the local copy. These two steps are saved separately, so a crash in between never uploads a file twice.
5. **Failures.** A failed job is retried with exponential backoff (30 s up to 1 h). After `MAX_ATTEMPTS` it is marked `failed`, and newer jobs keep flowing. `retry-failed` re-queues failed jobs.

### Architecture

The code follows a **hexagonal (ports and adapters)** layout. The core logic depends only on interfaces, so WhatsApp, Immich and storage can each be replaced. Dry runs and tests rely on this.

```
src/
├── domain/              Pure rules, no I/O
│   ├── media.js           supported formats, file naming
│   └── errors.js          permanent vs. retryable failures
├── core/                Use cases; they only talk to ports
│   ├── ports.js           the interfaces (MessageSource, MediaLibrary, JobRepository, MediaStore)
│   ├── mediaImporter.js   message → queued job
│   ├── uploadWorker.js    queue → Immich, retries, pause
│   └── backfill.js        one-off history scan
├── adapters/            Implementations of the ports
│   ├── whatsapp/          WhatsApp Web (whatsapp-web.js)
│   ├── fixtures/          a local folder posing as a WhatsApp group
│   ├── immich/            Immich REST API, plus a dry-run stand-in
│   ├── sqlite/            the job queue and settings (with schema migrations)
│   └── storage/           pending media files on disk
├── app.js               Composition root: picks adapters from config
├── config.js            Environment parsing and validation
├── logger.js            Structured logs (pretty or JSON)
├── main.js              Entrypoint: start, signals, graceful shutdown
└── cli.js               Control commands (status, pause, resume, ...)
```

To add a feature, put the rule in `core/` and the I/O in a new adapter, then wire it up in `app.js`.

## Immich API key (no admin needed)

The bridge uses a **regular user's** API key. It only calls these endpoints, none of which are admin-only:

| Endpoint | Permission |
| --- | --- |
| `GET /api/albums` | `album.read` |
| `POST /api/albums` | `album.create` |
| `POST /api/assets` | `asset.upload` |
| `PUT /api/albums/{id}/assets` | `albumAsset.create` |

To create the key, log in to Immich **as the user who should own the photos**. Go to **Account Settings → API Keys → New API Key** and tick only the four permissions above. A test (`test/adapters/immichLibrary.test.js`) fails if the code ever calls any other endpoint.

**About pausing:** Immich's own background queues (thumbnails, face detection, ...) can only be paused by an admin. The bridge doesn't touch them. It pauses **its own queue** instead (see [Pause and resume](#pause-and-resume)). Pausing stops sending new photos, so it also stops creating new processing work for Immich. No admin key is needed.

Compatibility: written against the Immich v1, v2 and v3 upload API. The fields required by v1/v2 are sent, and v3 ignores them.

## 1. Dry run

A dry run goes through the whole pipeline but **never writes to Immich**. It logs `Would upload ...` for each file instead. Its state is kept in `data/dry-run/`, separate from real state, and is wiped at the start of every dry run, so you can repeat it as often as you like. If `IMMICH_URL` and `IMMICH_API_KEY` are set, it also checks them with a read-only call.

There are two levels:

**a) Without WhatsApp: sample images.** No account needed. This proves the install works.

```bash
npm ci
npm run dry-run:fixtures
# Docker equivalent:
docker compose run --rm -e DRY_RUN=true -e RUN_ONCE=true \
  -e MESSAGE_SOURCE=fixtures -e FIXTURES_DIR=/app/examples/fixtures bridge
```

You should see three `[dry-run] Would upload` lines and `Run complete ... done=3 failed=0`. To test with your own photos, point `FIXTURES_DIR` at any folder.

**b) With your real WhatsApp group.** This lists exactly which media would be imported.

```bash
npm run dry-run          # locally (after the local setup below)
# Docker: stop the live bridge first; both must not use the WhatsApp session at once
docker compose stop bridge
docker compose run --rm -e DRY_RUN=true -e RUN_ONCE=true bridge
docker compose start bridge
```

`RUN_ONCE=true` scans the history, processes the queue, prints a summary and exits. Leave it out to keep a dry run watching for new messages.

## 2. Run locally

For trying it on your own computer (macOS or Linux). Requires **Node.js 22.9+** and Google Chrome or Chromium.

```bash
npm ci                      # also downloads a Chrome for Puppeteer
cp .env.example .env        # then edit it, see below
chmod 600 .env
npm run ctl doctor          # checks config and Immich access
npm start
```

In `.env`:
- `IMMICH_URL`: your server's address, e.g. `http://192.168.1.50:2283`.
- `IMMICH_API_KEY`: the key from [above](#immich-api-key-no-admin-needed).
- Leave `WHATSAPP_GROUP_ID` empty for now.
- If you installed with `PUPPETEER_SKIP_DOWNLOAD=true`, set `PUPPETEER_EXECUTABLE_PATH`, e.g. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

Then:
1. Scan the QR code shown in the terminal: WhatsApp → **Settings → Linked Devices → Link a Device**. Importing starts right away. Keep your phone online, with WhatsApp open, for a while: older messages keep syncing and are imported as they arrive.
2. The bridge logs your groups, e.g. `Group name=Family id=120363...@g.us`. Copy the id into `WHATSAPP_GROUP_ID`.
3. Optional: `npm run dry-run` to preview.
4. `npm start` again. Stop with Ctrl-C; it finishes the current upload first.

Local state lives in `./data`. It only syncs while your computer is awake, so use Docker on an always-on machine for the long term.

## 3. Run in production (Docker)

For an always-on Linux host, e.g. a Debian VM on Proxmox (2 vCPU, 2 GB RAM, 20 GB disk). Install Docker Engine and the Compose plugin following Docker's Debian instructions.

```bash
# 1. Install
sudo mkdir -p /opt/wa-immich-bridge && sudo chown $USER /opt/wa-immich-bridge
# copy this directory there, then:
cd /opt/wa-immich-bridge
cp .env.example .env && chmod 600 .env    # set IMMICH_URL and IMMICH_API_KEY

# 2. The container runs as uid 1000, not root: give it the data directory
mkdir -p data && sudo chown -R 1000:1000 data

# 3. Build, check, start
docker compose build
docker compose run --rm bridge node src/cli.js doctor
docker compose up -d
docker compose logs -f bridge             # scan the QR code shown here

# 4. Copy the group id from the logs into .env, then:
docker compose up -d --force-recreate
```

The bridge imports the available history right away and keeps running. After the QR scan, keep your phone online, with WhatsApp open, for a while: older messages keep syncing, and the bridge imports them as they arrive (`History sync brought more media` in the logs). It restarts automatically after a crash, a reboot, or a WhatsApp disconnect. Logs are rotated (3 × 10 MB).

**Upgrading:** replace the files, then `docker compose up -d --build`. Database migrations run automatically, and data from the first version of the bridge is upgraded in place. If that older version ran as root, run the `chown` from step 2 again.

**Backups:** back up `data/`. It contains the WhatsApp session (treat it like a password), the queue, and any media not yet uploaded. Never expose the bridge to the internet; it doesn't need any inbound port.

## Operating the bridge

Control commands use the same settings as the bridge:

```bash
docker compose exec bridge node src/cli.js <command>     # Docker
npm run ctl <command>                                    # local
```

| Command | What it does |
| --- | --- |
| `status` | Queue counts (`pending`, `uploaded`, `done`, `failed`), pause state, recent errors |
| `pause` | Pauses uploads and the history scan |
| `resume` | Resumes them |
| `retry-failed` | Re-queues jobs that failed permanently, e.g. after fixing the API key |
| `rescan` | Scans the group's history again on the next start; already imported media is skipped |
| `doctor` | Read-only check of configuration, WhatsApp session and Immich access |

Add `DRY_RUN=true` (e.g. `docker compose exec -e DRY_RUN=true ...`) to act on the dry-run state instead.

### Pause and resume

`pause` takes effect within seconds and survives restarts. The upload in progress finishes, then nothing more is sent to Immich. New WhatsApp media is still downloaded and queued locally, so nothing is lost. `resume` sends the backlog. This is useful during Immich maintenance or upgrades, or to let Immich finish processing a big backfill.

To stop everything, including WhatsApp: `docker compose stop bridge`.

## Configuration

All settings are environment variables (`.env`). Invalid values are reported together at startup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMMICH_URL` | (required) | Immich base URL, e.g. `http://192.168.1.50:2283` |
| `IMMICH_API_KEY` | (required) | User API key with the four permissions above |
| `ALBUM_NAME` | `Family WhatsApp` | Album to fill; created if missing |
| `DEVICE_ID` | `wa-family-bridge` | Device name reported to Immich v1/v2 |
| `IMMICH_TIMEOUT_MS` | `120000` | Per-request timeout; raise it for large videos on slow links |
| `WHATSAPP_GROUP_ID` | (empty) | Group to import; leave empty to list your groups |
| `WATCH_NEW_MESSAGES` | `true` | Import new messages as they arrive |
| `WHATSAPP_TIMEOUT_MS` | `600000` | Max time for one WhatsApp Web call; the first sync and long histories are slow |
| `MAX_MEDIA_MB` | `200` | Skip larger files |
| `BACKFILL_ENABLED` | `true` | Scan history at startup |
| `BACKFILL_LIMIT` | `0` | `0` = everything WhatsApp Web has synced; `N` = newest N messages |
| `BACKFILL_ONCE` | `true` | Skip the scan once it has completed without errors; `false` = rescan each start |
| `BACKFILL_DELAY_MS` | `250` | Pause between media downloads during the scan |
| `BACKFILL_SETTLE_MS` | `180000` | Once the phone has no older history, stop following the sync after nothing new has arrived for this long; `0` = scan once only |
| `BACKFILL_MAX_WAIT_MS` | `0` | Stop following the history sync after this long, and continue on the next start; `0` = no limit |
| `UPLOAD_INTERVAL_MS` | `60000` | How often retries run and how quickly a resume is picked up |
| `MAX_ATTEMPTS` | `8` | Attempts before a job is marked `failed` |
| `DRY_RUN` | `false` | Never write to Immich; separate, throwaway state |
| `RUN_ONCE` | `false` | Scan, process the queue, exit (exit code 1 if anything failed) |
| `MESSAGE_SOURCE` | `whatsapp` | `fixtures` reads images from `FIXTURES_DIR` instead |
| `FIXTURES_DIR` | (empty) | Folder of images/videos used when `MESSAGE_SOURCE=fixtures` |
| `DATA_DIR` | `./data` (`/data` in Docker) | Session, queue and pending media |
| `PUPPETEER_EXECUTABLE_PATH` | (Puppeteer's Chrome; Docker: `/usr/bin/chromium`) | Browser used for WhatsApp Web |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `pretty` | `json` for log collectors (Loki, ELK, ...) |

## Development and tests

```bash
npm ci
npm test
```

The tests use Node's built-in runner (`node:test`) and run in about a second. They need no WhatsApp account or Immich server: adapters are replaced with in-memory test doubles. They cover:

- the domain rules
- configuration
- SQLite queue behaviour, including upgrading old databases
- importing (filtering, size limits, duplicate races)
- upload retries, backoff, pause, and crash-safe two-step uploads
- backfill
- the Immich adapter against a fake Immich, including the non-admin endpoint check
- WhatsApp message mapping
- end-to-end dry runs, and the CLI

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Photos land in another Immich account | A variable exported in your shell (e.g. `IMMICH_API_KEY` in `~/.zshrc`) overrides `.env`. The bridge warns `Using values from your shell instead of .env`; `npm run ctl doctor` lists them. Unset them, or use Docker, which only reads `.env` |
| `Data directory /data is not writable` | `sudo chown -R 1000:1000 data` |
| `Immich rejected IMMICH_API_KEY (401)` | Create a new key; check for copy/paste whitespace |
| `IMMICH_API_KEY lacks permissions` | Edit the key and add the four permissions above |
| Jobs stuck in `failed` | `cli status` shows the error; fix the cause, then `cli retry-failed` |
| Chromium "profile in use" | Make sure only one bridge (or dry run) uses `data/`. Locks left by a crashed run are removed automatically. |
| QR code keeps reappearing | The session expired or was unlinked on the phone; scan again |
| Only recent media imported | See [Getting the full history](#getting-the-full-history) |
| `Execution context was destroyed` / `Runtime.callFunctionOn timed out` at startup | WhatsApp Web reloaded during login or the first sync was slow. The bridge retries 3 times; if it still fails, start it again or raise `WHATSAPP_TIMEOUT_MS` |
| `minified error "r"` / `r: r` | See [WhatsApp Web incompatibility](#whatsapp-web-incompatibility) |

### Getting the full history

The bridge can only import what your phone sends to the linked device. The phone sends history in batches, and only while WhatsApp is **running and online on the phone**. iPhones suspend WhatsApp shortly after it goes to the background, which pauses the sync.

While the history imports:

- Keep WhatsApp **open in the foreground** on the phone, with the screen on: set Auto-Lock to "Never" temporarily (Settings → Display & Brightness), or open the group and leave it there.
- Keep the phone **charging and on Wi-Fi**, with Low Power Mode off.
- Watch the logs. `History sync brought more media` means it's progressing. `Asked the phone for older history` means the bridge is asking for the next batch. `The phone has no older history for this group` means you've reached the start.

If an earlier run marked the history as complete too early, scan again (already imported media is skipped):

```bash
npm run ctl rescan                                    # local
docker compose exec bridge node src/cli.js rescan     # Docker
# then restart the bridge
```

Media older than what WhatsApp keeps on its servers shows as `unavailable` and can't be downloaded through a linked device. For that, export the chat with media from the phone.

### WhatsApp Web incompatibility

whatsapp-web.js works by calling WhatsApp Web's internal code, which WhatsApp changes without notice. Since mid-2026 WhatsApp Web builds (2.3000.104x and later), `whatsapp-web.js@1.34.7` has two problems:

- It fails with a minified error `r` when loading chat or group details ([issue #201838](https://github.com/wwebjs/whatsapp-web.js/issues/201838)).
- Message ids arrive under `$1` instead of `_serialized`.

The bridge works around both in its own adapter (`src/adapters/whatsapp/whatsappSource.js`):

- **Listing groups:** if `getChats()` fails, the bridge reads ids and names straight from WhatsApp Web's chat list.
- **History:** fetched with the same steps as `getChatById()` + `fetchMessages()`, minus the group-metadata lookup that fails.
- **Message ids:** `$1` is accepted, and `_serialized` is restored so downloads work, both for history and for live messages.

If WhatsApp Web changes again, a minified error like `r` will point you here. Check the whatsapp-web.js issues for a newer release, then `npm update whatsapp-web.js`. The community fix in [PR #201850](https://github.com/wwebjs/whatsapp-web.js/pull/201850) covers the same problems inside the library, if you prefer patching it (e.g. with `patch-package`).

## Limitations

- **History is not guaranteed to be complete.** Linked devices often receive only recent history, and old media may no longer be downloadable from WhatsApp. Media that can't be downloaded is logged and skipped; a later rescan retries it. To fill gaps, export the chat with media from your phone (a separate importer, not included).
- **Deduplication is per WhatsApp message.** Immich also deduplicates identical files per user. The same photo forwarded twice is uploaded once per message, and Immich flags the second as a duplicate.
- **One bridge per data directory.** Don't run several replicas, or a dry run next to the live bridge, against the same `data/`.
- If several albums share `ALBUM_NAME`, the first one Immich returns is used.
