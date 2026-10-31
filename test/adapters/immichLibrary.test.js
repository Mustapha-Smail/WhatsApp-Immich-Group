import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ImmichLibrary, REQUIRED_PERMISSIONS } from '../../src/adapters/immich/immichLibrary.js';
import { isPermanent } from '../../src/domain/errors.js';
import { silentLogger, tempDir } from '../helpers.js';

const ALBUM_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';

/** Minimal in-memory Immich that records every request. */
function fakeImmich({ albums = [], responses = {} } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const endpoint = new URL(url).pathname.replace(/^\/api/, '');
    calls.push({ method: init.method, endpoint, headers: init.headers, body: init.body });
    const route = `${init.method} ${endpoint.replace(ALBUM_ID, '{id}')}`;
    if (responses[route]) return responses[route](init);
    switch (route) {
      case 'GET /albums': return Response.json(albums);
      case 'POST /albums': return Response.json({ id: ALBUM_ID, albumName: JSON.parse(init.body).albumName }, { status: 201 });
      case 'POST /assets': return Response.json({ id: ASSET_ID, status: 'created' }, { status: 201 });
      case 'PUT /albums/{id}/assets': return Response.json(JSON.parse(init.body).ids.map(id => ({ id, success: true })));
      default: return new Response('not found', { status: 404 });
    }
  };
  return { fetch, calls };
}

function library(immich) {
  return new ImmichLibrary({ url: 'http://immich.local', apiKey: 'user-key', albumName: 'Family', deviceId: 'bridge', fetch: immich.fetch, logger: silentLogger() });
}

function mediaFile() {
  const file = path.join(tempDir(), 'photo.jpg');
  fs.writeFileSync(file, 'jpeg-bytes');
  return file;
}

const uploadRequest = filePath => ({ filePath, filename: 'photo.jpg', mimetype: 'image/jpeg', takenAt: 1_700_000_000, deviceAssetId: 'msg-1' });

describe('ImmichLibrary', () => {
  it('uploads with the fields every supported Immich version accepts', async () => {
    const immich = fakeImmich();
    const result = await library(immich).upload(uploadRequest(mediaFile()));
    assert.deepEqual(result, { assetId: ASSET_ID, duplicate: false });

    const [call] = immich.calls;
    assert.equal(call.headers['x-api-key'], 'user-key');
    const form = call.body;
    assert.equal(form.get('deviceAssetId'), 'msg-1');
    assert.equal(form.get('deviceId'), 'bridge');
    assert.equal(form.get('fileCreatedAt'), '2023-11-14T22:13:20.000Z');
    assert.equal(form.get('fileModifiedAt'), '2023-11-14T22:13:20.000Z');
    const blob = form.get('assetData');
    assert.equal(blob.name, 'photo.jpg');
    assert.equal(blob.type, 'image/jpeg');
    assert.equal(await blob.text(), 'jpeg-bytes');
  });

  it('reports server-side duplicates', async () => {
    const immich = fakeImmich({ responses: { 'POST /assets': () => Response.json({ id: ASSET_ID, status: 'duplicate' }) } });
    assert.equal((await library(immich).upload(uploadRequest(mediaFile()))).duplicate, true);
  });

  it('creates the album once, then reuses it', async () => {
    const immich = fakeImmich();
    const lib = library(immich);
    await lib.addToAlbum(ASSET_ID);
    await lib.addToAlbum(ASSET_ID);
    assert.deepEqual(immich.calls.map(c => `${c.method} ${c.endpoint}`), [
      'GET /albums', 'POST /albums', `PUT /albums/${ALBUM_ID}/assets`, `PUT /albums/${ALBUM_ID}/assets`,
    ]);
  });

  it('uses an existing album with the configured name', async () => {
    const immich = fakeImmich({ albums: [{ id: 'other', albumName: 'Holidays' }, { id: ALBUM_ID, albumName: 'Family' }] });
    await library(immich).addToAlbum(ASSET_ID);
    assert.ok(!immich.calls.some(c => c.method === 'POST'));
  });

  it('treats "already in album" as success and other album errors as failures', async () => {
    const reply = error => ({ 'PUT /albums/{id}/assets': () => Response.json([{ id: ASSET_ID, success: false, error }]) });
    const albums = [{ id: ALBUM_ID, albumName: 'Family' }];
    await library(fakeImmich({ albums, responses: reply('duplicate') })).addToAlbum(ASSET_ID);
    await assert.rejects(library(fakeImmich({ albums, responses: reply('no_permission') })).addToAlbum(ASSET_ID), /no_permission/);
  });

  it('looks the album up again after it disappears', async () => {
    let first = true;
    const immich = fakeImmich({
      albums: [{ id: ALBUM_ID, albumName: 'Family' }],
      responses: { 'PUT /albums/{id}/assets': () => (first ? (first = false, new Response('gone', { status: 404 })) : Response.json([])) },
    });
    const lib = library(immich);
    await assert.rejects(lib.addToAlbum(ASSET_ID));
    await lib.addToAlbum(ASSET_ID);
    assert.equal(immich.calls.filter(c => c.endpoint === '/albums').length, 2);
  });

  it('classifies rejected media as permanent and auth or server errors as retryable', async () => {
    const failWith = status => fakeImmich({ responses: { 'POST /assets': () => new Response('nope', { status }) } });
    const errorFor = async status => library(failWith(status)).upload(uploadRequest(mediaFile())).catch(err => err);
    assert.ok(isPermanent(await errorFor(400)));
    assert.ok(!isPermanent(await errorFor(401)));
    assert.ok(!isPermanent(await errorFor(403)));
    assert.ok(!isPermanent(await errorFor(503)));
  });

  it('explains auth and permission problems in verifyAccess', async () => {
    const failWith = status => library(fakeImmich({ responses: { 'GET /albums': () => new Response('', { status }) } }));
    await assert.rejects(failWith(401).verifyAccess(), /rejected IMMICH_API_KEY/);
    await assert.rejects(failWith(403).verifyAccess(), /album\.read.*asset\.upload/);
  });

  it('only calls endpoints that a non-admin API key can use', async () => {
    const immich = fakeImmich();
    const lib = library(immich);
    await lib.verifyAccess();
    const { assetId } = await lib.upload(uploadRequest(mediaFile()));
    await lib.addToAlbum(assetId);

    const allowed = new Set(Object.keys(REQUIRED_PERMISSIONS));
    for (const call of immich.calls) {
      const route = `${call.method} ${call.endpoint.replace(ALBUM_ID, '{id}')}`;
      assert.ok(allowed.has(route), `unexpected endpoint ${route}`);
      assert.ok(!/^\/(admin|jobs|queues)/.test(call.endpoint), `admin endpoint called: ${route}`);
    }
    assert.deepEqual(new Set(Object.values(REQUIRED_PERMISSIONS)), new Set(['album.read', 'album.create', 'asset.upload', 'albumAsset.create']));
  });
});
