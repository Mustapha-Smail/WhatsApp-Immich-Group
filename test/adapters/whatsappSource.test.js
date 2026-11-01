import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  WhatsAppSource, clearStaleChromiumLocks, describeTransferType, explainWhatsAppError, interpretDownload, isTransientError,
  normalizeMessageId, requestHistoryInPage,
  toIncomingMessage,
} from '../../src/adapters/whatsapp/whatsappSource.js';
import { silentLogger, tempDir } from '../helpers.js';

const waMessage = overrides => ({
  id: { _serialized: 'false_1203@g.us_ABC' },
  hasMedia: true,
  fromMe: false,
  from: '1203@g.us',
  to: '33600000000@c.us',
  type: 'image',
  timestamp: 1_700_000_000,
  downloadMedia: async () => ({ mimetype: 'image/jpeg', data: Buffer.from('hello').toString('base64') }),
  ...overrides,
});

describe('toIncomingMessage', () => {
  it('maps a received media message', async () => {
    const message = toIncomingMessage(waMessage());
    assert.equal(message.id, 'false_1203@g.us_ABC');
    assert.equal(message.chatId, '1203@g.us');
    assert.equal(message.kind, 'image');
    assert.equal(message.timestamp, 1_700_000_000);
    assert.deepEqual(await message.download(), { mimetype: 'image/jpeg', data: Buffer.from('hello') });
  });

  it('uses the recipient as the chat for messages we sent', () => {
    assert.equal(toIncomingMessage(waMessage({ fromMe: true, from: '33600000000@c.us', to: '1203@g.us' })).chatId, '1203@g.us');
  });

  it('accepts the renamed message key ($1) and restores _serialized for downloadMedia', () => {
    const msg = waMessage({ id: { fromMe: false, remote: '1203@g.us', id: 'ABC', $1: 'false_1203@g.us_ABC' } });
    assert.equal(toIncomingMessage(msg).id, 'false_1203@g.us_ABC');
    assert.equal(msg.id._serialized, 'false_1203@g.us_ABC');
    assert.equal(normalizeMessageId({ id: {} }), undefined);
  });

  it('works with the real whatsapp-web.js Message class on a renamed key', async () => {
    const { default: wweb } = await import('whatsapp-web.js');
    const model = {
      id: { fromMe: false, remote: '1203@g.us', id: 'ABC', $1: 'false_1203@g.us_ABC' },
      from: '1203@g.us', to: '33600000000@c.us', type: 'video', t: 1_700_000_000, directPath: '/v/t62/xyz',
    };
    const message = toIncomingMessage(new wweb.Message({}, model));
    assert.deepEqual({ id: message.id, chatId: message.chatId, kind: message.kind, timestamp: message.timestamp },
      { id: 'false_1203@g.us_ABC', chatId: '1203@g.us', kind: 'video', timestamp: 1_700_000_000 });
  });

  it('returns null for messages without media and download null when media expired', async () => {
    assert.equal(toIncomingMessage(waMessage({ hasMedia: false })), null);
    assert.equal(await toIncomingMessage(waMessage({ downloadMedia: async () => undefined })).download(), null);
  });
});

describe('clearStaleChromiumLocks', () => {
  function profileWithLock(owner) {
    const authDir = tempDir();
    const profile = path.join(authDir, 'session');
    fs.mkdirSync(profile);
    fs.symlinkSync(owner, path.join(profile, 'SingletonLock'));
    fs.symlinkSync('/tmp/missing', path.join(profile, 'SingletonSocket'));
    return { authDir, profile };
  }

  it('removes locks left by a dead process on this host', () => {
    const { authDir, profile } = profileWithLock('bridge-host-42');
    const removed = clearStaleChromiumLocks(authDir, { hostname: 'bridge-host', isAlive: () => false });
    assert.equal(removed.length, 2);
    assert.deepEqual(fs.readdirSync(profile), []);
  });

  it('keeps locks held by a live process or another host', () => {
    const live = profileWithLock('bridge-host-42');
    assert.deepEqual(clearStaleChromiumLocks(live.authDir, { hostname: 'bridge-host', isAlive: () => true }), []);
    const other = profileWithLock('laptop-42');
    assert.deepEqual(clearStaleChromiumLocks(other.authDir, { hostname: 'bridge-host', isAlive: () => false }), []);
  });

  it('ignores a missing auth directory', () => {
    assert.deepEqual(clearStaleChromiumLocks(path.join(tempDir(), 'nope')), []);
  });
});

/** Fake whatsapp-web.js: each `initialize` takes the next scripted outcome. */
function fakeWhatsApp(outcomes, { getChats, evaluate, ...sourceOptions } = {}) {
  class Message {
    constructor(client, data) {
      Object.assign(this, { id: data.id, hasMedia: Boolean(data.directPath), from: data.from, to: data.to,
        fromMe: data.id.fromMe, type: data.type, timestamp: data.t, downloadMedia: async () => null });
    }
  }
  const clients = [];
  class Client extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.pupPage = { evaluate: evaluate ?? (async () => []) };
      clients.push(this);
    }
    async initialize() {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      if (outcome === 'hang') return; // never becomes ready
      if (outcome === 'slow') {
        // Loads with progress, each step well within the watchdog delay.
        for (const percent of [10, 50, 100]) {
          await new Promise(resolve => setTimeout(resolve, 20));
          this.emit('loading_screen', percent, 'WhatsApp');
        }
      }
      this.emit('authenticated');
      this.emit('authenticated');
      this.emit('ready');
    }
    async getChats() { return getChats ? getChats() : []; }
    async destroy() { this.destroyed = true; }
  }
  const logger = silentLogger();
  const source = new WhatsAppSource({
    authDir: tempDir(), cacheDir: '/data/web-cache', logger, retryDelayMs: 0,
    loadLibraries: async () => ({ Client, LocalAuth: class {}, Message, qrcode: { generate() {} } }),
    ...sourceOptions,
  });
  return { source, clients, logger };
}

describe('WhatsAppSource', () => {
  it('keeps the web version cache and a long protocol timeout in its options', async () => {
    const { source, clients } = fakeWhatsApp(['ok']);
    await source.connect();
    assert.deepEqual(clients[0].options.webVersionCache, { type: 'local', path: '/data/web-cache' });
    assert.equal(clients[0].options.puppeteer.protocolTimeout, 600_000);
  });

  it('retries startup when WhatsApp Web reloads mid-login', async () => {
    const { source, clients } = fakeWhatsApp([new Error('Protocol error (Runtime.callFunctionOn): Execution context was destroyed.'), 'ok']);
    await source.connect();
    assert.equal(clients.length, 2);
    assert.ok(clients[0].destroyed);
  });

  it('gives up after the configured attempts or on non-transient errors', async () => {
    const timeout = () => new Error('Runtime.callFunctionOn timed out.');
    await assert.rejects(fakeWhatsApp([timeout(), timeout(), timeout()]).source.connect(), /timed out/);
    const { source, clients } = fakeWhatsApp([new Error('auth broke'), 'ok']);
    await assert.rejects(source.connect(), /auth broke/);
    assert.equal(clients.length, 1);
  });

  it('restarts a login that stops making progress before becoming ready', async () => {
    const { source, clients } = fakeWhatsApp(['hang', 'ok'], { readyTimeoutMs: 30 });
    await source.connect();
    assert.equal(clients.length, 2);
    assert.ok(clients[0].destroyed);
  });

  it('keeps waiting while WhatsApp Web reports loading progress, and logs it', async () => {
    const { source, clients, logger } = fakeWhatsApp(['slow'], { readyTimeoutMs: 50 });
    await source.connect();
    assert.equal(clients.length, 1);
    assert.deepEqual(logger.entries.filter(e => e.msg === 'Loading WhatsApp Web').map(e => e.percent), [10, 50, 100]);
    assert.equal(clients[0].listenerCount('loading_screen'), 1, 'watchdog listeners are removed after ready');
  });

  it('falls back to a lighter group lookup when getChats fails', async () => {
    const { source } = fakeWhatsApp(['ok'], {
      getChats: async () => { throw new Error('r'); },
      evaluate: async () => [{ id: '1203@g.us', name: 'Family' }],
    });
    await source.connect();
    assert.deepEqual(await source.listGroups(), [{ id: '1203@g.us', name: 'Family' }]);
  });
});

describe('WhatsAppSource.fetchHistory', () => {
  const model = (id, overrides = {}) => ({
    id: { fromMe: false, remote: '1203@g.us', $1: id }, from: '1203@g.us', type: 'image', t: 1, directPath: '/p', ...overrides,
  });

  it('maps the history returned by WhatsApp Web, without loading group metadata', async () => {
    let args;
    const { source } = fakeWhatsApp(['ok'], {
      evaluate: async (fn, ...rest) => { args = rest; return [model('a'), model('b', { directPath: undefined })]; },
    });
    await source.connect();
    const messages = await source.fetchHistory('1203@g.us', 500);
    assert.deepEqual(args, ['1203@g.us', 500, false]);
    assert.deepEqual(messages.map(m => m.id), ['a']);
  });

  it('downloads media inside WhatsApp Web by message id and chat', async () => {
    const calls = [];
    const { source } = fakeWhatsApp(['ok'], {
      evaluate: async (fn, ...args) => {
        calls.push([fn.name, ...args]);
        return fn.name === 'downloadInPage'
          ? { status: 'ok', mimetype: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') }
          : [model('false_1203@g.us_AC6B_1331@lid')];
      },
    });
    await source.connect();
    const [message] = await source.fetchHistory('1203@g.us');
    assert.deepEqual(await message.download(), { mimetype: 'image/jpeg', data: Buffer.from('jpeg') });
    assert.deepEqual(calls[1], ['downloadInPage', 'false_1203@g.us_AC6B_1331@lid', '1203@g.us']);
  });

  it('counts available media without serializing messages', async () => {
    let args;
    const { source } = fakeWhatsApp(['ok'], { evaluate: async (fn, ...rest) => { args = [fn.name, ...rest]; return 42; } });
    await source.connect();
    assert.equal(await source.historySize('1203@g.us'), 42);
    assert.deepEqual(args, ['historyInPage', '1203@g.us', 0, true]);
  });

  it('asks the phone for older history', async () => {
    let args;
    const { source } = fakeWhatsApp(['ok'], {
      evaluate: async (fn, ...rest) => { args = [fn.name, ...rest]; return { requested: true, endOfHistory: false, transferType: 0 }; },
    });
    await source.connect();
    assert.deepEqual(await source.requestOlderHistory('1203@g.us'),
      { requested: true, endOfHistory: false, transferType: 0, state: 'more-on-phone' });
    assert.deepEqual(args, ['requestHistoryInPage', '1203@g.us']);
  });

  it('explains why history ends when the rest is only on the phone', async () => {
    const { source } = fakeWhatsApp(['ok'], { evaluate: async () => ({ requested: false, endOfHistory: true, transferType: 4 }) });
    await source.connect();
    const result = await source.requestOlderHistory('1203@g.us');
    assert.equal(result.state, 'phone-only');
    assert.match(result.detail, /export the chat/);
  });

  it('rejects ids that are not groups and chats that do not exist', async () => {
    const { source } = fakeWhatsApp(['ok'], { evaluate: async () => null });
    await source.connect();
    await assert.rejects(source.fetchHistory('33600000000@c.us'), /not a group id/);
    await assert.rejects(source.fetchHistory('1203@g.us'), /not found/);
  });

  it('explains minified errors from WhatsApp Web', async () => {
    const { source } = fakeWhatsApp(['ok'], { evaluate: async () => { throw new Error('r'); } });
    await source.connect();
    await assert.rejects(source.fetchHistory('1203@g.us'), /minified error "r"/);
  });
});

describe('interpretDownload', () => {
  it('decodes successful downloads and maps unavailable media to null', () => {
    assert.deepEqual(interpretDownload({ status: 'ok', mimetype: 'video/mp4', data: 'aGk=' }), { mimetype: 'video/mp4', data: Buffer.from('hi') });
    assert.equal(interpretDownload({ status: 'unavailable', reason: 'media expired' }), null);
    assert.equal(interpretDownload(null), null);
  });

  it('reports the failing step and the real error', () => {
    assert.throws(() => interpretDownload({
      status: 'error', step: 'decrypt', error: { name: 'DataError', message: 'No key', status: 403 },
      resolveError: { name: 't', message: 't' },
    }), /step "decrypt": DataError: No key: status 403 \(resolve step also failed: t: t\)/);
  });
});

describe('describeTransferType', () => {
  it('names the history states WhatsApp Web reports', () => {
    assert.equal(describeTransferType(0).state, 'more-on-phone');
    assert.equal(describeTransferType(1).state, 'none-left');
    assert.equal(describeTransferType(2).state, 'initial-sync-in-progress');
    assert.equal(describeTransferType(4).state, 'phone-only');
    assert.match(describeTransferType(4).detail, /only on the phone/);
    assert.equal(describeTransferType(null).state, 'not-reported');
    assert.equal(describeTransferType(7).state, 'unknown-7');
  });
});

describe('requestHistoryInPage (against a fake WhatsApp Web)', () => {
  async function withChat(transferType, fn) {
    const sent = [];
    globalThis.window = {
      require: name => ({
        WAWebCollections: { Chat: { get: () => ({ id: 'wid', endOfHistoryTransferType: transferType }) } },
        WAWebWidFactory: { createWid: id => id },
        WAWebSendNonMessageDataRequest: { sendPeerDataOperationRequest: async (op, args) => { sent.push([op, args]); } },
      })[name],
    };
    try {
      return await fn(sent);
    } finally {
      delete globalThis.window;
    }
  }

  it('asks the phone when more history can be requested', () => withChat(0, async sent => {
    assert.deepEqual(await requestHistoryInPage('1203@g.us'), { requested: true, endOfHistory: false, transferType: 0 });
    assert.deepEqual(sent, [[3, { chatId: 'wid' }]]);
  }));

  it('treats "only on the phone" (4) and "nothing older" (1) as the end, without asking', async () => {
    for (const type of [1, 4]) {
      await withChat(type, async sent => {
        assert.equal((await requestHistoryInPage('1203@g.us')).endOfHistory, true);
        assert.deepEqual(sent, []);
      });
    }
  });

  it('waits without asking while the initial sync is in progress (2)', () => withChat(2, async sent => {
    assert.deepEqual(await requestHistoryInPage('1203@g.us'), { requested: false, endOfHistory: false, transferType: 2 });
    assert.deepEqual(sent, []);
  }));
});

describe('WhatsApp error helpers', () => {
  it('recognises transient Puppeteer errors', () => {
    assert.ok(isTransientError(new Error('Protocol error (Runtime.callFunctionOn): Execution context was destroyed.')));
    assert.ok(isTransientError(new Error("Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting")));
    assert.ok(!isTransientError(new Error('r')));
  });

  it('turns minified WhatsApp Web errors into actionable ones', () => {
    const wrapped = explainWhatsAppError(new Error('r: r'), 'the history request');
    assert.match(wrapped.message, /minified error "r: r".*Troubleshooting/);
    assert.equal(wrapped.cause.message, 'r: r');
    const clear = new Error('WHATSAPP_GROUP_ID x is not a group');
    assert.equal(explainWhatsAppError(clear, 'x'), clear);
  });
});
