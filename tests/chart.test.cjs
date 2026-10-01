'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { ScanIndex } = require('../electron/scanner.cjs');
const { buildChartReport, ROOT_LIMIT, CHILD_LIMIT } = require('../electron/chart-data.cjs');
const ts = require('typescript');
const layout = {};
new Function('exports', ts.transpileModule(fsSync.readFileSync(path.join(__dirname, '../src/chart-layout.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(layout);

function synthetic(records, scanState = 'completed') {
  const byId = new Map(records.map(node => [node.entry.id, node]));
  return { record: id => byId.get(id), children: id => records.filter(node => node.entry.parentId === id).map(node => node.entry.id),
    ancestors: () => [], scanId: 'synthetic-chart', scanState };
}
function record(id, parentId, value, options = {}) {
  return { allocatedKnown: value, unknownAllocated: 0, entry: { id, parentId, name: `${id}.txt`, path: `/owned/${id}.txt`,
    kind: 'file', allocatedSize: value, logicalSize: value, state: 'ready', hiddenPath: false, systemPath: false, ...options } };
}
const options = { entryId: 1, metric: 'allocated', includeHidden: true, includeSystem: true };
const sum = nodes => nodes.reduce((n, node) => n + node.value, 0);

test('native chart totals match the scanner, with directory descendants counted only once', async t => {
  const output = path.resolve(__dirname, '../output');
  await fs.mkdir(output, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(output, 'chart-unit-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '中文目录'));
  await fs.writeFile(path.join(root, '中文目录', 'report.txt'), Buffer.alloc(16385));
  await fs.writeFile(path.join(root, 'archive.zip'), Buffer.alloc(4097));
  await fs.writeFile(path.join(root, 'empty'), '');
  await fs.link(path.join(root, 'archive.zip'), path.join(root, '中文目录', 'linked.zip'));
  const index = new ScanIndex(root);
  const summary = await index.scan();
  const allocated = index.chart(options);
  assert.equal(allocated.totalBytes, summary.scannedBytes);
  assert.equal(sum(allocated.nodes), summary.scannedBytes);
  assert.equal(allocated.nodes.length, 3);
  const folder = allocated.nodes.find(node => node.entry.kind === 'directory');
  assert.equal(sum(folder.children), folder.value);
  const logical = index.chart({ ...options, metric: 'logical' });
  assert.equal(logical.totalBytes, summary.logicalBytes);
  assert.equal(sum(logical.nodes), summary.logicalBytes);
  assert.equal(summary.files, 4);
  assert.equal(allocated.unknownAllocatedEntries, summary.coverage.unknownAllocatedEntries);
});

test('large branches stay bounded and all omitted bytes remain in a distinct aggregate', () => {
  const root = record(1, null, 0, { kind: 'directory' });
  const records = [root];
  for (let i = 2; i < 2502; i++) records.push(record(i, 1, i));
  root.allocatedKnown = sum(records.slice(1).map(node => ({ value: node.allocatedKnown })));
  const result = buildChartReport(synthetic(records), options);
  assert.equal(result.childCount, 2500);
  assert.equal(result.nodes.length, ROOT_LIMIT + 1);
  assert.equal(result.nodes.at(-1).group, 'other');
  assert.equal(result.nodes.at(-1).items, 2500 - ROOT_LIMIT);
  assert.deepEqual(result.nodes.slice(0, ROOT_LIMIT).map(node => node.entry.id), Array.from({ length: ROOT_LIMIT }, (_, i) => 2501 - i));
  assert.equal(sum(result.nodes), root.allocatedKnown);
});

test('second-level aggregation is bounded and does not inflate the parent area', () => {
  const records = [record(1, null, 0, { kind: 'directory' })];
  let id = 2;
  for (let folder = 0; folder < 30; folder++) {
    const parent = record(id++, 1, 0, { kind: 'directory' }); records.push(parent);
    for (let child = 0; child < 100; child++) {
      const leaf = record(id++, parent.entry.id, child + 1); records.push(leaf); parent.allocatedKnown += leaf.allocatedKnown;
    }
  }
  const result = buildChartReport(synthetic(records), options);
  for (const node of result.nodes.filter(node => node.entry)) {
    assert.equal(node.children.length, CHILD_LIMIT + 1);
    assert.equal(sum(node.children), node.value);
  }
  assert.equal(sum(result.nodes), 30 * 5050);
  assert(result.nodes.reduce((n, node) => n + 1 + (node.children?.length || 0), 0) <= 266);
});

test('unknown allocation retains known directory bytes and never substitutes logical bytes', () => {
  const root = record(1, null, 20, { kind: 'directory', allocatedSize: null }); root.unknownAllocated = 1;
  const directory = record(2, 1, 20, { kind: 'directory', allocatedSize: null, logicalSize: 9000 }); directory.unknownAllocated = 1;
  const known = record(3, 2, 20);
  const unknown = record(4, 2, 0, { allocatedSize: null, logicalSize: 8980 }); unknown.unknownAllocated = 1;
  const result = buildChartReport(synthetic([root, directory, known, unknown]), options);
  assert.equal(result.totalBytes, 20);
  assert.equal(result.unknownAllocatedEntries, 1);
  assert.equal(result.nodes[0].entry.allocatedSize, null);
  assert.equal(sum(result.nodes[0].children), 20);
});

test('display filters group hidden/system items exactly once without changing totals', () => {
  const records = [record(1, null, 100, { kind: 'directory' }), record(2, 1, 10),
    record(3, 1, 20, { hiddenPath: true }), record(4, 1, 30, { systemPath: true }),
    record(5, 1, 40, { hiddenPath: true, systemPath: true })];
  const result = buildChartReport(synthetic(records), { ...options, includeHidden: false, includeSystem: false });
  assert.equal(result.totalBytes, 100);
  assert.equal(sum(result.nodes), 100);
  assert.equal(result.nodes.length, 2);
  assert.deepEqual(result.nodes[1], { key: 'hidden:1', group: 'hidden', entry: null, value: 90, items: 3 });
  assert.equal(buildChartReport(synthetic(records), options).nodes.length, 4);
});

test('empty and zero-byte directories keep inspectable rows without manufacturing occupied area', () => {
  const records = [record(1, null, 0, { kind: 'directory' }), record(2, 1, 0)];
  const result = buildChartReport(synthetic(records), options);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.totalBytes, 0);
  assert.deepEqual(layout.layoutTiles(result.nodes, 900, 460), []);
  assert.equal(buildChartReport(synthetic(records), { ...options, entryId: 2 }).childCount, 1);
});

test('equal-size ordering is deterministic, and logical/allocated measures remain independent', () => {
  const records = [record(1, null, 0, { kind: 'directory' }), record(2, 1, 10, { name: 'z', logicalSize: 1000 }),
    record(3, 1, 10, { name: 'a', logicalSize: 1 })];
  assert.deepEqual(buildChartReport(synthetic(records), options).nodes.map(node => node.entry.id), [3, 2]);
  assert.deepEqual(buildChartReport(synthetic(records), { ...options, metric: 'logical' }).nodes.map(node => node.entry.id), [2, 3]);
});

test('cancelled, pending and partial reports keep their incomplete status', () => {
  const source = synthetic([record(1, null, 0, { kind: 'directory' })], 'cancelled');
  assert.equal(buildChartReport(source, options).incomplete, true);
  source.scanState = 'completed'; source.record(1).entry.state = 'partial';
  assert.equal(buildChartReport(source, options).incomplete, true);
});

test('chart lookup refuses missing indexed IDs and unsupported measures', () => {
  const source = synthetic([record(1, null, 0, { kind: 'directory' })]);
  assert.throws(() => buildChartReport(source, { ...options, entryId: 999 }), /ENTRY_UNAVAILABLE/);
  assert.throws(() => buildChartReport(source, { ...options, metric: 'free' }), /INVALID_QUERY/);
});

test('treemap areas preserve byte proportions, stay within bounds and never overlap', () => {
  const nodes = Array.from({ length: 26 }, (_, id) => ({ id, value: (id + 1) ** 2 }));
  const before = JSON.stringify(nodes);
  const tiles = layout.layoutTiles(nodes, 900, 460);
  const total = sum(nodes);
  assert.equal(tiles.length, nodes.length);
  assert.equal(JSON.stringify(nodes), before);
  for (const tile of tiles) {
    assert(tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= 900 + 1e-8 && tile.y + tile.height <= 460 + 1e-8);
    assert(Math.abs(tile.width * tile.height / (900 * 460) - tile.node.value / total) < 1e-10);
  }
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
    const a = tiles[i], b = tiles[j];
    const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    assert(overlapX <= 1e-8 || overlapY <= 1e-8);
  }
  assert.deepEqual(layout.layoutTiles([{ value: 0 }, { value: NaN }, { value: -1 }], 900, 460), []);
});

test('a single slice draws a complete circle and small slices use the small arc', () => {
  assert.equal((layout.pieSlice(0, 1).match(/ A /g) || []).length, 2);
  assert.match(layout.pieSlice(0, .1), /0 0 1/);
  assert.match(layout.pieSlice(.1, .8), /0 1 1/);
  assert(!layout.pieSlice(0, 1).includes('NaN'));
});
