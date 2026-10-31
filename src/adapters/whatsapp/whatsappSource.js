import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Maps a whatsapp-web.js Message to the core's IncomingMessage; null when it has no media. */
export function toIncomingMessage(msg) {
  if (!msg?.hasMedia || !msg.id?._serialized) return null;
  return {
    id: msg.id._serialized,
    // Messages we send carry the group in `to`; received ones carry it in `from`.
    chatId: msg.fromMe ? (msg.to || msg.from) : msg.from,
    kind: msg.type,
    timestamp: Number(msg.timestamp) || Math.floor(Date.now() / 1000),
    download: async () => {
      const media = await msg.downloadMedia();
      return media ? { mimetype: media.mimetype, data: Buffer.from(media.data, 'base64') } : null;
    },
  };
}

/**
 * When the container is killed, Chromium leaves Singleton* files and the next launch refuses the
 * profile. Remove them only when the lock was written on this host by a process that is gone,
 * so a bridge that is still running is never touched.
 */
export function clearStaleChromiumLocks(authDir, { hostname = os.hostname(), isAlive = processIsAlive } = {}) {
  if (!fs.existsSync(authDir)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(authDir)) {
    const profile = path.join(authDir, entry);
    let owner;
    try {
      owner = fs.readlinkSync(path.join(profile, 'SingletonLock')); // "<hostname>-<pid>"
    } catch {
      continue;
    }
    const separator = owner.lastIndexOf('-');
    const lockHost = owner.slice(0, separator);
    const pid = Number(owner.slice(separator + 1));
    if (lockHost !== hostname || isAlive(pid)) continue;
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        fs.unlinkSync(path.join(profile, name));
        removed.push(path.join(profile, name));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }
  return removed;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Puppeteer errors seen when WhatsApp Web reloads itself during startup; a fresh attempt usually works.
const TRANSIENT_ERRORS = /Execution context was destroyed|timed out|Target closed|Session closed|Navigating frame was detached/i;

export function isTransientError(err) {
  return TRANSIENT_ERRORS.test(err?.message ?? '');
}

/**
 * WhatsApp Web throws minified errors (e.g. "r") when whatsapp-web.js no longer matches its
 * internals. Wrap them in something a human can act on.
 */
export function explainWhatsAppError(err, action) {
  const message = err?.message ?? String(err);
  if (message.replace(/[\s:]/g, '').length > 3) return err;
  return new Error(`WhatsApp Web rejected ${action} (minified error "${message}"). whatsapp-web.js does not match the `
    + 'current WhatsApp Web build; see README > Troubleshooting > "WhatsApp Web incompatibility".', { cause: err });
}

async function loadWhatsAppLibraries() {
  const { default: wweb } = await import('whatsapp-web.js');
  const { default: qrcode } = await import('qrcode-terminal');
  return { Client: wweb.Client, LocalAuth: wweb.LocalAuth, qrcode };
}

/**
 * MessageSource backed by WhatsApp Web (unofficial, via whatsapp-web.js and headless Chromium).
 * @implements {import('../../core/ports.js').MessageSource}
 */
export class WhatsAppSource {
  #client = null;
  #messageHandlers = [];
  #disconnectHandlers = [];

  constructor({ authDir, cacheDir, chromiumPath, protocolTimeoutMs = 600_000, logger, connectAttempts = 3,
    retryDelayMs = 5000, loadLibraries = loadWhatsAppLibraries }) {
    Object.assign(this, { authDir, cacheDir, chromiumPath, protocolTimeoutMs, logger, connectAttempts, retryDelayMs, loadLibraries });
  }

  onMessage(handler) {
    this.#messageHandlers.push(handler);
  }

  onDisconnect(handler) {
    this.#disconnectHandlers.push(handler);
  }

  async connect() {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#connectOnce();
        this.logger.info('WhatsApp ready');
        return;
      } catch (err) {
        await this.disconnect().catch(() => {});
        if (attempt >= this.connectAttempts || !isTransientError(err)) throw explainWhatsAppError(err, 'the login');
        this.logger.warn('WhatsApp startup failed; retrying', { attempt, err });
        await new Promise(resolve => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }
  }

  async #connectOnce() {
    // Loaded lazily so tests and fixture runs never start Chromium.
    const { Client, LocalAuth, qrcode } = await this.loadLibraries();

    for (const file of clearStaleChromiumLocks(this.authDir)) this.logger.warn('Removed stale Chromium lock', { file });

    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.authDir }),
      // Defaults to ./.wwebjs_cache, which is not writable in the container.
      webVersionCache: { type: 'local', path: this.cacheDir },
      puppeteer: {
        executablePath: this.chromiumPath,
        headless: true,
        // Puppeteer's 3 min default is too short for the first sync or a long history fetch.
        protocolTimeout: this.protocolTimeoutMs,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });
    this.#client = client;

    client.once('qr', () => this.logger.info('Scan this QR code in WhatsApp > Settings > Linked Devices > Link a Device'));
    client.on('qr', qr => qrcode.generate(qr, { small: true }));
    // whatsapp-web.js may emit this several times per login.
    client.once('authenticated', () => this.logger.info('WhatsApp authenticated'));
    // message_create also fires for messages we send ourselves.
    client.on('message_create', msg => {
      const message = toIncomingMessage(msg);
      if (message) for (const handler of this.#messageHandlers) handler(message);
    });
    client.on('disconnected', reason => {
      for (const handler of this.#disconnectHandlers) handler(String(reason));
    });

    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('auth_failure', msg => reject(new Error(`WhatsApp authentication failed: ${msg}`)));
      client.initialize().catch(reject);
    });
  }

  async listGroups() {
    try {
      const chats = await this.#client.getChats();
      return chats.filter(chat => chat.isGroup).map(chat => ({ id: chat.id._serialized, name: chat.name }));
    } catch (err) {
      // getChats() also loads group metadata, which breaks on some WhatsApp Web builds.
      // Chat ids and names are still readable directly from WhatsApp Web's chat collection.
      this.logger.warn('getChats failed; using a lighter group lookup', { err });
      return this.#client.pupPage.evaluate(() => window.require('WAWebCollections').Chat.getModelsArray()
        .filter(chat => chat.id?.server === 'g.us')
        .map(chat => ({ id: chat.id._serialized ?? String(chat.id), name: chat.name || chat.formattedTitle || '' })));
    }
  }

  async fetchHistory(groupId, limit = 0) {
    try {
      const chat = await this.#client.getChatById(groupId);
      if (!chat?.isGroup) throw new Error(`WHATSAPP_GROUP_ID ${groupId} is not a group`);
      // Infinity asks for everything WhatsApp Web has synced, which is not necessarily full history.
      const messages = await chat.fetchMessages({ limit: limit || Infinity });
      return messages.map(toIncomingMessage).filter(Boolean);
    } catch (err) {
      throw explainWhatsAppError(err, 'the history request');
    }
  }

  async disconnect() {
    const client = this.#client;
    this.#client = null;
    await client?.destroy();
  }
}
