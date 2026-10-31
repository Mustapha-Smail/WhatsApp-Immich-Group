import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extensionFor, isSupportedMime, kindOf, mimeFromFilename, normalizeMime, storageNameFor } from '../../src/domain/media.js';

describe('media rules', () => {
  it('normalizes mime types with parameters and casing', () => {
    assert.equal(normalizeMime('Video/MP4; codecs="avc1"'), 'video/mp4');
    assert.equal(normalizeMime(undefined), '');
  });

  it('accepts only formats Immich can ingest', () => {
    assert.ok(isSupportedMime('image/jpeg'));
    assert.ok(isSupportedMime('video/quicktime'));
    assert.ok(!isSupportedMime('image/x-unknown'));
    assert.ok(!isSupportedMime('application/pdf'));
  });

  it('maps mime types and filenames both ways', () => {
    assert.equal(extensionFor('image/heic'), '.heic');
    assert.throws(() => extensionFor('application/pdf'), /Unsupported/);
    assert.equal(mimeFromFilename('IMG_1.JPEG'), 'image/jpeg');
    assert.equal(mimeFromFilename('notes.txt'), null);
    assert.equal(kindOf('video/mp4'), 'video');
  });

  it('derives a stable, filesystem-safe storage name', () => {
    const name = storageNameFor('true_1203@g.us_3EB0/../x', 'image/png');
    assert.match(name, /^[0-9a-f]{64}\.png$/);
    assert.equal(name, storageNameFor('true_1203@g.us_3EB0/../x', 'image/png'));
  });
});
