import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Recent WhatsApp Web builds renamed the message key's `_serialized` to `$1`
 * (whatsapp-web.js#201850). Restore `_serialized`, which whatsapp-web.js itself needs for downloadMedia().
 */
export function normalizeMessageId(msg) {
  const id = msg?.id?._serialized ?? msg?.id?.$1;
  if (id && msg.id._serialized == null) msg.id = { ...msg.id, _serialized: id };
  return id;
}

async function libraryDownload(msg) {
  const media = await msg.downloadMedia();
  return media ? { mimetype: media.mimetype, data: Buffer.from(media.data, 'base64') } : null;
}

/**
 * Maps a whatsapp-web.js Message to the core's IncomingMessage; null when it has no media.
 * @param {(msg: object, chatId: string) => Promise<{mimetype: string, data: Buffer} | null>} [download]
 */
export function toIncomingMessage(msg, download = libraryDownload) {
  if (!msg?.hasMedia) return null;
  const id = normalizeMessageId(msg);
  if (!id) return null;
  // Messages we send carry the group in `to`; received ones carry it in `from`.
  const chatId = msg.fromMe ? (msg.to || msg.from) : msg.from;
  return {
    id,
    chatId,
    kind: msg.type,
    timestamp: Number(msg.timestamp) || Math.floor(Date.now() / 1000),
    download: () => download(msg, chatId),
  };
}

/**
 * Runs inside WhatsApp Web. Same steps as whatsapp-web.js's Message.downloadMedia(), adapted to
 * recent builds: the message is also looked up in its chat (ids with an @lid participant are not
 * always found by Msg.get), the "resolve" step is best effort since decrypting only needs fields
 * the message already has, and failures report the step and the real error.
 */
async function downloadInPage(msgId, chatId) {
  const describe = e => ({
    name: e?.name, message: String(e?.message ?? e), status: e?.status,
    stack: String(e?.stack ?? '').split('\n').slice(0, 3).join(' | '),
  });
  const keyOf = m => m.id._serialized ?? m.id.$1 ?? String(m.id);
  const collections = window.require('WAWebCollections');
  let step = 'lookup';
  let resolveError;
  try {
    let msg = collections.Msg.get(msgId);
    if (!msg) {
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      msg = chat?.msgs.getModelsArray().find(m => keyOf(m) === msgId);
    }
    if (!msg) {
      step = 'lookup-db';
      msg = (await collections.Msg.getMessagesById([msgId]))?.messages?.[0];
    }
    if (!msg) return { status: 'unavailable', reason: 'message not found' };
    if (!msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') return { status: 'unavailable', reason: 'media expired' };
    if (msg.mediaData.mediaStage !== 'RESOLVED') {
      step = 'resolve';
      try {
        await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      } catch (e) {
        resolveError = describe(e);
      }
    }
    step = 'decrypt';
    // Recent builds validate the file against `mimetype`, which defaults to application/octet-stream
    // and fails with InvalidMediaFileType when omitted (whatsapp-web.js#201908).
    const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
    const decrypted = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
      directPath: msg.directPath, encFilehash: msg.encFilehash, filehash: msg.filehash, mediaKey: msg.mediaKey,
      mediaKeyTimestamp: msg.mediaKeyTimestamp, type: msg.type, mimetype: msg.mimetype, signal: new AbortController().signal, downloadQpl: mockQpl,
    });
    step = 'encode';
    return { status: 'ok', mimetype: msg.mimetype, data: await window.WWebJS.arrayBufferToBase64Async(decrypted) };
  } catch (e) {
    if (e?.status === 404 || e?.status === 410) return { status: 'unavailable', reason: `media server returned ${e.status}` };
    return { status: 'error', step, error: describe(e), resolveError };
  }
}

/** Runs inside WhatsApp Web: loads the group's history, returning photo/video models or just their count. */
async function historyInPage(chatId, limit, countOnly) {
  const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
  if (!chat) return null;
  const keep = m => !m.isNotification;
  let msgs = chat.msgs.getModelsArray().filter(keep);
  // limit 0 = keep loading until WhatsApp Web has nothing older.
  while (!limit || msgs.length < limit) {
    const older = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
    if (!older || !older.length) break;
    msgs = [...older.filter(keep), ...msgs];
  }
  if (limit && msgs.length > limit) msgs = msgs.sort((a, b) => a.t - b.t).slice(-limit);
  // Serialize only photos and videos; a group can hold many thousands of text messages.
  const media = msgs.filter(m => m.type === 'image' || m.type === 'video');
  if (countOnly) return media.length;
  return media.map(m => {
    const model = window.WWebJS.getMessageModel(m);
    if (model.id && model.id._serialized == null) {
      model.id = { ...model.id, _serialized: m.id._serialized ?? m.id.$1 ?? String(m.id) };
    }
    return model;
  });
}

/**
 * Runs inside WhatsApp Web: sends the on-demand history sync request that WhatsApp Web uses to fetch
 * older messages from the phone (peer data operation 3), like whatsapp-web.js's syncHistory().
 * That one only asks when endOfHistoryTransferType is 0; here we keep asking unless it says the
 * phone has nothing older (1), so syncs that paused can be resumed.
 */
async function requestHistoryInPage(chatId) {
  const collections = window.require('WAWebCollections');
  const chatWid = window.require('WAWebWidFactory').createWid(chatId);
  const chat = collections.Chat.get(chatWid) ?? (await collections.Chat.find(chatWid));
  if (!chat) return null;
  const transferType = chat.endOfHistoryTransferType ?? null;
  if (transferType === 1) return { requested: false, endOfHistory: true, transferType };
  await window.require('WAWebSendNonMessageDataRequest').sendPeerDataOperationRequest(3, { chatId: chat.id });
  return { requested: true, endOfHistory: false, transferType };
}

/** Turns downloadInPage's result into the core's shape. */
export function interpretDownload(result) {
  if (result?.status === 'ok') return { mimetype: result.mimetype, data: Buffer.from(result.data, 'base64') };
  if (result?.status === 'error') {
    const { name, message, status } = result.error ?? {};
    const detail = [name, message, status && `status ${status}`].filter(Boolean).join(': ');
    const resolve = result.resolveError ? ` (resolve step also failed: ${result.resolveError.name}: ${result.resolveError.message})` : '';
    const err = new Error(`Media download failed at step "${result.step}": ${detail}${resolve}`);
    err.details = result;
    throw err;
  }
  return null; // unavailable: expired or no longer on WhatsApp's servers
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
  return { Client: wweb.Client, LocalAuth: wweb.LocalAuth, Message: wweb.Message, qrcode };
}

/**
 * MessageSource backed by WhatsApp Web (unofficial, via whatsapp-web.js and headless Chromium).
 * @implements {import('../../core/ports.js').MessageSource}
 */
export class WhatsAppSource {
  #client = null;
  #Message = null;
  #messageHandlers = [];
  #disconnectHandlers = [];

  constructor({ authDir, cacheDir, chromiumPath, protocolTimeoutMs = 600_000, logger, connectAttempts = 3,
    retryDelayMs = 5000, loadLibraries = loadWhatsAppLibraries }) {
    Object.assign(this, { authDir, cacheDir, chromiumPath, protocolTimeoutMs, logger, connectAttempts, retryDelayMs, loadLibraries });
  }

  onMessage(handler) {
    this.#messageHandlers.push(handler);
  }

  #download = async (msg, chatId) => {
    if (!this.#client) throw new Error('WhatsApp is not connected');
    const result = await this.#client.pupPage.evaluate(downloadInPage, msg.id._serialized, chatId);
    if (result?.status === 'unavailable') this.logger.info('Media unavailable on WhatsApp', { id: msg.id._serialized, reason: result.reason });
    return interpretDownload(result);
  };

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
    const { Client, LocalAuth, Message, qrcode } = await this.loadLibraries();
    this.#Message = Message;

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
      const message = toIncomingMessage(msg, this.#download);
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

  /**
   * Same steps as whatsapp-web.js's getChatById() + fetchMessages(), minus the group metadata
   * lookup that breaks on recent WhatsApp Web builds (minified error "r", whatsapp-web.js#201838).
   */
  async fetchHistory(groupId, limit = 0) {
    const models = await this.#history(groupId, limit, false);
    return models.map(model => toIncomingMessage(new this.#Message(this.#client, model), this.#download)).filter(Boolean);
  }

  /** Number of photos and videos currently available in the group; grows while history syncs. */
  async historySize(groupId) {
    return this.#history(groupId, 0, true);
  }

  /** Asks the phone to send older messages for the group. */
  async requestOlderHistory(groupId) {
    let result;
    try {
      result = await this.#client.pupPage.evaluate(requestHistoryInPage, groupId);
    } catch (err) {
      throw explainWhatsAppError(err, 'the history sync request');
    }
    if (result == null) throw new Error(`WhatsApp chat ${groupId} not found; check WHATSAPP_GROUP_ID`);
    this.logger.debug('History sync request', result);
    return result;
  }

  async #history(groupId, limit, countOnly) {
    if (!groupId.endsWith('@g.us')) throw new Error(`WHATSAPP_GROUP_ID ${groupId} is not a group id (expected ...@g.us)`);
    let result;
    try {
      result = await this.#client.pupPage.evaluate(historyInPage, groupId, limit, countOnly);
    } catch (err) {
      throw explainWhatsAppError(err, 'the history request');
    }
    if (result == null) throw new Error(`WhatsApp chat ${groupId} not found; check WHATSAPP_GROUP_ID`);
    return result;
  }

  async disconnect() {
    const client = this.#client;
    this.#client = null;
    await client?.destroy();
  }
}
