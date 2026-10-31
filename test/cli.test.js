import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (args, env) => execFileSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

describe('control CLI', () => {
  it('pauses and resumes the queue without any Immich credentials', () => {
    const env = { DATA_DIR: tempDir() };
    assert.match(run(['status'], env), /Paused:\s+no/);
    assert.match(run(['pause'], env), /Paused/);
    assert.match(run(['status'], env), /Paused:\s+yes/);
    run(['resume'], env);
    assert.match(run(['status'], env), /Paused:\s+no/);
  });

  it('targets the dry-run state when DRY_RUN is set', () => {
    const env = { DATA_DIR: tempDir() };
    run(['pause'], { ...env, DRY_RUN: 'true' });
    assert.match(run(['status'], env), /Paused:\s+no/);
    assert.match(run(['status'], { ...env, DRY_RUN: 'true' }), /Paused:\s+yes/);
  });

  it('prints usage for unknown commands', () => {
    assert.throws(() => run(['nope'], {}), err => /Usage/.test(err.stdout));
  });
});
