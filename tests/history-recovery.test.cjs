'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHistoryStore, safeHistoryItem, MAX_HISTORY_BYTES } = require('../electron/history.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'history.json') };
}

function record(overrides = {}) {
  return { id: 'operation-1', planId: 'plan-1', time: 1000, rootPath: '/synthetic', state: 'running', totalBytes: 12, total: 1, success: 0, failed: 0, skipped: 0, cancelled: 0, items: [{ path: '/synthetic/file.txt', status: 'pending', kind: 'file', size: 12 }], freeSpaceDelta: null, ...overrides };
}

test('upsert replaces the same operation, preserves journal fields, and snapshots inputs', async (t) => {
  const f = await fixture(t);
  const store = createHistoryStore(f.file);
  const initial = record();
  const saved = store.upsert(initial);
  initial.items[0].status = 'trashed';
  await saved;
  assert.equal((await store.list())[0].items[0].status, 'pending');
  const complete = record({ state: 'completed', success: 1, finishedAt: 2000, items: [{ path: '/synthetic/file.txt', status: 'trashed', kind: 'file', size: 12 }], freeSpaceDelta: -4096 });
  await store.upsert(complete);
  const records = await store.list();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], complete);
  records[0].items[0].path = 'caller mutation';
  assert.equal((await store.list())[0].items[0].path, '/synthetic/file.txt');
});

test('cold read recovers pending and in-flight states conservatively and persists recovery', async (t) => {
  const f = await fixture(t);
  const existingPath = path.join(f.root, 'still-existing.txt');
  const missingPath = path.join(f.root, 'never-existed.txt');
  await fs.writeFile(existingPath, 'synthetic evidence');
  const unfinished = record({ total: 4, success: 1, failed: 1, freeSpaceDelta: 99, items: [
    { path: existingPath, status: 'trashed', kind: 'file', size: 1 },
    { path: missingPath, status: 'processing', kind: 'file', size: 2 },
    { path: existingPath, status: 'pending', kind: 'directory', size: 3 },
    { path: '/synthetic/failed', status: 'failed', error: 'TRASH_FAILED' },
  ] });
  const live = createHistoryStore(f.file);
  await live.upsert(unfinished);
  assert.equal((await live.list())[0].state, 'running', 'A live operation must not be treated as a crash.');
  const recovered = (await createHistoryStore(f.file).list())[0];
  assert.equal(recovered.state, 'interrupted');
  assert.deepEqual(recovered.items.map((item) => item.status), ['trashed', 'unknown', 'cancelled', 'failed']);
  assert.equal(recovered.items[1].error, 'RESULT_UNCERTAIN');
  assert.equal(recovered.items[2].error, 'APP_INTERRUPTED');
  assert.equal(recovered.success, 1);
  assert.equal(recovered.failed, 1);
  assert.equal(recovered.cancelled, 1);
  assert.equal(recovered.freeSpaceDelta, null);
  assert.equal(Object.hasOwn(recovered, 'spaceMeasurement'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8'))[0], recovered);
  assert.equal(await fs.readFile(existingPath, 'utf8'), 'synthetic evidence');
  assert.deepEqual(await createHistoryStore(f.file).list(), [recovered]);
});

test('old alpha.1 records without state remain usable without inventing successful operations', async (t) => {
  const f = await fixture(t);
  const legacy = { id: 'legacy', time: 100, rootPath: '/old', success: 1, failed: 1, items: [{ path: '/old/a', status: 'trashed' }, { path: '/old/b', status: 'failed', error: 'EACCES' }], freeSpaceDelta: 0 };
  await fs.writeFile(f.file, JSON.stringify([legacy]));
  const migrated = (await createHistoryStore(f.file).list())[0];
  assert.equal(migrated.state, 'completed');
  assert.equal(migrated.total, 2);
  assert.equal(migrated.totalBytes, 0);
  assert.equal(migrated.success, 1);
  assert.deepEqual(migrated.items, legacy.items);
  assert.equal(migrated.freeSpaceDelta, 0);
  assert.equal(Object.hasOwn(migrated, 'spaceMeasurement'), false);
});

test('corrupt JSON blocks new journal writes and remains intact until explicit clear', async (t) => {
  const f = await fixture(t);
  const invalid = '{"unfinished":';
  await fs.writeFile(f.file, invalid);
  const store = createHistoryStore(f.file);
  await assert.rejects(store.list(), { code: 'HISTORY_CORRUPT' });
  await assert.rejects(store.upsert(record()), { code: 'HISTORY_CORRUPT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), invalid);
  await store.clear();
  assert.deepEqual(await store.list(), []);
  await store.upsert(record({ state: 'completed', items: [] }));
  assert.equal((await store.list()).length, 1);
});

test('invalid records and duplicate operation IDs are rejected rather than silently dropped', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify([record({ items: [{ path: '/a', status: 'unrecognized' }] })]));
  await assert.rejects(createHistoryStore(f.file).list(), { code: 'HISTORY_CORRUPT' });
  await fs.writeFile(f.file, JSON.stringify([record(), record()]));
  await assert.rejects(createHistoryStore(f.file).list(), { code: 'HISTORY_CORRUPT' });
  const oversized = record({ items: Array.from({ length: 501 }, () => ({ path: '/synthetic', status: 'pending' })) });
  assert.equal(safeHistoryItem(oversized), null);
});

test('oversized history is refused without overwriting it; clear remains an explicit recovery path', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, 'x');
  await fs.truncate(f.file, MAX_HISTORY_BYTES + 1);
  const store = createHistoryStore(f.file);
  await assert.rejects(store.list(), { code: 'HISTORY_TOO_LARGE' });
  await assert.rejects(store.upsert(record()), { code: 'HISTORY_TOO_LARGE' });
  assert.equal((await fs.stat(f.file)).size, MAX_HISTORY_BYTES + 1);
  await store.clear();
  assert.deepEqual(await store.list(), []);
});

test('atomic rename failure preserves the prior journal and removes only its own temporary file', async (t) => {
  const f = await fixture(t);
  const previous = record({ state: 'completed', items: [] });
  await createHistoryStore(f.file).upsert(previous);
  const original = await fs.readFile(f.file, 'utf8');
  const store = createHistoryStore(f.file, { io: { ...fs, rename: async () => { throw Object.assign(new Error('Synthetic rename failure'), { code: 'EIO' }); } } });
  await assert.rejects(store.upsert(record({ id: 'new-operation' })), { code: 'HISTORY_WRITE_FAILED' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.deepEqual((await store.list()).map((item) => item.id), ['operation-1']);
  assert.deepEqual(await fs.readdir(f.root), ['history.json']);
});

test('recovery write failure surfaces and does not falsely report a durable recovered state', async (t) => {
  const f = await fixture(t);
  await createHistoryStore(f.file).upsert(record());
  const original = await fs.readFile(f.file, 'utf8');
  const store = createHistoryStore(f.file, { io: { ...fs, rename: async () => { throw new Error('Synthetic disk failure'); } } });
  await assert.rejects(store.list(), { code: 'HISTORY_WRITE_FAILED' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.equal((await createHistoryStore(f.file).list())[0].state, 'interrupted');
});

test('a failed terminal checkpoint invalidates live cache and recovers the persisted in-flight result', async (t) => {
  const f = await fixture(t);
  let failRename = false;
  const store = createHistoryStore(f.file, { io: { ...fs, rename: async (...args) => {
    if (failRename) throw new Error('Synthetic terminal checkpoint failure');
    return fs.rename(...args);
  } } });
  await store.upsert(record());
  await store.upsert(record({ items: [{ path: '/synthetic/no-longer-present', status: 'processing', kind: 'file', size: 12 }] }));
  failRename = true;
  await assert.rejects(store.upsert(record({ state: 'completed', success: 1, items: [{ path: '/synthetic/no-longer-present', status: 'trashed', kind: 'file', size: 12 }] })), { code: 'HISTORY_WRITE_FAILED' });
  failRename = false;
  const reloaded = (await store.list())[0];
  assert.equal(reloaded.state, 'interrupted');
  assert.equal(reloaded.items[0].status, 'unknown');
  assert.equal(reloaded.items[0].error, 'RESULT_UNCERTAIN');
  assert.equal(reloaded.success, 0);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8'))[0].state, 'interrupted');
});

test('read permission failures are surfaced without resetting the history', async (t) => {
  const f = await fixture(t);
  await createHistoryStore(f.file).upsert(record({ state: 'completed', items: [] }));
  const original = await fs.readFile(f.file, 'utf8');
  const store = createHistoryStore(f.file, { io: { ...fs, readFile: async () => { throw Object.assign(new Error('Synthetic denied read'), { code: 'EACCES' }); } } });
  await assert.rejects(store.list(), { code: 'HISTORY_READ_FAILED' });
  await assert.rejects(store.upsert(record({ id: 'new' })), { code: 'HISTORY_READ_FAILED' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
});

test('concurrent upserts and append compatibility retain at most 50 distinct operations', async (t) => {
  const f = await fixture(t);
  const store = createHistoryStore(f.file);
  assert.equal(store.append, store.upsert);
  await Promise.all(Array.from({ length: 60 }, (_, i) => store.append(record({ id: `op-${i}`, time: i, state: 'completed', items: [] }))));
  await store.upsert(record({ id: 'op-20', state: 'completed', items: [], finishedAt: 2500 }));
  const result = await store.list();
  assert.equal(result.length, 50);
  assert.equal(result[0].id, 'op-20');
  assert.equal(result.filter((item) => item.id === 'op-20').length, 1);
  assert.equal(result.at(-1).id, 'op-10');
});

function sample(overrides = {}) {
  return { measuredAt: 1000, total: 4096, free: 1024, ...overrides };
}

function measurement(overrides = {}) {
  return { version: 1, before: sample(), after: sample({ measuredAt: 2000, free: 1536 }), status: 'comparable', ...overrides };
}

test('all measurement statuses persist with their sample and delta semantics intact', async (t) => {
  const f = await fixture(t);
  const store = createHistoryStore(f.file);
  const cases = [
    measurement(),
    measurement({ status: 'pending', after: null }),
    measurement({ status: 'pending', before: null, after: null }),
    measurement({ status: 'not-run', before: null, after: null }),
    measurement({ status: 'interrupted', after: null }),
    measurement({ status: 'unavailable', before: null }),
    measurement({ status: 'unavailable', after: null }),
    measurement({ status: 'unavailable', before: null, after: null }),
    measurement({ status: 'root-changed', before: null }),
    measurement({ status: 'root-changed', after: null }),
    measurement({ status: 'root-changed', before: null, after: null }),
    measurement({ status: 'volume-changed' }),
    measurement({ status: 'volume-changed', after: sample({ total: 8192 }) }),
  ];
  for (const [index, value] of cases.entries()) {
    await store.upsert(record({ id: `measurement-${index}`, state: 'completed', items: [], spaceMeasurement: value, freeSpaceDelta: value.status === 'comparable' ? 512 : null }));
  }
  const reloaded = await createHistoryStore(f.file).list();
  for (const [index, value] of cases.entries()) {
    const saved = reloaded.find(item => item.id === `measurement-${index}`);
    assert.deepEqual(saved.spaceMeasurement, value);
    assert.equal(saved.freeSpaceDelta, value.status === 'comparable' ? 512 : null);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), reloaded);
});

test('comparable positive, zero and negative deltas allow clock rollback, epoch zero and full volumes', async (t) => {
  const f = await fixture(t);
  const cases = [
    [sample(), sample({ free: 1536 }), 512],
    [sample(), sample(), 0],
    [sample(), sample({ free: 0 }), -1024],
    [sample({ measuredAt: 5000, free: 0 }), sample({ measuredAt: 0, free: 4096 }), 4096],
    [sample({ total: Number.MAX_SAFE_INTEGER, free: 0 }), sample({ total: Number.MAX_SAFE_INTEGER, free: Number.MAX_SAFE_INTEGER }), Number.MAX_SAFE_INTEGER],
  ];
  const store = createHistoryStore(f.file);
  for (const [index, [before, after, delta]] of cases.entries()) {
    await store.upsert(record({ id: `delta-${index}`, state: 'completed', items: [], spaceMeasurement: measurement({ before, after }), freeSpaceDelta: delta }));
  }
  for (const [index, [before, after, delta]] of cases.entries()) {
    const saved = (await createHistoryStore(f.file).list()).find(item => item.id === `delta-${index}`);
    assert.deepEqual(saved.spaceMeasurement, measurement({ before, after }));
    assert.equal(saved.freeSpaceDelta, delta);
  }
});

test('measurement samples are snapshotted at upsert and detached from sanitizer and list results', async (t) => {
  const f = await fixture(t);
  const initial = record({ state: 'completed', items: [], spaceMeasurement: measurement(), freeSpaceDelta: 512 });
  const expected = structuredClone(initial.spaceMeasurement);
  const sanitized = safeHistoryItem(initial);
  sanitized.spaceMeasurement.before.free = 3;
  sanitized.spaceMeasurement.after.measuredAt = 9;
  assert.deepEqual(initial.spaceMeasurement, expected);
  const store = createHistoryStore(f.file);
  const pending = store.upsert(initial);
  initial.spaceMeasurement.before.free = 1;
  initial.spaceMeasurement.after.free = 2;
  initial.spaceMeasurement.status = 'not-run';
  await pending;
  const result = (await store.list())[0];
  assert.deepEqual(result.spaceMeasurement, expected);
  result.spaceMeasurement.before.total = 1;
  result.spaceMeasurement.after.free = 4;
  assert.deepEqual((await store.list())[0].spaceMeasurement, expected);
  assert.deepEqual((await createHistoryStore(f.file).list())[0].spaceMeasurement, expected);
});

test('cold recovery retains only the before sample and persists interrupted measurement status', async (t) => {
  const f = await fixture(t);
  const store = createHistoryStore(f.file);
  // Even a measured result is not treated as durable completion while its operation is running.
  await store.upsert(record({ spaceMeasurement: measurement(), freeSpaceDelta: 512, items: [{ path: '/synthetic/file.txt', status: 'processing' }] }));
  assert.equal((await store.list())[0].spaceMeasurement.status, 'comparable');
  const recovered = (await createHistoryStore(f.file).list())[0];
  assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.items[0].status, 'unknown');
  assert.equal(recovered.freeSpaceDelta, null);
  assert.deepEqual(recovered.spaceMeasurement, measurement({ after: null, status: 'interrupted' }));
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8'))[0], recovered);
  assert.deepEqual(await createHistoryStore(f.file).list(), [recovered]);
  recovered.spaceMeasurement.before.free = 7;
  assert.equal((await createHistoryStore(f.file).list())[0].spaceMeasurement.before.free, 1024);
});

test('cold recovery does not invent a missing before sample from an available after sample', async (t) => {
  const f = await fixture(t);
  await createHistoryStore(f.file).upsert(record({ spaceMeasurement: measurement({ before: null, status: 'root-changed' }), freeSpaceDelta: null }));
  const recovered = (await createHistoryStore(f.file).list())[0];
  assert.deepEqual(recovered.spaceMeasurement, { version: 1, before: null, after: null, status: 'interrupted' });
  assert.equal(recovered.freeSpaceDelta, null);
});

test('legacy signed measurements survive read and write without fabricated verification fields', async (t) => {
  const f = await fixture(t);
  const legacy = record({ state: 'completed', items: [], freeSpaceDelta: -1234 });
  await fs.writeFile(f.file, JSON.stringify([legacy]));
  const store = createHistoryStore(f.file);
  const read = (await store.list())[0];
  assert.equal(read.freeSpaceDelta, -1234);
  assert.equal(Object.hasOwn(read, 'spaceMeasurement'), false);
  await store.upsert(read);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(f.file, 'utf8'))[0], 'spaceMeasurement'), false);
  assert.equal((await createHistoryStore(f.file).list())[0].freeSpaceDelta, -1234);
});

test('invalid new measurement shapes and inconsistent delta semantics reject the whole record', async (t) => {
  const f = await fixture(t);
  const store = createHistoryStore(f.file);
  const invalid = [
    { spaceMeasurement: undefined }, { spaceMeasurement: null }, { spaceMeasurement: [] }, { spaceMeasurement: 'legacy' },
    { spaceMeasurement: measurement({ version: 2 }) }, { spaceMeasurement: measurement({ version: undefined }) },
    { spaceMeasurement: measurement({ status: 'unknown' }) },
    { spaceMeasurement: measurement({ before: undefined }) }, { spaceMeasurement: measurement({ after: undefined }) },
    { spaceMeasurement: measurement({ before: null }) }, { spaceMeasurement: measurement({ after: null }) },
    { spaceMeasurement: measurement({ before: sample({ total: 8192 }) }) },
    { spaceMeasurement: measurement(), freeSpaceDelta: 511 },
    { spaceMeasurement: measurement(), freeSpaceDelta: null },
    { spaceMeasurement: measurement(), freeSpaceDelta: undefined },
    { spaceMeasurement: measurement({ status: 'pending' }), freeSpaceDelta: null },
    { spaceMeasurement: measurement({ status: 'interrupted' }), freeSpaceDelta: null },
    { spaceMeasurement: measurement({ status: 'not-run', after: null }), freeSpaceDelta: null },
    { spaceMeasurement: measurement({ status: 'not-run', before: null }), freeSpaceDelta: null },
    { spaceMeasurement: measurement({ status: 'volume-changed', before: null }), freeSpaceDelta: null },
    { spaceMeasurement: measurement({ status: 'volume-changed', after: null }), freeSpaceDelta: null },
    { spaceMeasurement: measurement({ status: 'unavailable' }), freeSpaceDelta: null },
    { spaceMeasurement: measurement({ status: 'root-changed' }), freeSpaceDelta: null },
  ];
  for (const status of ['pending', 'unavailable', 'root-changed', 'volume-changed', 'not-run', 'interrupted']) {
    const valid = measurement({ status, before: status === 'not-run' ? null : sample(), after: status === 'volume-changed' ? sample() : null });
    for (const delta of [0, 1, -1, undefined]) invalid.push({ spaceMeasurement: valid, freeSpaceDelta: delta });
  }
  for (const [index, value] of invalid.entries()) {
    const item = record({ state: 'completed', items: [], freeSpaceDelta: 512, ...value });
    assert.equal(safeHistoryItem(item), null, `Invalid case ${index} must not become legacy history.`);
    await assert.rejects(store.upsert(item), { code: 'INVALID_HISTORY_ITEM' });
  }
  assert.deepEqual(await store.list(), []);
});

test('invalid or unsafe sample numbers are rejected in either endpoint', async () => {
  const invalid = [
    { measuredAt: -1 }, { measuredAt: 0.5 }, { measuredAt: Number.MAX_SAFE_INTEGER + 1 },
    { measuredAt: NaN }, { measuredAt: Infinity }, { measuredAt: undefined },
    { total: 0 }, { total: -1 }, { total: 4096.5 }, { total: Number.MAX_SAFE_INTEGER + 1 },
    { total: '4096' }, { total: Infinity }, { total: undefined },
    { free: -1 }, { free: 4097 }, { free: 0.5 }, { free: Number.MAX_SAFE_INTEGER + 1 },
    { free: null }, { free: NaN }, { free: undefined },
  ];
  for (const endpoint of ['before', 'after']) {
    for (const values of invalid) {
      const spaceMeasurement = measurement({ [endpoint]: sample(values) });
      assert.equal(safeHistoryItem(record({ spaceMeasurement, freeSpaceDelta: 512 })), null);
    }
    assert.equal(safeHistoryItem(record({ spaceMeasurement: measurement({ [endpoint]: [] }), freeSpaceDelta: 512 })), null);
  }
});

test('malformed persisted measurements block reading and writes without silently dropping the field', async (t) => {
  const f = await fixture(t);
  const invalid = record({ state: 'completed', items: [], spaceMeasurement: measurement(), freeSpaceDelta: 4096 });
  const original = JSON.stringify([invalid]);
  await fs.writeFile(f.file, original);
  const store = createHistoryStore(f.file);
  await assert.rejects(store.list(), { code: 'HISTORY_CORRUPT' });
  await assert.rejects(store.upsert(record({ id: 'other' })), { code: 'HISTORY_CORRUPT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
});
