import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  WhatsAppSource, clearStaleChromiumLocks, explainWhatsAppError, isTransientError, toIncomingMessage,
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
function fakeWhatsApp(outcomes, { getChats, evaluate } = {}) {
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
      this.emit('authenticated');
      this.emit('authenticated');
      this.emit('ready');
    }
    async getChats() { return getChats ? getChats() : []; }
    async destroy() { this.destroyed = true; }
  }
  const source = new WhatsAppSource({
    authDir: tempDir(), cacheDir: '/data/web-cache', logger: silentLogger(), retryDelayMs: 0,
    loadLibraries: async () => ({ Client, LocalAuth: class {}, qrcode: { generate() {} } }),
  });
  return { source, clients };
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

  it('falls back to a lighter group lookup when getChats fails', async () => {
    const { source } = fakeWhatsApp(['ok'], {
      getChats: async () => { throw new Error('r'); },
      evaluate: async () => [{ id: '1203@g.us', name: 'Family' }],
    });
    await source.connect();
    assert.deepEqual(await source.listGroups(), [{ id: '1203@g.us', name: 'Family' }]);
  });
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
