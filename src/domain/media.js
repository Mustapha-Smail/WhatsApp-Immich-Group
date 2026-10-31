import crypto from 'node:crypto';
import path from 'node:path';

// Only formats Immich accepts; anything else is skipped rather than uploaded as an opaque file.
const EXTENSION_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/3gpp': '.3gp',
  'video/webm': '.webm',
};

const MIME_BY_EXTENSION = {
  ...Object.fromEntries(Object.entries(EXTENSION_BY_MIME).map(([mime, ext]) => [ext, mime])),
  '.jpeg': 'image/jpeg',
};

/** WhatsApp message types the bridge imports. Stickers, documents and voice notes are ignored. */
export const SUPPORTED_KINDS = new Set(['image', 'video']);

export function normalizeMime(mimetype) {
  return String(mimetype ?? '').split(';')[0].trim().toLowerCase();
}

export function isSupportedMime(mimetype) {
  return normalizeMime(mimetype) in EXTENSION_BY_MIME;
}

export function extensionFor(mimetype) {
  const ext = EXTENSION_BY_MIME[normalizeMime(mimetype)];
  if (!ext) throw new Error(`Unsupported media type: ${mimetype}`);
  return ext;
}

export function mimeFromFilename(filename) {
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] ?? null;
}

export function kindOf(mimetype) {
  return normalizeMime(mimetype).split('/')[0];
}

/** Deterministic, filesystem-safe name for a message's media file. */
export function storageNameFor(messageId, mimetype) {
  return crypto.createHash('sha256').update(messageId).digest('hex') + extensionFor(mimetype);
}
