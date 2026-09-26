'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const PLAN_TTL_MS = 2 * 60 * 1000;
const MAX_PLAN_ITEMS = 500;

function snapshot(stat, filePath, parentRealPath, parentStat) {
  return {
    path: filePath,
    parentRealPath,
    ...(parentStat ? { parentDev: String(parentStat.dev), parentIno: String(parentStat.ino) } : {}),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode),
    size: Number(stat.size),
    nlink: Number(stat.nlink),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    mtimeMs: Number(stat.mtimeNs) / 1e6,
    ctimeMs: Number(stat.ctimeNs) / 1e6,
    kind: stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
  };
}

function sameIdentity(expected, actual) {
  if (!expected || !actual) return false;
  for (const key of ['dev', 'ino', 'mode', 'size', 'nlink']) {
    if (expected[key] !== undefined && String(expected[key]) !== String(actual[key])) return false;
  }
  for (const prefix of ['mtime', 'ctime']) {
    if (expected[`${prefix}Ns`] !== undefined) {
      if (String(expected[`${prefix}Ns`]) !== String(actual[`${prefix}Ns`])) return false;
    } else if (Number(expected[`${prefix}Ms`]) !== Number(actual[`${prefix}Ms`])) return false;
  }
  return true;
}

function comparablePath(filePath, platform) {
  const api = platform === 'win32' ? path.win32 : path;
  const normalized = api.normalize(filePath);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function within(filePath, root, platform) {
  const api = platform === 'win32' ? path.win32 : path;
  const value = comparablePath(filePath, platform);
  const base = comparablePath(root, platform);
  return value === base || value.startsWith(base.endsWith(api.sep) ? base : `${base}${api.sep}`);
}

// Alpha intentionally supports manually selected ordinary files only.
function protectedPathReason(filePath, { platform = process.platform, home = os.homedir() } = {}) {
  const api = platform === 'win32' ? path.win32 : path;
  if (typeof filePath !== 'string' || filePath.includes('\0') || !api.isAbsolute(filePath)) return 'INVALID_PATH';
  const normalized = api.normalize(filePath);
  const components = normalized.split(/[\\/]/).filter(Boolean);
  if (components.some((component) => component.startsWith('.'))) return 'HIDDEN_PATH';

  if (platform === 'win32') {
    // UNC shares and Windows device namespaces do not have reliable trash semantics here.
    if (normalized.startsWith('\\\\')) return 'UNSUPPORTED_VOLUME';
    const parts = components.map((part) => part.toLowerCase());
    if (parts.some((part) => ['windows', 'program files', 'program files (x86)', 'programdata', 'system volume information', '$recycle.bin', '$windows.~bt', '$windows.~ws', 'recovery'].includes(part))) return 'SYSTEM_PATH';
    if (parts.includes('appdata') || parts.some((part) => /^ntuser\.(dat|ini)/.test(part))) return 'APPLICATION_DATA';
  } else {
    const protectedRoots = platform === 'darwin'
      ? ['/System', '/Library', '/Applications', '/private', '/bin', '/sbin', '/usr', '/dev', '/etc', '/var']
      : ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var'];
    if (protectedRoots.some((root) => within(normalized, root, platform))) {
      // Removable media mounted under /run/media remains a valid user-selected location.
      if (!(platform !== 'darwin' && within(normalized, '/run/media', platform))) return 'SYSTEM_PATH';
    }
    if (platform === 'darwin' && (within(normalized, path.join(home, 'Library'), platform) || /^\/Users\/[^/]+\/Library(?:\/|$)/.test(normalized))) return 'APPLICATION_DATA';
  }
  return null;
}

async function validateFile(expected, policy) {
  if (!expected || expected.unsupportedPath || typeof expected.path !== 'string') return { reason: 'UNSUPPORTED_PATH' };
  const protectedReason = protectedPathReason(expected.path, policy);
  if (protectedReason) return { reason: protectedReason };
  try {
    const parent = path.dirname(expected.path);
    const parentRealPath = await fs.realpath(parent);
    if (!expected.parentRealPath || comparablePath(parentRealPath, policy.platform) !== comparablePath(expected.parentRealPath, policy.platform)) return { reason: 'PARENT_CHANGED' };
    if (comparablePath(parentRealPath, policy.platform) !== comparablePath(parent, policy.platform)) return { reason: 'SYMLINK_PARENT' };
    const parentStat = await fs.lstat(parent, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return { reason: 'PARENT_CHANGED' };
    if (expected.parentDev !== undefined && (String(expected.parentDev) !== String(parentStat.dev) || String(expected.parentIno) !== String(parentStat.ino))) return { reason: 'PARENT_CHANGED' };
    const stat = await fs.lstat(expected.path, { bigint: true });
    if (stat.isSymbolicLink()) return { reason: 'SYMLINK' };
    if (!stat.isFile()) return { reason: 'NOT_REGULAR_FILE' };
    if (stat.nlink > 1n) return { reason: 'SHARED_FILE' };
    const actual = snapshot(stat, expected.path, parentRealPath, parentStat);
    if (!sameIdentity(expected, actual)) return { reason: 'IDENTITY_CHANGED' };
    return { identity: actual };
  } catch (error) {
    return { reason: error.code === 'ENOENT' ? 'MISSING_FILE' : error.code === 'EACCES' || error.code === 'EPERM' ? 'PERMISSION_DENIED' : 'UNREADABLE_FILE' };
  }
}

async function availableSpace(rootPath) {
  try {
    const stat = await fs.statfs(rootPath, { bigint: true });
    const free = Number(stat.bavail * stat.bsize);
    return Number.isSafeInteger(free) ? free : null;
  } catch { return null; }
}

function createCleanupService({ getEntry, getIdentity, getScanContext, trashItem, historyStore, now = Date.now, platform = process.platform, home = os.homedir(), measureSpace = availableSpace }) {
  if (typeof trashItem !== 'function') throw new Error('A native trash implementation is required.');
  const plans = new Map();
  const policy = { platform, home };

  async function plan(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PLAN_ITEMS || ids.some((id) => !Number.isSafeInteger(id) || id < 0)) throw new Error('INVALID_SELECTION');
    const context = getScanContext();
    if (!context) throw new Error('NO_SCAN');
    const items = [];
    const identities = new Map();
    let totalBytes = 0;
    for (const id of new Set(ids)) {
      const entry = await getEntry(id);
      const identity = await getIdentity(id);
      if (!entry || !identity || identity.path !== entry.path) {
        items.push({ id, path: entry?.path || '', size: 0, eligible: false, reason: 'NOT_IN_SCAN' });
        continue;
      }
      let reason = entry.kind === 'symlink' ? 'SYMLINK' : entry.kind !== 'file' ? 'NOT_REGULAR_FILE' : entry.state !== 'ready' ? 'SCAN_INCOMPLETE' : null;
      const validation = reason ? { reason } : await validateFile(identity, policy);
      reason = validation.reason;
      const reportedSize = entry.allocatedSize ?? entry.logicalSize;
      const size = Number.isFinite(reportedSize) && reportedSize > 0 ? reportedSize : 0;
      items.push({ id, path: entry.path, size, eligible: !reason, ...(reason ? { reason } : {}) });
      if (!reason) {
        identities.set(id, validation.identity);
        totalBytes += size;
      }
    }
    if (getScanContext()?.scanId !== context.scanId) throw new Error('SCAN_CHANGED');
    for (const [id, item] of plans) if (item.expiresAt <= now()) plans.delete(id);
    while (plans.size >= 10) plans.delete(plans.keys().next().value);
    const id = randomUUID();
    const publicPlan = { id, items, totalBytes };
    plans.set(id, { ...publicPlan, identities, scanId: context.scanId, rootPath: context.rootPath, expiresAt: now() + PLAN_TTL_MS });
    return publicPlan;
  }

  async function execute(planId, confirm) {
    if (typeof planId !== 'string' || typeof confirm !== 'function') throw new Error('INVALID_PLAN');
    const selected = plans.get(planId);
    if (!selected) throw new Error('PLAN_USED_OR_MISSING');
    // Consume before any asynchronous step to prevent concurrent/repeated execution.
    plans.delete(planId);
    if (selected.expiresAt <= now()) throw new Error('PLAN_EXPIRED');
    if (getScanContext()?.scanId !== selected.scanId) throw new Error('SCAN_CHANGED');
    const eligible = selected.items.filter((item) => item.eligible);
    if (!eligible.length) throw new Error('NO_ELIGIBLE_FILES');
    const accepted = await confirm({ id: selected.id, items: eligible.map((item) => ({ ...item })), totalBytes: selected.totalBytes });
    const results = selected.items.filter((item) => !item.eligible).map((item) => ({ path: item.path, status: 'skipped', error: item.reason }));
    const before = accepted ? await measureSpace(selected.rootPath) : null;
    for (const item of eligible) {
      if (!accepted) { results.push({ path: item.path, status: 'cancelled' }); continue; }
      if (selected.expiresAt <= now() || getScanContext()?.scanId !== selected.scanId) {
        results.push({ path: item.path, status: 'skipped', error: selected.expiresAt <= now() ? 'PLAN_EXPIRED' : 'SCAN_CHANGED' });
        continue;
      }
      const verified = await validateFile(selected.identities.get(item.id), policy);
      if (verified.reason) { results.push({ path: item.path, status: 'failed', error: verified.reason }); continue; }
      try {
        await trashItem(verified.identity.path);
        results.push({ path: item.path, status: 'trashed' });
      } catch (error) {
        results.push({ path: item.path, status: 'failed', error: String(error?.code || error?.message || 'TRASH_FAILED').slice(0, 500) });
      }
    }
    const after = accepted ? await measureSpace(selected.rootPath) : null;
    const result = {
      id: randomUUID(), time: now(), rootPath: selected.rootPath,
      success: results.filter((item) => item.status === 'trashed').length,
      failed: results.filter((item) => item.status === 'failed').length,
      items: results,
      freeSpaceDelta: before !== null && after !== null ? after - before : null,
    };
    if (historyStore) {
      try { await historyStore.append(result); }
      catch { result.historyError = 'HISTORY_WRITE_FAILED'; }
    }
    return result;
  }

  return { plan, execute, invalidate: () => plans.clear() };
}

module.exports = { createCleanupService, protectedPathReason, validateFile, sameIdentity, snapshot, availableSpace, PLAN_TTL_MS, MAX_PLAN_ITEMS };
