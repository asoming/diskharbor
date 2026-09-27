'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ScanIndex } = require('../electron/scanner.cjs');
const { populateSyntheticIndex, fixtureStat } = require('./performance-fixtures.cjs');
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// Independent complete-sort oracle for the public query contract. It never
// uses the prefix selector, its cache, or transformed production source.
function reference(entries, query) {
  const matching = entries.filter(entry => (!query.category || entry.category === query.category)
    && (!query.search || `${entry.name}\n${entry.path}`.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))
    && entry.logicalSize >= (query.minSize || 0));
  const visible = matching.filter(entry => (query.includeHidden || !entry.hiddenPath) && (query.includeSystem || !entry.systemPath));
  const sign = query.sortDirection === 'asc' ? 1 : -1;
  visible.sort((a, b) => {
    const left = a[query.sortBy], right = b[query.sortBy];
    if (left === null || right === null) return left === null ? right === null ? a.id - b.id : 1 : -1;
    const primary = query.sortBy === 'name' ? collator.compare(left, right) : left - right;
    return sign * primary || collator.compare(a.name, b.name) || a.id - b.id;
  });
  return { entries: visible, filteredCount: matching.length - visible.length };
}

test('bounded query prefixes and deep cached pages match full sorting in 1600 cases', async () => {
  const index = new ScanIndex(path.resolve('query-fixture'));
  await populateSyntheticIndex(index, 12031);
  for (let id = 2; id < index._records.length; id++) {
    const entry = index._records[id].entry;
    entry.hiddenPath = id % 5 === 0;
    entry.systemPath = id % 7 === 0;
    if (id % 17 === 0) entry.allocatedSize = null;
    if (id % 9 === 0) entry.name = `same-${id % 3}.txt`;
    entry.category = id % 2 ? 'documents' : 'other';
  }
  const entries = Array.from({ length: 12031 }, (_, offset) => index.entry(offset + 2));
  let comparisons = 0;
  for (const sortBy of ['name', 'allocatedSize', 'logicalSize', 'modifiedAt']) for (const sortDirection of ['asc', 'desc']) {
    for (const [includeHidden, includeSystem] of [[true, true], [false, true], [true, false], [false, false]]) {
      for (const filter of [{}, { category: 'documents' }, { search: 'file-0' }, { minSize: 9000 }, { search: 'no-match' }]) {
        const query = { parentId: 1, sortBy, sortDirection, includeHidden, includeSystem, ...filter };
        const expected = reference(entries, query);
        for (const [offset, limit] of [[0, 0], [0, 4], [0, 100], [99, 100], [200, 500], [900, 100], [1000, 100], [12000, 100], [99999, 100], [0, 100]]) {
          assert.deepEqual(index.query({ ...query, offset, limit }), {
            entries: expected.entries.slice(offset, offset + limit), total: expected.entries.length, filteredCount: expected.filteredCount,
          }, `${sortBy}/${sortDirection}/${includeHidden}/${includeSystem} offset=${offset} limit=${limit}`);
          comparisons++;
        }
      }
    }
  }
  assert.equal(comparisons, 1600);
});

test('query prefix caches invalidate on new records and support global/default visibility queries', async () => {
  const index = new ScanIndex(path.resolve('query-revision-fixture'));
  await populateSyntheticIndex(index, 1500);
  const first = index.query({ sortBy: 'name', limit: 4 });
  assert.equal(first.total, 1500);
  assert.equal('filteredCount' in first, false);
  const root = index._records[1];
  const added = index._newRecord(root, path.join(index.rootPath, '000-added.txt'), '000-added.txt', 'file');
  index._setMetadata(added, fixtureStat(1600), index.rootPath, fixtureStat(0, true));
  index._acceptLeaf(added);
  const next = index.query({ sortBy: 'name', sortDirection: 'asc', limit: 4 });
  assert.equal(next.total, 1501);
  assert.equal(next.entries[0].name, '000-added.txt');
  assert.deepEqual(index.query({ parentId: 999999, limit: 100 }), { entries: [], total: 0 });
  assert.equal(index.query({ kind: 'file', limit: 10000 }).entries.length, 1501);
});

test('shared memberships preserve independent prefixes and alternating deep-page order', async () => {
  const index = new ScanIndex(path.resolve('query-alias-fixture'));
  await populateSyntheticIndex(index, 2403);
  for (const { entry } of index._records.slice(2)) {
    entry.hiddenPath = entry.id % 11 === 0;
    entry.systemPath = entry.id % 7 === 0;
    if (entry.id % 9 === 0) entry.allocatedSize = null;
    if (entry.id % 13 === 0) entry.name = 'Equal name';
  }
  const entries = index._records.slice(2).map(record => ({ ...record.entry }));
  const base = { parentId: 1, includeHidden: false, includeSystem: false };
  const check = (sortBy, sortDirection, offset, options = {}) => {
    const query = { ...base, sortBy, sortDirection, offset, limit: 100, ...options };
    const expected = reference(entries, query);
    assert.deepEqual(index.query(query), { entries: expected.entries.slice(offset, offset + 100), total: expected.entries.length, filteredCount: expected.filteredCount });
    assert.ok(index._queryCache.size <= 2);
  };
  check('name', 'asc', 0);
  check('allocatedSize', 'desc', 0);
  const arrays = () => new Set([...index._queryCache.values()].map(item => item.entries));
  assert.equal(arrays().size, 1, 'Same membership retains one candidate array');
  for (let round = 0; round < 3; round++) {
    check('name', 'asc', 1200);
    check('allocatedSize', 'desc', 1200);
    check('name', 'asc', 0);
    check('allocatedSize', 'desc', 0);
  }
  check('logicalSize', 'asc', 1200); // evict one sort without losing shared membership
  check('name', 'desc', 1200);
  check('logicalSize', 'asc', 0);
  assert.equal(arrays().size, 1);
  check('name', 'asc', 0, { includeHidden: true });
  assert.equal(arrays().size, 2, 'Different visibility must retain separate membership');
  check('name', 'asc', 0, { search: 'no-result' });
  check('name', 'desc', 1200, { search: 'no-result' });
  assert.equal(arrays().size, 1, 'Empty memberships share without gaining entries');
  // A new scan record invalidates shared arrays, totals and filtered counts.
  const root = index._records[1], name = '.new-hidden.txt';
  const added = index._newRecord(root, path.join(index.rootPath, name), name, 'file');
  index._setMetadata(added, fixtureStat(3000), index.rootPath, fixtureStat(0, true));
  index._acceptLeaf(added); entries.push(index.entry(added.entry.id));
  check('name', 'desc', 1200);
  check('allocatedSize', 'asc', 0);
});

test('all sort prefixes stay bounded across two memberships, deep sorts and revisions', async () => {
  const index = new ScanIndex(path.resolve('query-prefix-budget-fixture'));
  await populateSyntheticIndex(index, 5031);
  const names = ['file-10', 'file-2', 'Éclair', 'eclair', 'Alpha', 'alpha', 'foo02', 'foo2', '相同'];
  for (const { entry } of index._records.slice(2)) {
    entry.name = names[entry.id % names.length];
    entry.hiddenPath = entry.id % 5 === 0;
    entry.allocatedSize = entry.id % 13 === 0 ? null : entry.id % 4 * 4096;
    entry.modifiedAt = entry.id % 17 === 0 ? null : entry.id % 3;
  }
  const entries = index._records.slice(2).map(record => ({ ...record.entry }));
  const check = (sortBy, sortDirection, includeHidden, offset = 0, limit = 1000) => {
    const query = { parentId: 1, sortBy, sortDirection, includeHidden, includeSystem: true, offset, limit };
    const expected = reference(entries, query);
    assert.deepEqual(index.query(query), { entries: expected.entries.slice(offset, offset + limit), total: expected.entries.length, filteredCount: expected.filteredCount });
    assert.ok(index._queryCache.size <= 2);
  };
  // Interleave two memberships so both remain live while all eight orders are
  // visited. This reaches the real reference-storage bound, not just one page.
  for (const sortBy of ['name', 'allocatedSize', 'logicalSize', 'modifiedAt']) {
    for (const direction of ['asc', 'desc']) for (const hidden of [true, false]) check(sortBy, direction, hidden);
  }
  const caches = [...index._queryCache.values()];
  assert.equal(new Set(caches.map(cache => cache.entries)).size, 2);
  assert.equal(new Set(caches.map(cache => cache.prefixes)).size, 2);
  let retainedReferences = 0;
  for (const cache of caches) {
    assert.equal(cache.prefixes.size, 8);
    for (const prefix of cache.prefixes.values()) {
      assert.equal(prefix.length, 1000);
      retainedReferences += prefix.length;
    }
  }
  assert.equal(retainedReferences, 16000);
  // Sorting the shared full array must neither mutate a saved prefix nor let
  // another cached order incorrectly reuse the full array's sorted flag.
  const saved = caches.find(cache => !cache.entries.some(entry => entry.hiddenPath)).prefixes;
  const namePrefix = saved.get('name:1');
  const namesBefore = namePrefix.map(entry => entry.id);
  check('name', 'asc', false, 1300, 100);
  check('allocatedSize', 'desc', false, 1300, 100);
  check('name', 'asc', false, 0, 100);
  check('modifiedAt', 'asc', false, 1300, 100);
  check('logicalSize', 'desc', false, 0, 1000);
  assert.deepEqual(namePrefix.map(entry => entry.id), namesBefore);
  assert.equal([...index._queryCache.values()][0].prefixes, saved);
  // Unknown sort inputs normalize to the finite public order set.
  index.query({ parentId: 1, includeHidden: false, includeSystem: true, sortBy: 'unexpected', sortDirection: 'unexpected', limit: 100 });
  assert.equal(saved.size, 8);
  const root = index._records[1], name = '!added-after-prefix.txt';
  const added = index._newRecord(root, path.join(index.rootPath, name), name, 'file');
  index._setMetadata(added, fixtureStat(6000), index.rootPath, fixtureStat(0, true));
  index._acceptLeaf(added); entries.push(index.entry(added.entry.id));
  check('name', 'asc', false, 0, 1000);
  assert.equal(index._queryCache.size, 1);
  const refreshed = [...index._queryCache.values()][0];
  assert.notEqual(refreshed.prefixes, saved);
  assert.equal(refreshed.prefixes.size, 1);
  assert.ok(refreshed.prefixes.get('name:1').some(entry => entry.id === added.entry.id));
});

test('prefix reuse preserves filtered visibility, unknown sizes and locale-equivalent ties', async () => {
  const index = new ScanIndex(path.resolve('query-prefix-filters-fixture'));
  await populateSyntheticIndex(index, 2403);
  const names = ['Résumé-2', 'resume-02', 'resume-10', 'A', 'a', '中文-2', '中文-10'];
  for (const { entry } of index._records.slice(2)) {
    entry.name = names[entry.id % names.length];
    entry.hiddenPath = entry.id % 5 === 0;
    entry.systemPath = entry.id % 7 === 0;
    entry.category = entry.id % 3 ? 'documents' : 'other';
    entry.allocatedSize = entry.id % 11 ? entry.id % 4 * 4096 : null;
    entry.modifiedAt = entry.id % 13 ? entry.id % 4 : null;
  }
  const entries = index._records.slice(2).map(record => ({ ...record.entry }));
  let comparisons = 0;
  for (const filter of [{}, { category: 'other' }, { search: 'résumé' }, { minSize: 2500 }, { search: 'no-result' }]) {
    for (const [includeHidden, includeSystem] of [[true, true], [false, true], [true, false], [false, false]]) {
      for (const sortBy of ['name', 'allocatedSize', 'logicalSize', 'modifiedAt']) for (const sortDirection of ['asc', 'desc']) {
        const query = { parentId: 1, includeHidden, includeSystem, sortBy, sortDirection, ...filter };
        const expected = reference(entries, query);
        for (const [offset, limit] of [[0, 1000], [999, 100], [1300, 150]]) {
          assert.deepEqual(index.query({ ...query, offset, limit }), {
            entries: expected.entries.slice(offset, offset + limit), total: expected.entries.length, filteredCount: expected.filteredCount,
          });
          comparisons++;
        }
      }
    }
  }
  assert.equal(comparisons, 480);
});

test('shared identity strings preserve changed parents, device IDs and distinct nanoseconds', () => {
  const index = new ScanIndex(path.resolve('identity-sharing-fixture'));
  const parent = fixtureStat(0, true);
  const root = index._newRecord(null, index.rootPath, 'root', 'directory');
  index._setMetadata(root, parent, path.dirname(index.rootPath), parent);
  const create = (name, stat) => {
    const record = index._newRecord(root, path.join(index.rootPath, name), name, 'file');
    index._setMetadata(record, stat, index.rootPath, parent);
    return index.entryIdentity(record.entry.id);
  };
  const firstStat = fixtureStat(1);
  const first = create('first.txt', firstStat);
  assert.equal(first.parentDev, '42'); assert.equal(first.parentIno, '1');
  assert.equal(first.mtimeNs, firstStat.mtimeNs.toString()); assert.equal(first.ctimeNs, first.mtimeNs);
  parent.dev = 9876543210123456789n; parent.ino = 9007199254740993n;
  const nextStat = fixtureStat(2);
  nextStat.dev = parent.dev;
  nextStat.ino = 9007199254740995n;
  nextStat.mtimeNs = 1790000000000000001n;
  nextStat.ctimeNs = 1790000000000000002n;
  const next = create('second.txt', nextStat);
  assert.equal(next.parentDev, parent.dev.toString()); assert.equal(next.parentIno, parent.ino.toString());
  assert.equal(next.dev, nextStat.dev.toString()); assert.equal(next.ino, nextStat.ino.toString());
  assert.equal(next.mtimeNs, '1790000000000000001'); assert.equal(next.ctimeNs, '1790000000000000002');
  assert.equal(first.parentDev, '42'); assert.equal(first.parentIno, '1');
});

test('both public identity exports reconstruct the complete millisecond contract from exact nanoseconds', () => {
  const index = new ScanIndex(path.resolve('identity-export-fixture'));
  const parent = fixtureStat(0, true);
  const root = index._newRecord(null, index.rootPath, 'root', 'directory');
  index._setMetadata(root, parent, path.dirname(index.rootPath), parent);
  const cases = [0n, -1000000001n, 1790000000000000001n, 9007199254740993123n];
  for (const [number, ns] of cases.entries()) {
    const name = `identity-${number}.txt`, fullPath = path.join(index.rootPath, name);
    const stat = { ...fixtureStat(number + 1), mtimeNs: ns, ctimeNs: ns + 999999n };
    const record = index._newRecord(root, fullPath, name, 'file');
    index._setMetadata(record, stat, index.rootPath, parent);
    const expected = {
      path: fullPath, dev: stat.dev.toString(), ino: stat.ino.toString(),
      mode: Number(stat.mode), size: Number(stat.size), nlink: Number(stat.nlink),
      mtimeMs: Number(stat.mtimeNs) / 1e6, ctimeMs: Number(stat.ctimeNs) / 1e6,
      birthtimeMs: Number(stat.birthtimeNs) / 1e6,
      mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
      parentRealPath: index.rootPath, kind: 'file', parentDev: parent.dev.toString(), parentIno: parent.ino.toString(),
    };
    assert.deepEqual(index.entryIdentity(record.entry.id), expected);
    assert.deepEqual(index.cleanupManifest(record.entry.id).entries[0].identity, expected);
    assert.equal(Object.hasOwn(record.identity, 'mtimeMs'), false);
    assert.equal(Object.hasOwn(record.identity, 'ctimeMs'), false);
    const copy = index.entryIdentity(record.entry.id); copy.mtimeNs = '0';
    assert.equal(index.entryIdentity(record.entry.id).mtimeNs, expected.mtimeNs);
  }
});
