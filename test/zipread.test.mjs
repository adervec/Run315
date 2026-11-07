import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openAsBlob } from 'node:fs';
import { listEntries, readEntry, entryBlob, streamEntry } from '../js/zipread.js';
import { makeZip, blobBytes } from './fitenc.mjs';

const text = u8 => new TextDecoder().decode(u8);
const big = 'x'.repeat(100000) + 'end';

for (const zip64 of [false, true]) {
  test(`zipread: stored and deflated entries${zip64 ? ' (ZIP64 records)' : ''}`, async () => {
    const z = makeZip([
      { name: 'a/hello.txt', data: 'hello', method: 0 },
      { name: 'a/big.json', data: big, method: 8 },
      { name: 'ünï.txt', data: 'utf8 name', method: 8 },
    ], { zip64 });
    const es = await listEntries(z);
    assert.deepEqual(es.map(e => e.name), ['a/hello.txt', 'a/big.json', 'ünï.txt']);
    assert.equal(es[1].usize, big.length);
    assert.equal(text(await readEntry(z, es[0])), 'hello');
    assert.equal(text(await readEntry(z, es[1])), big);
    assert.equal(text(await readEntry(z, es[2])), 'utf8 name');
  });
}

test('zipread: a zip inside a zip, deflated or stored', async () => {
  const inner = await blobBytes(makeZip([{ name: 'x.fit', data: 'FITDATA' }, { name: 'y.fit', data: 'MORE', method: 0 }]));
  const outer = makeZip([{ name: 'readme.txt', data: 'hi' }, { name: 'U/UploadedFiles_0-_Part1.zip', data: inner, method: 8 },
    { name: 'U/UploadedFiles_0-_Part2.zip', data: inner, method: 0 }]);
  const es = await listEntries(outer);
  for (const e of es.slice(1)) {
    const b = await entryBlob(outer, e);
    assert.equal(b.size, inner.length);
    const ie = await listEntries(b);
    assert.deepEqual(ie.map(x => x.name), ['x.fit', 'y.fit']);
    assert.equal(text(await readEntry(b, ie[0])), 'FITDATA');
    assert.equal(text(await readEntry(b, ie[1])), 'MORE');
  }
});

test('zipread: errors are named', async () => {
  await assert.rejects(listEntries(new Blob([new Uint8Array(100)])), /not a zip/);
  const z = makeZip([{ name: 'a', data: 'b' }]);
  const [e] = await listEntries(z);
  await assert.rejects(streamEntry(z, { ...e, method: 12 }), /unsupported compression/);
});

// A real Garmin export on this machine, when there is one: the directory reads in place.
const REAL = 'C:\\Users\\Adam Erik Eryavec\\Downloads\\366ba449-ce28-41cc-b707-bfbbf7d732ea_1.zip';
test('zipread: a real Garmin export lists', { skip: !existsSync(REAL) && 'no Garmin export on this machine' }, async () => {
  const b = await openAsBlob(REAL);
  const es = await listEntries(b);
  assert.ok(es.some(e => /summarizedActivities/.test(e.name)));
  const z = es.find(e => /UploadedFiles.*\.zip$/.test(e.name));
  assert.ok(z);
});
