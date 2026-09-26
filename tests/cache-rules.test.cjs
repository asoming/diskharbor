'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { getCacheRules, createCacheMatcher, MAX_CACHE_FINDINGS } = require('../electron/cache-rules.cjs');
const { ScanIndex } = require('../electron/scanner.cjs');
const { protectedPathReason } = require('../electron/cleanup.cjs');

function contextFor(platform) {
  return { platform, home: platform === 'win32' ? 'C:\\Users\\fixture' : '/fixture/home' };
}

function cachePaths(context) {
  const api = context.platform === 'win32' ? path.win32 : path.posix;
  if (context.platform === 'win32') {
    const local = context.localAppData || api.join(context.home, 'AppData', 'Local');
    return [api.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), api.join(local, 'Chromium', 'User Data', 'Profile 2', 'Cache'), api.join(local, 'Mozilla', 'Firefox', 'Profiles', 'abc.default-release', 'cache2')];
  }
  if (context.platform === 'darwin') {
    return [api.join(context.home, 'Library', 'Caches', 'Google', 'Chrome', 'Default', 'Cache'), api.join(context.home, 'Library', 'Caches', 'Chromium', 'Profile 2', 'Cache'), api.join(context.home, 'Library', 'Caches', 'Firefox', 'Profiles', 'abc.default-release', 'cache2')];
  }
  const cache = context.cacheHome || api.join(context.home, '.cache');
  return [api.join(cache, 'google-chrome', 'Default', 'Cache'), api.join(cache, 'chromium', 'Profile 2', 'Cache'), api.join(cache, 'mozilla', 'firefox', 'abc.default-release', 'cache2')];
}

// Synthetic metadata allows all platform path contracts to run on every CI host.
function metadataIndex(context, rootPath = context.home) {
  const api = context.platform === 'win32' ? path.win32 : path.posix;
  const index = new ScanIndex(process.cwd(), { scanId: `fixture-${context.platform}` });
  index.rootPath = rootPath;
  index._state = 'completed';
  const records = new Map();
  function add(filePath, kind = 'directory', properties = {}) {
    if (records.has(filePath)) return records.get(filePath);
    const parent = filePath === rootPath ? null : add(api.dirname(filePath));
    const record = index._newRecord(parent, filePath, api.basename(filePath), kind);
    record.identity = { path: filePath, kind, nlink: 1 };
    Object.assign(record.entry, { state: 'ready' }, properties);
    records.set(filePath, record);
    return record;
  }
  add(rootPath);
  function cache(filePath, properties = {}) {
    const record = add(filePath, 'directory', properties);
    if (api.basename(filePath) === 'cache2') {
      add(api.join(filePath, 'entries'));
      add(api.join(filePath, 'index'), 'file');
    } else add(api.join(filePath, 'Cache_Data'));
    return record;
  }
  return { index, add, cache, api, records };
}

async function diskFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-cache-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = { platform: process.platform, home: root };
  const cachePath = cachePaths(context)[0];
  await fs.mkdir(path.join(cachePath, 'Cache_Data'), { recursive: true });
  await fs.writeFile(path.join(cachePath, 'Cache_Data', 'data.bin'), 'metadata only');
  return { root, context, cachePath };
}

test('rule catalog is platform-specific, versioned, guide-only and independently cloned', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const rules = getCacheRules(platform);
    assert.equal(rules.length, 3);
    assert.deepEqual(rules.map(rule => rule.browserId), ['chrome', 'chromium', 'firefox']);
    for (const rule of rules) {
      assert.equal(rule.platform, platform);
      assert.equal(rule.version, 1);
      assert.equal(rule.validation, 'metadata-fixtures');
      assert.deepEqual(rule.validatedAppVersions, []);
      assert.ok(rule.sources.length >= 3);
      assert.ok(rule.sources.every(source => source.startsWith('https://')));
      assert.equal(rule.settingsAddress, rule.browserId === 'firefox' ? 'about:preferences#privacy' : 'chrome://settings/clearBrowserData');
      assert.equal('eligible' in rule, false);
    }
    rules[0].sources.push('changed');
    rules[0].validatedAppVersions.push('unverified');
    rules[0].settingsAddress = 'https://changed.invalid';
    const fresh = getCacheRules(platform)[0];
    assert.ok(!fresh.sources.includes('changed'));
    assert.deepEqual(fresh.validatedAppVersions, []);
    assert.equal(fresh.settingsAddress, 'chrome://settings/clearBrowserData');
  }
  assert.deepEqual(getCacheRules('unsupported'), []);
});

for (const platform of ['linux', 'win32', 'darwin']) {
  test(`${platform} recognizes all three exact standard layouts without filesystem access`, () => {
    const context = contextFor(platform);
    const fixture = metadataIndex(context);
    const paths = cachePaths(context);
    paths.forEach((value, offset) => fixture.cache(value, { allocatedSize: 300 - offset * 100, logicalSize: 400 + offset, fileCount: offset + 1 }));
    const report = fixture.index.cacheReport(context);
    assert.equal(report.ruleSetVersion, '2026.09.1');
    assert.equal(report.scanId, `fixture-${platform}`);
    assert.equal(report.rootPath, context.home);
    assert.equal(report.scanState, 'completed');
    assert.equal(report.truncated, false);
    assert.deepEqual(report.findings.map(finding => finding.entry.path), paths);
    assert.deepEqual(report.findings.map(finding => finding.profile), ['Default', 'Profile 2', 'abc.default-release']);
    assert.ok(report.findings.every(finding => finding.complete));
    for (const finding of report.findings) assert.deepEqual(finding.entry, fixture.index.entry(finding.entry.id));
  });
}

test('path rules reject nested, lookalike, nonstandard profile and case-guessed locations', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const context = contextFor(platform);
    const matcher = createCacheMatcher(context);
    const api = platform === 'win32' ? path.win32 : path.posix;
    const chrome = cachePaths(context)[0];
    const profile = api.dirname(chrome);
    for (const candidate of [
      chrome.replace(context.home, `${context.home}-other`),
      api.join(context.home, 'Downloads', 'Default', 'Cache'),
      api.join(profile, 'nested', 'Cache'),
      chrome.replace(`${api.sep}Default${api.sep}`, `${api.sep}System Profile${api.sep}`),
      chrome.replace(`${api.sep}Default${api.sep}`, `${api.sep}Guest Profile${api.sep}`),
      chrome.replace(`${api.sep}Default${api.sep}`, `${api.sep}custom${api.sep}`),
      chrome.replace(`${api.sep}Default${api.sep}`, `${api.sep}Profile x${api.sep}`),
      chrome.replace(`${api.sep}Cache`, `${api.sep}cache`),
      `${profile}${api.sep}..${api.sep}Default${api.sep}Cache`,
    ]) assert.equal(matcher.match(candidate), null, candidate);
    assert.equal(matcher.match(api.join(chrome, 'Cache_Data')), null);
  }
  const linux = createCacheMatcher(contextFor('linux'));
  assert.equal(linux.match('/fixture/home/snap/chromium/common/.cache/chromium/Default/Cache'), null);
  assert.equal(linux.match('/fixture/home/.var/app/org.chromium.Chromium/cache/chromium/Default/Cache'), null);
});

test('trusted XDG cache and local application data overrides use exact platform paths', () => {
  const linux = { platform: 'linux', home: '/users/person', cacheHome: '/cache-volume/person' };
  const windows = { platform: 'win32', home: 'C:\\Users\\person', localAppData: 'D:\\UserData\\person' };
  assert.equal(createCacheMatcher(linux).match('/cache-volume/person/google-chrome/Default/Cache').profile, 'Default');
  assert.equal(createCacheMatcher(linux).match('/users/person/.cache/google-chrome/Default/Cache'), null);
  assert.equal(createCacheMatcher(windows).match('D:\\UserData\\person\\Chromium\\User Data\\Profile 4\\Cache').profile, 'Profile 4');
  assert.equal(createCacheMatcher(windows).match('d:\\UserData\\person\\Chromium\\User Data\\Profile 4\\Cache'), null);
});

test('invalid contexts are refused instead of guessing home or interpreting relative paths', () => {
  for (const context of [null, {}, { platform: 'unknown', home: '/home/a' }, { platform: 'linux', home: 'relative' }, { platform: 'linux', home: '/home/a/../b' }, { platform: 'linux', home: '/home/\0bad' }, { platform: 'linux', home: '/home/a', cacheHome: 'relative' }, { platform: 'win32', home: 'C:relative' }]) {
    assert.throws(() => createCacheMatcher(context), { code: 'INVALID_CACHE_CONTEXT' });
  }
});

test('Chrome requires a direct Cache_Data directory and Firefox requires entries plus a regular index file', () => {
  const context = contextFor('linux');
  const fixture = metadataIndex(context);
  const [chrome, chromium, firefox] = cachePaths(context);
  fixture.add(chrome);
  fixture.add(`${chrome}/nested/Cache_Data`);
  fixture.add(chromium);
  fixture.add(`${chromium}/Cache_Data`, 'file');
  fixture.add(firefox);
  fixture.add(`${firefox}/entries`);
  assert.deepEqual(fixture.index.cacheReport(context).findings, []);
  const indexFile = fixture.add(`${firefox}/index`, 'symlink');
  assert.deepEqual(fixture.index.cacheReport(context).findings, []);
  indexFile.entry.kind = indexFile.identity.kind = 'file';
  assert.equal(fixture.index.cacheReport(context).findings.length, 1);
  fixture.add(`${chrome}/Cache_Data`);
  assert.equal(fixture.index.cacheReport(context).findings.length, 2);
});

test('only indexed cache scopes are reported; an indexed file or cache data subfolder is insufficient', () => {
  const context = contextFor('linux');
  const chrome = cachePaths(context)[0];
  const exact = metadataIndex(context, chrome);
  exact.cache(chrome);
  assert.equal(exact.index.cacheReport(context).findings.length, 1);
  const inside = metadataIndex(context, `${chrome}/Cache_Data`);
  inside.add(`${chrome}/Cache_Data/data.bin`, 'file');
  assert.deepEqual(inside.index.cacheReport(context).findings, []);
  const file = metadataIndex(context, chrome);
  file.records.get(chrome).entry.kind = file.records.get(chrome).identity.kind = 'file';
  assert.deepEqual(file.index.cacheReport(context).findings, []);
});

test('incomplete scans and incomplete cache directories retain matched subtotals with complete=false', () => {
  const context = contextFor('linux');
  const fixture = metadataIndex(context);
  const cache = fixture.cache(cachePaths(context)[0], { allocatedSize: 4096, logicalSize: 2048 });
  for (const state of ['idle', 'scanning', 'cancelled', 'error']) {
    fixture.index._state = state;
    const report = fixture.index.cacheReport(context);
    assert.equal(report.scanState, state);
    assert.equal(report.findings[0].complete, false);
    assert.equal(report.findings[0].entry.allocatedSize, 4096);
  }
  fixture.index._state = 'completed';
  for (const state of ['pending', 'partial', 'error', 'skipped']) {
    cache.entry.state = state;
    assert.equal(fixture.index.cacheReport(context).findings[0].complete, false);
  }
});

test('symlink, unsupported and ambiguous cache/structural/ancestor paths are not matched', () => {
  const context = contextFor('linux');
  for (const target of ['candidate', 'structure', 'ancestor']) {
    for (const unsafe of ['symlink', 'unsupported', 'ambiguous']) {
      const fixture = metadataIndex(context);
      const chrome = cachePaths(context)[0];
      const cache = fixture.cache(chrome);
      const record = target === 'candidate' ? cache : target === 'structure' ? fixture.records.get(`${chrome}/Cache_Data`) : fixture.records.get(path.posix.dirname(chrome));
      if (unsafe === 'symlink') record.entry.kind = record.identity.kind = 'symlink';
      if (unsafe === 'unsupported') record.unsupportedPath = true;
      if (unsafe === 'ambiguous') fixture.index._pathIds.set(record.entry.path, 0);
      assert.deepEqual(fixture.index.cacheReport(context).findings, [], `${target}:${unsafe}`);
    }
  }
});

test('unsafe descendants qualify completeness without changing normal entries or cleanup manifests', () => {
  const context = contextFor('linux');
  const fixture = metadataIndex(context);
  const chrome = cachePaths(context)[0];
  const cache = fixture.cache(chrome);
  const link = fixture.add(`${chrome}/Cache_Data/link`, 'symlink');
  link.entry.state = 'skipped';
  fixture.index._markCacheUnsafe(link);
  assert.equal(cache.entry.state, 'ready');
  assert.equal(fixture.index.cacheReport(context).findings[0].complete, false);
  assert.ok(fixture.index.cleanupManifest(cache.entry.id).entries.some(node => node.entry.kind === 'symlink'));
});

test('reported allocation preserves unknown and shared accounting, stable ordering and the 50-result limit', () => {
  const context = contextFor('linux');
  const fixture = metadataIndex(context);
  const base = '/fixture/home/.cache/google-chrome';
  for (let profile = 0; profile < 53; profile++) fixture.cache(`${base}/Profile ${profile}/Cache`, { allocatedSize: profile === 52 ? null : profile * 4096, logicalSize: 1000000, shared: profile === 0, sharedWith: profile === 0 ? 99 : undefined });
  const report = fixture.index.cacheReport(context);
  assert.equal(report.findings.length, MAX_CACHE_FINDINGS);
  assert.equal(report.truncated, true);
  assert.equal(report.findings[0].profile, 'Profile 51');
  assert.equal(report.findings.at(-1).profile, 'Profile 2');
  const small = metadataIndex(context);
  const [a, b, c] = cachePaths(context);
  small.cache(a, { allocatedSize: null, logicalSize: 999999 });
  small.cache(b, { allocatedSize: 0, logicalSize: 999999, shared: true, sharedWith: 30 });
  small.cache(c, { allocatedSize: 4096, logicalSize: 20 });
  const findings = small.index.cacheReport(context).findings;
  assert.deepEqual(findings.map(finding => finding.entry.allocatedSize), [4096, 0, null]);
  assert.equal(findings[1].entry.shared, true);
  assert.equal(findings[1].entry.sharedWith, 30);
});

test('cache findings do not relax standard cleanup protections on any platform', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const context = contextFor(platform);
    const fixture = metadataIndex(context);
    cachePaths(context).forEach(value => fixture.cache(value));
    for (const finding of fixture.index.cacheReport(context).findings) {
      assert.equal(protectedPathReason(finding.entry.path, context), platform === 'linux' ? 'HIDDEN_PATH' : 'APPLICATION_DATA');
      assert.deepEqual(Object.keys(finding).sort(), ['complete', 'entry', 'profile', 'ruleId']);
    }
  }
});

test('actual scan reports cloned metadata without additional filesystem calls or content reads', async t => {
  const fixture = await diskFixture(t);
  const scanner = new ScanIndex(fixture.root);
  await scanner.scan();
  for (const method of ['readFile', 'open', 'opendir', 'lstat', 'realpath', 'statfs']) t.mock.method(fs, method, () => { throw new Error(`Unexpected ${method}`); });
  const report = scanner.cacheReport(fixture.context);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].complete, true);
  assert.equal(report.findings[0].entry.logicalSize, Buffer.byteLength('metadata only'));
  report.findings[0].entry.path = '/changed';
  report.rules[0].sources.length = 0;
  assert.equal(scanner.cacheReport(fixture.context).findings[0].entry.path, fixture.cachePath);
  assert.ok(scanner.cacheReport(fixture.context).rules[0].sources.length > 0);
  t.mock.restoreAll();
});

test('actual symbolic-link descendants mark only the matched cache incomplete', async t => {
  if (process.platform === 'win32') return t.skip('Symlink creation requires platform-dependent privileges.');
  const fixture = await diskFixture(t);
  const otherCache = cachePaths(fixture.context)[1];
  await fs.mkdir(path.join(otherCache, 'Cache_Data'), { recursive: true });
  await fs.symlink('missing', path.join(fixture.cachePath, 'Cache_Data', 'link'));
  const scanner = new ScanIndex(fixture.root);
  await scanner.scan();
  const findings = scanner.cacheReport(fixture.context).findings;
  const finding = findings.find(item => item.entry.path === fixture.cachePath);
  assert.equal(finding.complete, false);
  assert.equal(finding.entry.state, 'ready');
  assert.equal(findings.find(item => item.entry.path === otherCache).complete, true);
  assert.equal(scanner.summary().skipped, 1);
});

test('actual shared cache files retain scan-wide allocation deduplication rather than a release estimate', async t => {
  const fixture = await diskFixture(t);
  const otherCache = cachePaths(fixture.context)[1];
  await fs.mkdir(path.join(otherCache, 'Cache_Data'), { recursive: true });
  const original = path.join(fixture.cachePath, 'Cache_Data', 'data.bin');
  await fs.link(original, path.join(otherCache, 'Cache_Data', 'linked.bin'));
  const stat = await fs.lstat(original);
  const scanner = new ScanIndex(fixture.root);
  await scanner.scan();
  const findings = scanner.cacheReport(fixture.context).findings;
  assert.equal(findings.length, 2);
  assert.equal(findings.reduce((sum, finding) => sum + finding.entry.logicalSize, 0), stat.size * 2);
  const allocation = process.platform === 'win32' ? require('../electron/native-metadata.cjs').getNativePathFlags(original).allocatedSize : stat.blocks == null ? null : stat.blocks * 512;
  assert.equal(findings.reduce((sum, finding) => sum + (finding.entry.allocatedSize ?? 0), 0), allocation ?? 0);
  assert.ok(findings.some(finding => finding.entry.allocatedSize === 0));
  if (allocation == null) assert.ok(findings.some(finding => finding.entry.allocatedSize === null));
  assert.ok(scanner.query({ kind: 'file' }).entries.every(entry => entry.shared));
  assert.ok(findings.every(finding => finding.complete));
});

test('actual non-UTF8 descendants and escaped-name collisions cannot produce a complete cache', async t => {
  if (process.platform !== 'linux') return t.skip('Raw-byte filename fixture is Linux-specific.');
  const fixture = await diskFixture(t);
  const directory = path.join(fixture.cachePath, 'Cache_Data');
  await fs.writeFile(Buffer.concat([Buffer.from(`${directory}/`), Buffer.from([0xff])]), 'raw');
  await fs.writeFile(path.join(directory, '\\xff'), 'literal');
  const scanner = new ScanIndex(fixture.root);
  await scanner.scan();
  assert.equal(scanner.cacheReport(fixture.context).findings[0].complete, false);
  assert.equal(scanner.resolvePaths([path.join(directory, '\\xff')])[0], null);
});

test('worker cacheReport uses only its main-process context and ignores caller overrides', async t => {
  const fixture = await diskFixture(t);
  const worker = new Worker(path.join(__dirname, '..', 'electron', 'scan-worker.cjs'), { workerData: {
    rootPath: fixture.root, scanId: 'cache-worker', cancelBuffer: new SharedArrayBuffer(4), cacheContext: fixture.context,
  } });
  t.after(() => worker.terminate());
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker cache report timed out.')), 15000);
    let requested = false;
    worker.on('error', reject);
    worker.on('message', message => {
      if (!requested && message.type === 'progress' && message.summary.state === 'completed') {
        requested = true;
        worker.postMessage({ type: 'request', id: 'cache-report', method: 'cacheReport', argument: { platform: 'invalid', home: '/override' } });
      }
      if (message.type === 'response' && message.id === 'cache-report') { clearTimeout(timer); resolve(message); }
    });
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.scanId, 'cache-worker');
  assert.equal(response.result.findings.length, 1);
  assert.equal(response.result.findings[0].entry.path, fixture.cachePath);
});
