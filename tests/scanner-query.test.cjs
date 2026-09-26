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
