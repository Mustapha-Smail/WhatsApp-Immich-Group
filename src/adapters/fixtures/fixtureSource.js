import fs from 'node:fs';
import path from 'node:path';
import { kindOf, mimeFromFilename } from '../../domain/media.js';

export const FIXTURE_GROUP_ID = 'fixtures@g.us';

/**
 * A MessageSource backed by a folder of images/videos: each file is one "message" in a fake group.
 * Lets you exercise the whole pipeline without a WhatsApp account.
 * @implements {import('../../core/ports.js').MessageSource}
 */
export class FixtureSource {
  constructor({ dir, logger }) {
    Object.assign(this, { dir, logger });
  }

  onMessage() {}
  onDisconnect() {}

  async connect() {
    if (!fs.existsSync(this.dir)) throw new Error(`FIXTURES_DIR does not exist: ${this.dir}`);
    this.logger.info('Using local fixtures instead of WhatsApp', { dir: this.dir });
  }

  async listGroups() {
    return [{ id: FIXTURE_GROUP_ID, name: 'Local fixtures' }];
  }

  async fetchHistory(groupId, limit = 0) {
    const names = (await fs.promises.readdir(this.dir)).filter(name => mimeFromFilename(name)).sort();
    const messages = await Promise.all(names.map(async name => {
      const file = path.join(this.dir, name);
      const mimetype = mimeFromFilename(name);
      const { mtimeMs } = await fs.promises.stat(file);
      return {
        id: `fixture:${name}`,
        chatId: groupId,
        kind: kindOf(mimetype),
        timestamp: Math.floor(mtimeMs / 1000),
        download: async () => ({ mimetype, data: await fs.promises.readFile(file) }),
      };
    }));
    return limit ? messages.slice(-limit) : messages;
  }

  async disconnect() {}
}
