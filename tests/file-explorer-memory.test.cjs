'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// Exercise the real source without depending on Node's newer TS type stripping.
// The declared Node 22.12 minimum supports this ordinary JavaScript data module.
const source = fs.readFileSync(path.join(__dirname, '../src/file-explorer-memory.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const helpers = import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const directory = (id, path) => ({ id, path, kind: 'directory' });
const view = (path, extra = {}) => ({ path, ancestors: ['/scan', path], expandedPaths: [], pages: [{ path, count: 100 }], scrollTop: 0, scrollLeft: 0, ...extra });

test('same root replacement retains paths and preferences until the new scan can resolve them', async () => {
  const { createExplorerMemory, prepareExplorerRoot, rememberExplorerView } = await helpers;
  const memory = createExplorerMemory();
  prepareExplorerRoot(memory, '/scan', 'old');
  memory.locations.tree = { path: '/scan/work', ancestors: ['/scan', '/scan/work'] };
  memory.preferences.tree.search = 'report';
  rememberExplorerView(memory, 'work', view('/scan/work'));
  prepareExplorerRoot(memory, '/scan', 'replacement');
  assert.equal(memory.scanIds.tree, 'old');
  assert.equal(memory.locations.tree.path, '/scan/work');
  assert.equal(memory.preferences.tree.search, 'report');
  assert.equal(memory.views.size, 1);
});

test('a different root clears prior browsing state even if entry IDs would be reused', async () => {
  const { createExplorerMemory, prepareExplorerRoot, rememberExplorerView } = await helpers;
  const memory = createExplorerMemory();
  prepareExplorerRoot(memory, '/first', 'one');
  memory.locations.tree = { path: '/first/child', ancestors: ['/first'] };
  memory.preferences.tree.search = 'private';
  rememberExplorerView(memory, 'child', view('/first/child'));
  prepareExplorerRoot(memory, '/second', 'two');
  assert.equal(memory.rootPath, '/second');
  assert.deepEqual(memory.scanIds, { tree: 'two', files: 'two' });
  assert.deepEqual(memory.locations, {});
  assert.equal(memory.views.size, 0);
  assert.equal(memory.preferences.tree.search, '');
});

test('path resolution chooses current IDs and the closest surviving directory', async () => {
  const { locationCandidates, nearestResolvedDirectory } = await helpers;
  const paths = locationCandidates({ path: '/scan/a/missing', ancestors: ['/scan', '/scan/a', '/scan/a/missing'] }, '/scan');
  assert.deepEqual(paths, ['/scan/a/missing', '/scan/a', '/scan']);
  assert.equal(nearestResolvedDirectory(paths, [null, directory(76, '/scan/a'), directory(1, '/scan')]).id, 76);
  assert.equal(nearestResolvedDirectory(paths, [directory(991, '/scan/a/missing'), directory(76, '/scan/a'), directory(1, '/scan')]).id, 991);
});

test('resolution ignores files and mismatched paths rather than trusting a reused ID', async () => {
  const { nearestResolvedDirectory } = await helpers;
  assert.equal(nearestResolvedDirectory(['/scan/a', '/scan'], [{ id: 2, path: '/scan/a', kind: 'file' }, directory(1, '/scan')]).path, '/scan');
  assert.equal(nearestResolvedDirectory(['/scan/a'], [directory(2, '/different/a')]), null);
});

test('ancestor candidate list is bounded and retains both nearest parents and root', async () => {
  const { locationCandidates } = await helpers;
  const ancestors = ['/scan', ...Array.from({ length: 200 }, (_, index) => `/scan/level-${index}`)];
  const paths = locationCandidates({ path: '/scan/target', ancestors }, '/scan');
  assert.ok(paths.length <= 65);
  assert.equal(paths[0], '/scan/target');
  assert.equal(paths[1], '/scan/level-199');
  assert.equal(paths.at(-1), '/scan');
});

test('automatic restoration has both per-directory and aggregate page budgets', async () => {
  const { restorePageBudget, MAX_RESTORE_ROWS, MAX_ROWS_PER_GROUP, MAX_EXPANDED_PATHS } = await helpers;
  const expanded = Array.from({ length: 100 }, (_, index) => `/scan/d${index}`);
  const pages = restorePageBudget('/scan', expanded, ['/scan', ...expanded].map(path => ({ path, count: 100000 })));
  assert.equal(pages.length, MAX_EXPANDED_PATHS + 1);
  assert.ok(pages.every(page => page.count >= 100 && page.count <= MAX_ROWS_PER_GROUP && page.count % 100 === 0));
  assert.equal(pages.reduce((sum, page) => sum + page.count, 0), MAX_RESTORE_ROWS);
  assert.equal(restorePageBudget('/scan', [], [{ path: '/scan', count: 131 }])[0].count, 200);
});

test('saved state is detached, path-only, and announces truncated restoration', async () => {
  const { createExplorerMemory, rememberExplorerView, MAX_EXPANDED_PATHS } = await helpers;
  const memory = createExplorerMemory();
  const source = view('/scan', {
    expandedPaths: Array.from({ length: 40 }, (_, index) => `/scan/d${index}`),
    pages: [{ path: '/scan', count: 50000 }], scrollTop: 1000000,
    anchorPath: '/scan/report.txt', anchorOffset: 70,
  });
  rememberExplorerView(memory, 'tree', source);
  const saved = memory.views.get('tree');
  source.ancestors.push('/changed');
  source.expandedPaths.length = 0;
  source.pages[0].count = 1;
  assert.equal(saved.expandedPaths.length, MAX_EXPANDED_PATHS);
  assert.equal(saved.limited, true);
  assert.equal(saved.scrollTop, 100000);
  assert.equal(saved.anchorOffset, 49);
  assert.equal(saved.ancestors.includes('/changed'), false);
  assert.ok(saved.pages[0].count >= 100);
  assert.equal('id' in saved, false);
  assert.equal('selectedIds' in saved, false);
});

test('view memory uses bounded LRU eviction and refreshes a revisited location', async () => {
  const { createExplorerMemory, rememberExplorerView, MAX_MEMORY_VIEWS } = await helpers;
  const memory = createExplorerMemory();
  for (let index = 0; index < MAX_MEMORY_VIEWS; index++) rememberExplorerView(memory, `v${index}`, view(`/scan/${index}`));
  rememberExplorerView(memory, 'v0', view('/scan/0', { scrollTop: 650 }));
  rememberExplorerView(memory, 'new', view('/scan/new'));
  assert.equal(memory.views.size, MAX_MEMORY_VIEWS);
  assert.equal(memory.views.has('v1'), false);
  assert.equal(memory.views.get('v0').scrollTop, 650);
});

test('view keys distinguish filters and sort while column changes keep the same location', async () => {
  const { defaultExplorerPreferences, explorerViewKey } = await helpers;
  const preferences = defaultExplorerPreferences();
  const key = explorerViewKey('tree', '/scan', preferences);
  assert.notEqual(key, explorerViewKey('files', '/scan', preferences));
  assert.notEqual(key, explorerViewKey('tree', '/scan', { ...preferences, search: 'report' }));
  assert.notEqual(key, explorerViewKey('tree', '/scan', preferences, 'images'));
  assert.notEqual(key, explorerViewKey('tree', '/scan', { ...preferences, sort: { key: 'name', direction: 'asc' } }));
  assert.equal(key, explorerViewKey('tree', '/scan', { ...preferences, columns: { logical: true, modified: true, state: true } }));
});

test('active row restores by exact path without selecting a deleted row with a reused ID', async () => {
  const { restoredActiveId, rememberExplorerView, createExplorerMemory } = await helpers;
  const memory = createExplorerMemory();
  rememberExplorerView(memory, 'tree', view('/scan', { activePath: '/scan/old.txt' }));
  const activePath = memory.views.get('tree').activePath;
  assert.equal(restoredActiveId(activePath, [{ id: 42, path: '/scan/new.txt' }]), undefined);
  assert.equal(restoredActiveId(activePath, [{ id: 42, path: '/scan/new.txt' }, { id: 913, path: '/scan/old.txt' }]), 913);
  assert.equal(restoredActiveId(undefined, [{ id: 42, path: '/scan/old.txt' }]), undefined);
});

test('accepting a replacement scan in files leaves tree restoration pending independently', async () => {
  const { createExplorerMemory, prepareExplorerRoot } = await helpers;
  const memory = createExplorerMemory();
  prepareExplorerRoot(memory, '/scan', 'old');
  memory.locations.tree = { path: '/scan/pending-child', ancestors: ['/scan'] };
  memory.scanIds.files = 'replacement';
  assert.equal(memory.scanIds.tree, 'old');
  assert.equal(memory.locations.tree.path, '/scan/pending-child');
  assert.equal(memory.scanIds.files, 'replacement');
});
