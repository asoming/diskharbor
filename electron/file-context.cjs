'use strict';

const path = require('node:path');
const os = require('node:os');

const CHROMIUM_SOURCE = 'https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md';
const FIREFOX_SOURCE = 'https://support.mozilla.org/en-US/kb/profiles-where-firefox-stores-user-data';

function contextFromEnvironment({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const setting = (value, fallback) => typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && api.isAbsolute(value)
    ? api.normalize(value) : fallback;
  return {
    platform, home: setting(home, ''),
    configHome: setting(env.XDG_CONFIG_HOME, api.join(home, '.config')),
    chromeConfigHome: setting(env.CHROME_CONFIG_HOME, setting(env.XDG_CONFIG_HOME, api.join(home, '.config'))),
    cacheHome: setting(env.XDG_CACHE_HOME, api.join(home, '.cache')),
    localAppData: setting(env.LOCALAPPDATA, api.join(home, 'AppData', 'Local')),
    roamingAppData: setting(env.APPDATA, api.join(home, 'AppData', 'Roaming')),
    // These values are read from the app's environment, never from renderer requests.
    syncRoots: [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].map(value => setting(value, null)).filter(Boolean),
  };
}

function within(candidate, root, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (typeof candidate !== 'string' || typeof root !== 'string' || !candidate.isWellFormed() || !root.isWellFormed()
    || candidate.includes('\0') || !api.isAbsolute(candidate) || !api.isAbsolute(root)) return false;
  const key = value => platform === 'win32' ? api.normalize(value).toLowerCase() : api.normalize(value);
  const value = key(candidate); const base = key(root);
  return value === base || value.startsWith(base.endsWith(api.sep) ? base : base + api.sep);
}

function applicationLocations(context) {
  const { platform, home } = context;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const locations = [];
  const add = (id, name, role, root) => locations.push({ id, name, role, matchedRoot: root,
    source: id === 'firefox' ? FIREFOX_SOURCE : CHROMIUM_SOURCE, basis: 'known-location' });
  for (const [id, name] of [['chrome', 'Google Chrome'], ['chromium', 'Chromium']]) {
    if (platform === 'win32') add(id, name, 'profile', api.join(context.localAppData, ...(id === 'chrome' ? ['Google', 'Chrome', 'User Data'] : ['Chromium', 'User Data'])));
    if (platform === 'darwin') {
      const parts = id === 'chrome' ? ['Google', 'Chrome'] : ['Chromium'];
      add(id, name, 'profile', api.join(home, 'Library', 'Application Support', ...parts));
      add(id, name, 'cache', api.join(home, 'Library', 'Caches', ...parts));
    }
    if (platform === 'linux') {
      const directory = id === 'chrome' ? 'google-chrome' : 'chromium';
      add(id, name, 'profile', api.join(context.chromeConfigHome, directory));
      add(id, name, 'cache', api.join(context.cacheHome, directory));
    }
  }
  if (platform === 'win32') {
    add('firefox', 'Mozilla Firefox', 'profile', api.join(context.roamingAppData, 'Mozilla', 'Firefox', 'Profiles'));
    add('firefox', 'Mozilla Firefox', 'cache', api.join(context.localAppData, 'Mozilla', 'Firefox', 'Profiles'));
  } else if (platform === 'darwin') {
    add('firefox', 'Mozilla Firefox', 'profile', api.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles'));
    add('firefox', 'Mozilla Firefox', 'cache', api.join(home, 'Library', 'Caches', 'Firefox', 'Profiles'));
  } else if (platform === 'linux') {
    add('firefox', 'Mozilla Firefox', 'profile', api.join(home, '.mozilla', 'firefox'));
    add('firefox', 'Mozilla Firefox', 'cache', api.join(context.cacheHome, 'mozilla', 'firefox'));
  }
  return locations;
}

function syncLocation(filePath, context) {
  const { platform, home } = context;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const roots = [
    ...(context.syncRoots || []).map(root => ({ root, provider: 'OneDrive', basis: 'environment-root' })),
    ...['Dropbox', 'OneDrive'].map(provider => ({ root: api.join(home, provider), provider, basis: 'possible-location' })),
    ...(platform === 'darwin' ? [
      { root: api.join(home, 'Library', 'CloudStorage'), provider: null, basis: 'possible-location' },
      { root: api.join(home, 'Library', 'Mobile Documents'), provider: 'iCloud Drive', basis: 'possible-location' },
    ] : []),
  ];
  return roots.find(item => within(filePath, item.root, platform)) || null;
}

function describeFileContext(entry, context = contextFromEnvironment(), native = null) {
  const association = applicationLocations(context).find(item => within(entry.path, item.matchedRoot, context.platform)) || null;
  const sync = syncLocation(entry.path, context);
  const nativeCloud = native?.source === 'native' && ['resident', 'placeholder'].includes(native.cloudState) ? (native.cloudState === 'resident' ? 'local' : 'placeholder') : null;
  return {
    association,
    cloud: {
      status: nativeCloud || (sync ? 'suspected' : 'unknown'),
      basis: nativeCloud ? 'native-metadata' : sync?.basis || 'unverified',
      provider: sync?.provider || null, matchedRoot: sync?.root || null,
    },
    native: native?.source === 'native' ? {
      source: `${native.platform}-native`,
      hidden: typeof native.hidden === 'boolean' ? native.hidden : null,
      system: typeof native.system === 'boolean' ? native.system : null,
      isLink: native.kind === 'symlink' || native.reparsePoint === true,
      volume: native.volume ? { mountPath: native.volume.mountPath || null, filesystem: native.volume.filesystem || null, local: native.volume.local === true } : null,
    } : null,
  };
}

function cloudPathReason(filePath, context = contextFromEnvironment()) {
  return syncLocation(filePath, context) ? 'CLOUD_LOCATION_PROTECTED' : null;
}

module.exports = { contextFromEnvironment, applicationLocations, syncLocation, describeFileContext, cloudPathReason };
