import fs from 'node:fs';
import path from 'node:path';

/** @implements {import('../../core/ports.js').MediaStore} */
export class FileMediaStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    // Leftovers from a crash mid-write; the message was never enqueued, so a rescan picks it up.
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.tmp')) fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  pathOf(name) {
    return path.join(this.dir, name);
  }

  exists(name) {
    return fs.existsSync(this.pathOf(name));
  }

  /** Write-then-rename, so a file is never seen half written. */
  async save(name, data) {
    const target = this.pathOf(name);
    await fs.promises.writeFile(`${target}.tmp`, data);
    await fs.promises.rename(`${target}.tmp`, target);
  }

  async remove(name) {
    await fs.promises.rm(this.pathOf(name), { force: true });
  }
}
