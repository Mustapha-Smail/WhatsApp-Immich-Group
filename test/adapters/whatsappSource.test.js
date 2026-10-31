import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { clearStaleChromiumLocks, toIncomingMessage } from '../../src/adapters/whatsapp/whatsappSource.js';
import { tempDir } from '../helpers.js';

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
