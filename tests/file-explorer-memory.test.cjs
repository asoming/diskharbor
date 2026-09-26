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

test('visibility modes isolate view pages and scroll without becoming saved preferences', async () => {
  const { createExplorerMemory, defaultExplorerPreferences, explorerViewKey, rememberExplorerView } = await helpers;
  const memory = createExplorerMemory();
  const preferences = defaultExplorerPreferences();
  const all = explorerViewKey('tree', '/scan', preferences);
  const visibilityModes = [
    { includeHidden: true, includeSystem: true },
    { includeHidden: false, includeSystem: true },
    { includeHidden: true, includeSystem: false },
    { includeHidden: false, includeSystem: false },
  ];
  const keys = visibilityModes.map(visibility => explorerViewKey('tree', '/scan', preferences, undefined, visibility));
  assert.equal(keys[0], all);
  assert.equal(new Set(keys).size, 4);
  rememberExplorerView(memory, all, view('/scan', { expandedPaths: ['/scan/.hidden'], pages: [{ path: '/scan', count: 400 }], scrollTop: 2400 }));
  assert.equal(memory.views.get(keys[1]), undefined);
  rememberExplorerView(memory, keys[1], view('/scan', { scrollTop: 150 }));
  assert.equal(memory.views.get(all).scrollTop, 2400);
  assert.equal(memory.views.get(all).pages[0].count, 400);
  assert.equal(memory.views.get(keys[1]).scrollTop, 150);
  assert.deepEqual(memory.views.get(keys[1]).expandedPaths, []);
  assert.equal('includeHidden' in memory.preferences.tree, false);
});

test('replacement acceptance and remembered locations remain separate per visibility and explorer mode', async () => {
  const { createExplorerMemory, prepareExplorerRoot, explorerMemoryKey } = await helpers;
  const memory = createExplorerMemory();
  prepareExplorerRoot(memory, '/scan', 'old');
  const hiddenOff = explorerMemoryKey('tree', { includeHidden: false, includeSystem: true });
  const filesHiddenOff = explorerMemoryKey('files', { includeHidden: false, includeSystem: true });
  assert.equal(explorerMemoryKey('tree'), 'tree');
  assert.notEqual(hiddenOff, filesHiddenOff);
  memory.locations.tree = { path: '/scan/.private', ancestors: ['/scan'] };
  memory.locations[hiddenOff] = { path: '/scan/public', ancestors: ['/scan'] };
  memory.scanIds[hiddenOff] = 'replacement';
  prepareExplorerRoot(memory, '/scan', 'replacement');
  assert.equal(memory.scanIds.tree, 'old');
  assert.equal(memory.scanIds[hiddenOff], 'replacement');
  assert.equal(memory.locations.tree.path, '/scan/.private');
  assert.equal(memory.locations[hiddenOff].path, '/scan/public');
  prepareExplorerRoot(memory, '/elsewhere', 'next');
  assert.equal(memory.scanIds[hiddenOff], undefined);
  assert.equal(memory.locations[hiddenOff], undefined);
});

test('hidden scopes fall back to the nearest visible ancestor using resolved flags, not names', async () => {
  const { nearestResolvedDirectory, locationCandidates } = await helpers;
  const paths = locationCandidates({ path: '/scan/public/.hidden/child', ancestors: ['/scan', '/scan/public', '/scan/public/.hidden'] }, '/scan');
  const resolved = paths.map((path, index) => ({ ...directory(100 + index, path), hiddenPath: index < 2, systemPath: false }));
  const hiddenOff = { includeHidden: false, includeSystem: true };
  assert.equal(nearestResolvedDirectory(paths, resolved, hiddenOff, '/scan').path, '/scan/public');
  assert.equal(nearestResolvedDirectory(paths, resolved, { includeHidden: true, includeSystem: true }, '/scan').path, paths[0]);
  // A visible basename under a hidden ancestor remains hidden by its indexed flag.
  assert.equal(nearestResolvedDirectory([paths[0]], [resolved[0]], hiddenOff, '/scan'), null);
});

test('system and hidden rules combine while the selected root remains reachable', async () => {
  const { nearestResolvedDirectory, isExplorerEntryVisible } = await helpers;
  const visibility = { includeHidden: false, includeSystem: false };
  const root = { ...directory(1, '/system-root'), hiddenPath: false, systemPath: true };
  const systemChild = { ...directory(2, '/system-root/cache'), hiddenPath: false, systemPath: true };
  assert.equal(isExplorerEntryVisible(systemChild, visibility, root.path), false);
  assert.equal(nearestResolvedDirectory([systemChild.path, root.path], [systemChild, root], visibility, root.path), root);
  assert.equal(isExplorerEntryVisible({ ...systemChild, hiddenPath: true }, { includeHidden: true, includeSystem: false }, root.path), false);
  assert.equal(isExplorerEntryVisible({ ...systemChild, systemPath: false, hiddenPath: true }, { includeHidden: false, includeSystem: true }, root.path), false);
  assert.equal(isExplorerEntryVisible({ ...systemChild, hiddenPath: false, systemPath: false }, visibility, root.path), true);
  assert.equal(nearestResolvedDirectory([root.path], [{ ...root, path: '/unrelated' }], visibility, root.path), null);
});


test('virtual keyboard focus reaches either endpoint without relying on the old DOM extent', async () => {
  const { focusScrollTop } = await helpers;
  assert.equal(focusScrollTop(100, 101, 50, 200, 0), 4850);
  assert.equal(focusScrollTop(0, 101, 50, 200, 4850), 0);
  assert.equal(focusScrollTop(20, 101, 50, 200, 950), 950);
  assert.equal(focusScrollTop(3, 101, 50, 200, 950), 150);
});

test('keyboard focus geometry handles short, resized and empty views', async () => {
  const { focusScrollTop } = await helpers;
  assert.equal(focusScrollTop(2, 3, 50, 300, 5000), 0);
  assert.equal(focusScrollTop(99, 100, 50, 140, 4850), 4860);
  assert.equal(focusScrollTop(99, 100, 50, 500, 4860), 4500);
  assert.equal(focusScrollTop(1, 0, 50, 200, 0), 0);
  assert.equal(focusScrollTop(1, 100, 50, 0, 0), 0);
});
