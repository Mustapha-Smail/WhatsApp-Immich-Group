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

/**
 * MessageSource backed by WhatsApp Web (unofficial, via whatsapp-web.js and headless Chromium).
 * @implements {import('../../core/ports.js').MessageSource}
 */
export class WhatsAppSource {
  #client = null;
  #messageHandlers = [];
  #disconnectHandlers = [];

  constructor({ authDir, chromiumPath, logger }) {
    Object.assign(this, { authDir, chromiumPath, logger });
  }

  onMessage(handler) {
    this.#messageHandlers.push(handler);
  }

  onDisconnect(handler) {
    this.#disconnectHandlers.push(handler);
  }

  async connect() {
    // Loaded lazily so tests and fixture runs never start Chromium.
    const { default: wweb } = await import('whatsapp-web.js');
    const { default: qrcode } = await import('qrcode-terminal');

    for (const file of clearStaleChromiumLocks(this.authDir)) this.logger.warn('Removed stale Chromium lock', { file });

    const client = new wweb.Client({
      authStrategy: new wweb.LocalAuth({ dataPath: this.authDir }),
      puppeteer: {
        executablePath: this.chromiumPath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });
    this.#client = client;

    client.on('qr', qr => {
      this.logger.info('Scan this QR code in WhatsApp > Settings > Linked Devices > Link a Device');
      qrcode.generate(qr, { small: true });
    });
    client.on('authenticated', () => this.logger.info('WhatsApp authenticated'));
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
    this.logger.info('WhatsApp ready');
  }

  async listGroups() {
    const chats = await this.#client.getChats();
    return chats.filter(chat => chat.isGroup).map(chat => ({ id: chat.id._serialized, name: chat.name }));
  }

  async fetchHistory(groupId, limit = 0) {
    const chat = await this.#client.getChatById(groupId);
    if (!chat?.isGroup) throw new Error(`WHATSAPP_GROUP_ID ${groupId} is not a group`);
    // Infinity asks for everything WhatsApp Web has synced, which is not necessarily full history.
    const messages = await chat.fetchMessages({ limit: limit || Infinity });
    return messages.map(toIncomingMessage).filter(Boolean);
  }

  async disconnect() {
    await this.#client?.destroy();
    this.#client = null;
  }
}
