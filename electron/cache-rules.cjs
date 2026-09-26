'use strict';

const path = require('node:path');

const RULE_SET_VERSION = '2026.09.1';
const MAX_CACHE_FINDINGS = 50;
const PLATFORMS = new Set(['linux', 'win32', 'darwin']);
const CHROMIUM_SOURCES = [
  'https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md',
  'https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/common/chrome_constants.h',
  'https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/net/profile_network_context_service.cc',
  'https://chromium.googlesource.com/chromium/src/+/402a9900e908141c002ac4fb1272a184b7c48978/content/browser/network_service_instance_impl.cc',
];
const FIREFOX_SOURCES = [
  'https://searchfox.org/firefox-main/source/toolkit/xre/nsXREDirProvider.cpp',
  'https://raw.githubusercontent.com/mozilla-firefox/firefox/main/toolkit/profile/nsToolkitProfileService.cpp',
  'https://raw.githubusercontent.com/mozilla-firefox/firefox/main/netwerk/cache2/CacheFileIOManager.cpp',
  'https://raw.githubusercontent.com/mozilla-firefox/firefox/main/netwerk/cache2/CacheIndex.cpp',
];

function getCacheRules(platform) {
  if (!PLATFORMS.has(platform)) return [];
  return ['chrome', 'chromium', 'firefox'].map(browserId => ({
    id: `${browserId}-${browserId === 'firefox' ? 'disk' : 'http'}-cache-${platform}`,
    version: 1,
    platform,
    browserId,
    browserName: { chrome: 'Google Chrome', chromium: 'Chromium', firefox: 'Mozilla Firefox' }[browserId],
    settingsAddress: browserId === 'firefox' ? 'about:preferences#privacy' : 'chrome://settings/clearBrowserData',
    sources: [...(browserId === 'firefox' ? FIREFOX_SOURCES : CHROMIUM_SOURCES)],
    // A directory layout never establishes an installed browser or its version.
    validatedAppVersions: [],
    validation: 'metadata-fixtures',
  }));
}

function isCanonicalPath(value, api) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 &&
    !value.includes('\0') && value.isWellFormed() && api.isAbsolute(value) && api.normalize(value) === value;
}

function createCacheMatcher(context) {
  if (!context || !PLATFORMS.has(context.platform)) throw Object.assign(new Error('INVALID_CACHE_CONTEXT'), { code: 'INVALID_CACHE_CONTEXT' });
  const api = context.platform === 'win32' ? path.win32 : path.posix;
  for (const key of ['home', 'cacheHome', 'localAppData']) {
    if ((key === 'home' || context[key] !== undefined) && !isCanonicalPath(context[key], api)) {
      throw Object.assign(new Error('INVALID_CACHE_CONTEXT'), { code: 'INVALID_CACHE_CONTEXT' });
    }
  }
  const rules = getCacheRules(context.platform);
  let bases;
  if (context.platform === 'win32') {
    const local = context.localAppData ?? api.join(context.home, 'AppData', 'Local');
    bases = [api.join(local, 'Google', 'Chrome', 'User Data'), api.join(local, 'Chromium', 'User Data'), api.join(local, 'Mozilla', 'Firefox', 'Profiles')];
  } else if (context.platform === 'darwin') {
    const cache = api.join(context.home, 'Library', 'Caches');
    bases = [api.join(cache, 'Google', 'Chrome'), api.join(cache, 'Chromium'), api.join(cache, 'Firefox', 'Profiles')];
  } else {
    const cache = context.cacheHome ?? api.join(context.home, '.cache');
    bases = [api.join(cache, 'google-chrome'), api.join(cache, 'chromium'), api.join(cache, 'mozilla', 'firefox')];
  }
  return {
    rules,
    match(candidatePath) {
      if (!isCanonicalPath(candidatePath, api)) return null;
      for (let index = 0; index < rules.length; index++) {
        const prefix = `${bases[index]}${api.sep}`;
        // Exact components: no case folding, guessed roots, or substring matches.
        if (!candidatePath.startsWith(prefix)) continue;
        const components = candidatePath.slice(prefix.length).split(api.sep);
        if (components.length !== 2) continue;
        const [profile, leaf] = components;
        if (!profile || profile.startsWith('.') || (context.platform === 'win32' && /[:<>"|?*]/.test(profile))) continue;
        const firefox = rules[index].browserId === 'firefox';
        if (leaf !== (firefox ? 'cache2' : 'Cache')) continue;
        // Restrict Chromium profiles conservatively; these names are not an exhaustive browser specification.
        if (!firefox && profile !== 'Default' && !/^Profile [0-9]+$/.test(profile)) continue;
        return { rule: rules[index], profile };
      }
      return null;
    },
  };
}

function compareFindings(a, b) {
  const left = a.entry.allocatedSize;
  const right = b.entry.allocatedSize;
  if (left == null || right == null) {
    if (left == null && right != null) return 1;
    if (right == null && left != null) return -1;
  } else if (left !== right) return right - left;
  return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : a.entry.id - b.entry.id;
}

function buildCacheReport(index, context) {
  const matcher = createCacheMatcher(context);
  const findings = [];
  let matched = 0;
  const safeRecord = (record, kind) => Boolean(record && record.entry.kind === kind && record.identity?.kind === kind &&
    !record.unsupportedPath && !record.identity.unsupportedPath && index._pathIds.get(record.entry.path) === record.entry.id);
  const safeAncestors = (record) => {
    for (let parent = index._records[record.entry.parentId]; parent; parent = index._records[parent.entry.parentId]) {
      if (!safeRecord(parent, 'directory')) return false;
    }
    return true;
  };
  const hasChild = (record, name, kind) => (index._children.get(record.entry.id) || []).some(id => {
    const child = index._records[id];
    return child.entry.name === name && safeRecord(child, kind);
  });

  // One metadata pass, bounded output. No per-finding subtree traversal or filesystem access.
  for (let id = 1; id < index._records.length; id++) {
    const record = index._records[id];
    if (record.entry.name !== 'Cache' && record.entry.name !== 'cache2') continue;
    if (!safeRecord(record, 'directory') || !safeAncestors(record)) continue;
    const match = matcher.match(record.entry.path);
    if (!match) continue;
    const structured = match.rule.browserId === 'firefox'
      ? hasChild(record, 'entries', 'directory') && hasChild(record, 'index', 'file')
      : hasChild(record, 'Cache_Data', 'directory');
    if (!structured) continue;
    matched++;
    const finding = {
      entry: { ...record.entry }, ruleId: match.rule.id, profile: match.profile,
      complete: index._state === 'completed' && record.entry.state === 'ready' && !record.cacheUnsafe,
    };
    // Keep only the top 50 even if a scan contains a large number of browser profiles.
    let low = 0;
    let high = findings.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareFindings(finding, findings[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    findings.splice(low, 0, finding);
    if (findings.length > MAX_CACHE_FINDINGS) findings.pop();
  }
  return {
    scanId: index.scanId, rootPath: index.rootPath, scanState: index._state,
    ruleSetVersion: RULE_SET_VERSION, findings, truncated: matched > MAX_CACHE_FINDINGS, rules: matcher.rules,
  };
}

module.exports = { getCacheRules, createCacheMatcher, buildCacheReport, RULE_SET_VERSION, MAX_CACHE_FINDINGS };
