'use strict';

const path = require('node:path');

// Display heuristics only. These are neither native hidden/system attributes
// nor a cleanup policy; scanning and safety checks must retain every entry.
const LINUX_ROOTS = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64',
  '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var'];
const MAC_ROOTS = ['/System', '/Library', '/Applications', '/private', '/bin',
  '/sbin', '/usr', '/dev', '/etc', '/var'];
const WINDOWS_ROOT_NAMES = new Set(['windows', 'program files', 'program files (x86)',
  'programdata', 'system volume information', '$recycle.bin', '$windows.~bt',
  '$windows.~ws', 'recovery']);

function normalize(value, platform) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  if (platform === 'win32') {
    // A UNC share has no known local drive layout. Do not guess that its
    // similarly named directories are Windows or application data folders.
    if (!/^[a-z]:[\\/]/i.test(value)) return null;
    return path.win32.normalize(value).toLowerCase();
  }
  if (!value.startsWith('/')) return null;
  return path.posix.normalize(value);
}

function within(candidate, root, separator) {
  return candidate === root || candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
}

function isKnownSystemPath(candidate, { platform, home } = {}) {
  const normalized = normalize(candidate, platform);
  if (!normalized) return false;
  const userHome = normalize(home, platform);
  if (platform === 'win32') {
    const parts = normalized.slice(3).split('\\');
    return WINDOWS_ROOT_NAMES.has(parts[0])
      || (parts[0] === 'users' && Boolean(parts[1]) && parts[2] === 'appdata')
      || Boolean(userHome && within(normalized, path.win32.join(userHome, 'AppData').toLowerCase(), '\\'));
  }
  if (platform === 'darwin') {
    return MAC_ROOTS.some(root => within(normalized, root, '/'))
      || /^\/Users\/[^/]+\/Library(?:\/|$)/.test(normalized)
      || Boolean(userHome && within(normalized, path.posix.join(userHome, 'Library'), '/'));
  }
  if (platform === 'linux') {
    // Removable media under this known mount location is not system data.
    if (within(normalized, '/run/media', '/')) return false;
    return LINUX_ROOTS.some(root => within(normalized, root, '/'))
      || Boolean(userHome && ['.cache', '.config', '.local/share', '.local/state']
        .some(relative => within(normalized, path.posix.join(userHome, relative), '/')));
  }
  return false;
}

function createPathVisibility(scanRoot, context) {
  const rules = { platform: context?.platform, home: context?.home };
  const rootIsSystem = isKnownSystemPath(scanRoot, rules);
  return {
    rootIsSystem,
    classify(candidate, name, parentEntry) {
      // The explicitly selected root and all ancestors outside it contribute
      // no hidden flag. Only a new dot-prefixed child begins hidden inheritance.
      const hiddenPath = Boolean(parentEntry && (parentEntry.hiddenPath || name.startsWith('.')));
      // Re-evaluate the full anchored path: inheriting /run's flag would hide
      // its explicitly exempt /run/media descendants.
      const systemPath = !rootIsSystem && Boolean(parentEntry && isKnownSystemPath(candidate, rules));
      return { hiddenPath, systemPath };
    },
  };
}

module.exports = { isKnownSystemPath, createPathVisibility };
