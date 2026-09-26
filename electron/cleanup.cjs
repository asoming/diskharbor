'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { sampleVolume } = require('./volume-space.cjs');

const PLAN_TTL_MS = 2 * 60 * 1000;
const MAX_PLAN_ITEMS = 500;
const MAX_MANIFEST_ENTRIES = 10001;

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
    kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
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

// These policy exclusions apply to selected objects and every directory descendant.
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

function directoryRootReason(filePath, policy) {
  const api = policy.platform === 'win32' ? path.win32 : path;
  const normalized = comparablePath(filePath, policy.platform);
  const protectedRoots = [api.parse(filePath).root, policy.home, policy.scanRoot].filter(Boolean);
  if (protectedRoots.some(root => comparablePath(root, policy.platform) === normalized)) return 'PROTECTED_ROOT';
  if (policy.platform === 'win32' ? /^[a-z]:\\users(?:\\[^\\]+)?$/i.test(normalized) : /^\/(?:home|Users)(?:\/[^/]+)?$/.test(normalized)) return 'PROTECTED_ROOT';
  return protectedPathReason(filePath, policy);
}

async function validateObject(expected, policy, kind = 'file') {
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
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) return { reason: 'NOT_REGULAR_FILE' };
    if (stat.isFile() && stat.nlink > 1n) return { reason: 'SHARED_FILE' };
    if (stat.dev !== parentStat.dev && kind === 'directory') return { reason: 'UNSUPPORTED_VOLUME' };
    const actual = snapshot(stat, expected.path, parentRealPath, parentStat);
    if (!sameIdentity(expected, actual)) return { reason: 'IDENTITY_CHANGED' };
    return { identity: actual };
  } catch (error) {
    return { reason: error.code === 'ENOENT' ? 'MISSING_FILE' : error.code === 'EACCES' || error.code === 'EPERM' ? 'PERMISSION_DENIED' : 'UNREADABLE_FILE' };
  }
}

async function validateFile(expected, policy) {
  return validateObject(expected, policy, 'file');
}

function manifestNodes(rootEntry, expected, manifest, policy) {
  if (!manifest || !Array.isArray(manifest.entries)) return { reason: 'MANIFEST_UNAVAILABLE' };
  if (manifest.truncated || manifest.entries.length > MAX_MANIFEST_ENTRIES) return { reason: 'DIRECTORY_TOO_LARGE' };
  if (!manifest.entries.length) return { reason: 'MANIFEST_INCOMPLETE' };
  const nodes = new Map();
  const byId = new Map();
  for (const node of manifest.entries) {
    const entry = node?.entry;
    const identity = node?.identity;
    const blockedPath = entry?.path || expected.path;
    if (!entry || !identity || identity.path !== entry.path || !within(entry.path, expected.path, policy.platform)) return { reason: 'MANIFEST_INCOMPLETE', blockedPath };
    if (identity.unsupportedPath || entry.kind === 'symlink' || (entry.kind !== 'file' && entry.kind !== 'directory') || (entry.kind === 'file' && identity.nlink > 1)) return { reason: 'UNSAFE_DESCENDANT', blockedPath };
    if (entry.state !== 'ready') return { reason: 'MANIFEST_INCOMPLETE', blockedPath };
    const protectedReason = entry.kind === 'directory' ? directoryRootReason(entry.path, policy) : protectedPathReason(entry.path, policy);
    if (protectedReason) return { reason: entry.id === rootEntry.id ? protectedReason : 'UNSAFE_DESCENDANT', blockedPath };
    if (['dev', 'ino', 'mode', 'size', 'nlink', 'mtimeNs', 'ctimeNs', 'parentRealPath'].some(key => identity[key] == null)) return { reason: 'MANIFEST_INCOMPLETE', blockedPath };
    const key = comparablePath(entry.path, policy.platform);
    if (nodes.has(key) || byId.has(entry.id)) return { reason: 'MANIFEST_INCOMPLETE', blockedPath };
    const copy = { entry: { ...entry }, identity: { ...identity } };
    nodes.set(key, copy);
    byId.set(entry.id, copy);
  }
  const root = byId.get(rootEntry.id);
  if (!root || root.entry.path !== expected.path || !sameIdentity(expected, root.identity)) return { reason: 'MANIFEST_INCOMPLETE', blockedPath: expected.path };
  for (const node of nodes.values()) {
    if (node === root) continue;
    const parent = byId.get(node.entry.parentId);
    if (!parent || parent.entry.kind !== 'directory' || comparablePath(path.dirname(node.entry.path), policy.platform) !== comparablePath(parent.entry.path, policy.platform)) return { reason: 'MANIFEST_INCOMPLETE', blockedPath: node.entry.path };
    node.identity.parentDev = parent.identity.dev;
    node.identity.parentIno = parent.identity.ino;
  }
  return { nodes, root };
}

function directoryFailure(reason, blockedPath, isRoot = false) {
  if (reason === 'IDENTITY_CHANGED' || reason === 'MISSING_FILE' || reason === 'PARENT_CHANGED') return { reason: 'DIRECTORY_CHANGED', blockedPath };
  if (!isRoot && ['SYMLINK', 'SHARED_FILE', 'NOT_REGULAR_FILE', 'UNSUPPORTED_PATH', 'SYMLINK_PARENT', 'UNSUPPORTED_VOLUME'].includes(reason)) return { reason: 'UNSAFE_DESCENDANT', blockedPath };
  return { reason, blockedPath };
}

async function validateDirectory(rootEntry, expected, manifest, policy, shouldCancel = () => false) {
  const protectedReason = directoryRootReason(expected.path, policy);
  if (protectedReason) return { reason: protectedReason, blockedPath: expected.path };
  const compiled = manifestNodes(rootEntry, expected, manifest, policy);
  if (compiled.reason) return compiled;
  const { nodes, root } = compiled;
  const visited = new Set([comparablePath(expected.path, policy.platform)]);
  const verifiedNodes = new Map();
  const pending = [root];
  while (pending.length) {
    if (shouldCancel()) return { reason: 'OPERATION_CANCELLED' };
    const current = pending.pop();
    const directoryPath = current.entry.path;
    const verified = await validateObject(current.identity, policy, 'directory');
    if (verified.reason) return directoryFailure(verified.reason, directoryPath, current === root);
    verifiedNodes.set(current.entry.id, { entry: { ...current.entry }, identity: verified.identity });
    let handle;
    try {
      handle = await fs.opendir(directoryPath, { encoding: process.platform === 'win32' ? 'utf8' : 'buffer' });
      while (true) {
        if (shouldCancel()) return { reason: 'OPERATION_CANCELLED' };
        const dirent = await handle.read();
        if (!dirent) break;
        const name = Buffer.isBuffer(dirent.name) ? dirent.name.toString('utf8') : dirent.name;
        if (Buffer.isBuffer(dirent.name) && !Buffer.from(name).equals(dirent.name)) return { reason: 'UNSAFE_DESCENDANT', blockedPath: directoryPath };
        const filePath = path.join(directoryPath, name);
        const key = comparablePath(filePath, policy.platform);
        const node = nodes.get(key);
        if (!node || visited.has(key)) return { reason: 'DIRECTORY_CHANGED', blockedPath: filePath };
        visited.add(key);
        if (visited.size > MAX_MANIFEST_ENTRIES) return { reason: 'DIRECTORY_TOO_LARGE', blockedPath: directoryPath };
        if (node.entry.kind === 'directory') pending.push(node);
        else {
          const actual = await validateFile(node.identity, policy);
          if (actual.reason) return directoryFailure(actual.reason, filePath);
          verifiedNodes.set(node.entry.id, { entry: { ...node.entry }, identity: actual.identity });
        }
      }
    } catch (error) {
      return { reason: error.code === 'ENOENT' ? 'DIRECTORY_CHANGED' : error.code === 'EACCES' || error.code === 'EPERM' ? 'PERMISSION_DENIED' : 'UNREADABLE_FILE', blockedPath: directoryPath };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    // Detect membership/metadata changes while this directory was being enumerated.
    const after = await validateObject(verified.identity, policy, 'directory');
    if (after.reason) return directoryFailure(after.reason, directoryPath, current === root);
  }
  if (visited.size !== nodes.size) {
    const missing = [...nodes.keys()].find(key => !visited.has(key));
    return { reason: 'DIRECTORY_CHANGED', blockedPath: nodes.get(missing)?.entry.path || expected.path };
  }
  // This is a bounded metadata verification, not an atomic filesystem transaction.
  const finalRoot = await validateObject(verifiedNodes.get(root.entry.id).identity, policy, 'directory');
  if (finalRoot.reason) return directoryFailure(finalRoot.reason, expected.path, true);
  return { identity: finalRoot.identity, manifest: { entries: [...verifiedNodes.values()], truncated: false } };
}

function createCleanupService({ getEntry, getIdentity, getManifest, getScanContext, trashItem, historyStore, now = Date.now, platform = process.platform, home = os.homedir(), measureSpace = sampleVolume }) {
  if (typeof trashItem !== 'function') throw new Error('A native trash implementation is required.');
  const plans = new Map();
  const policy = { platform, home };
  let active = false;

  async function plan(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PLAN_ITEMS || ids.some((id) => !Number.isSafeInteger(id) || id < 0)) throw new Error('INVALID_SELECTION');
    const context = getScanContext();
    if (!context) throw new Error('NO_SCAN');
    // Capture the scanner's original root identity, never a fresh replacement's identity.
    const rootIdentity = Number.isSafeInteger(context.rootId)
      ? await Promise.resolve().then(() => getIdentity(context.rootId)).catch(() => null) : null;
    const candidates = [];
    for (const id of new Set(ids)) candidates.push({ id, entry: await getEntry(id), identity: await getIdentity(id) });
    // Normalize before checking eligibility. A blocked ancestor never turns into child operations.
    const normalized = candidates.filter(candidate => !candidate.entry || !candidates.some(parent =>
      parent !== candidate && parent.entry?.kind === 'directory' &&
      comparablePath(parent.entry.path, platform) !== comparablePath(candidate.entry.path, platform) && within(candidate.entry.path, parent.entry.path, platform),
    ));
    const omittedCount = candidates.length - normalized.length;
    const items = [];
    const snapshots = new Map();
    const scopedPolicy = { ...policy, scanRoot: context.rootPath };
    let manifestEntries = 0;
    let totalBytes = 0;
    for (const { id, entry, identity } of normalized) {
      if (!entry || !identity || identity.path !== entry.path) {
        items.push({ id, path: entry?.path || '', kind: entry?.kind || 'other', fileCount: 0, size: 0, eligible: false, reason: 'NOT_IN_SCAN' });
        continue;
      }
      let reason = entry.kind === 'symlink' ? 'SYMLINK' : !['file', 'directory'].includes(entry.kind) ? 'NOT_REGULAR_FILE' : entry.state !== 'ready' ? 'SCAN_INCOMPLETE' : null;
      let validation = { reason };
      if (!reason && entry.kind === 'directory') {
        reason = directoryRootReason(entry.path, scopedPolicy);
        if (reason) validation = { reason, blockedPath: entry.path };
        else if (typeof getManifest !== 'function') validation = { reason: 'MANIFEST_UNAVAILABLE' };
        else {
          const manifest = await getManifest(id);
          if (manifestEntries + (manifest?.entries?.length || 0) > MAX_MANIFEST_ENTRIES) validation = { reason: 'DIRECTORY_TOO_LARGE', blockedPath: entry.path };
          else validation = await validateDirectory(entry, identity, manifest, scopedPolicy);
        }
      } else if (!reason) validation = await validateFile(identity, policy);
      reason = validation.reason;
      const reportedSize = entry.allocatedSize ?? entry.logicalSize;
      const size = Number.isFinite(reportedSize) && reportedSize > 0 ? reportedSize : 0;
      items.push({ id, path: entry.path, kind: entry.kind, fileCount: entry.kind === 'file' ? 1 : Math.max(0, Number(entry.fileCount) || 0), size, eligible: !reason, ...(reason ? { reason } : {}), ...(validation.blockedPath ? { blockedPath: validation.blockedPath } : {}) });
      if (!reason) {
        snapshots.set(id, { entry: { ...entry }, identity: validation.identity, manifest: validation.manifest });
        manifestEntries += validation.manifest?.entries.length || 0;
        totalBytes += size;
      }
    }
    if (getScanContext()?.scanId !== context.scanId) throw new Error('SCAN_CHANGED');
    for (const [id, item] of plans) if (item.expiresAt <= now()) plans.delete(id);
    while (plans.size >= 10) plans.delete(plans.keys().next().value);
    const id = randomUUID();
    const createdAt = now();
    const publicPlan = { id, items, totalBytes, omittedCount, createdAt, expiresAt: createdAt + PLAN_TTL_MS };
    plans.set(id, { ...publicPlan, snapshots, scanId: context.scanId, rootPath: context.rootPath,
      rootIdentity: rootIdentity?.path === context.rootPath ? structuredClone(rootIdentity) : null });
    return structuredClone(publicPlan);
  }

  async function execute(planId, confirm, { onProgress = () => {}, shouldCancel = () => false } = {}) {
    if (typeof planId !== 'string' || typeof confirm !== 'function') throw new Error('INVALID_PLAN');
    const selected = plans.get(planId);
    if (!selected) throw new Error('PLAN_USED_OR_MISSING');
    if (active) throw new Error('CLEANUP_IN_PROGRESS');
    // Consume before any asynchronous step to prevent concurrent/repeated execution.
    plans.delete(planId);
    active = true;
    const startedAt = now();
    const result = {
      id: randomUUID(), planId, state: 'running', time: startedAt, rootPath: selected.rootPath,
      total: selected.items.length, totalBytes: selected.totalBytes,
      success: 0, failed: 0, skipped: 0, cancelled: 0,
      items: selected.items.map(item => ({ path: item.path, kind: item.kind, size: item.size, status: item.eligible ? 'pending' : 'skipped', ...(item.reason ? { error: item.reason } : {}) })),
      freeSpaceDelta: null,
      spaceMeasurement: { version: 1, before: null, after: null, status: 'pending' },
    };
    let cancelRequested = false;
    let currentPath;
    let poller;
    let before;
    let interrupted = false;
    let historyFailed = false;
    const refreshCounts = () => {
      result.success = result.items.filter(item => item.status === 'trashed').length;
      result.failed = result.items.filter(item => item.status === 'failed').length;
      result.skipped = result.items.filter(item => item.status === 'skipped').length;
      result.cancelled = result.items.filter(item => item.status === 'cancelled').length;
    };
    const emit = state => {
      refreshCounts();
      try { onProgress({ id: result.id, planId, state, total: result.total, processed: result.success + result.failed + result.skipped + result.cancelled, success: result.success, failed: result.failed, skipped: result.skipped, cancelled: result.cancelled, ...(currentPath ? { currentPath } : {}), startedAt }); } catch { /* UI delivery cannot change the mutation outcome. */ }
    };
    const observeCancel = () => {
      if (!cancelRequested) {
        try { cancelRequested = Boolean(shouldCancel()); } catch { cancelRequested = true; }
        if (cancelRequested) emit('cancelling');
      }
      return cancelRequested;
    };
    const persist = async () => {
      refreshCounts();
      const writer = historyStore?.upsert || historyStore?.append;
      if (typeof writer !== 'function') throw new Error('HISTORY_WRITE_FAILED');
      await writer.call(historyStore, structuredClone(result));
    };
    const markPending = (status, error) => {
      for (const item of result.items) if (item.status === 'pending') { item.status = status; if (error) item.error = error; }
    };
    const stopForHistoryFailure = () => {
      historyFailed = true;
      interrupted = true;
      result.historyError = 'HISTORY_WRITE_FAILED';
      markPending('skipped', 'HISTORY_WRITE_FAILED');
    };
    const persistOrStop = async () => {
      try { await persist(); return true; }
      catch { stopForHistoryFailure(); return false; }
    };
    const measure = async () => {
      try {
        const reading = await measureSpace(selected.rootPath, selected.rootIdentity, selected.rootIdentity?.realPath);
        const sample = reading?.sample;
        if (!sample || !Number.isSafeInteger(sample.measuredAt) || sample.measuredAt < 0 ||
            !Number.isSafeInteger(sample.total) || sample.total <= 0 ||
            !Number.isSafeInteger(sample.free) || sample.free < 0 || sample.free > sample.total ||
            typeof reading.signature !== 'string' || !reading.signature.length) return { reading: null, error: 'SPACE_UNAVAILABLE' };
        return { reading: { sample: { measuredAt: sample.measuredAt, total: sample.total, free: sample.free }, signature: reading.signature } };
      } catch (error) {
        return { reading: null, error: error?.code === 'SPACE_ROOT_CHANGED' ? 'SPACE_ROOT_CHANGED' : 'SPACE_UNAVAILABLE' };
      }
    };
    try {
      if (selected.expiresAt <= now()) throw new Error('PLAN_EXPIRED');
      if (getScanContext()?.scanId !== selected.scanId) throw new Error('SCAN_CHANGED');
      const eligible = selected.items.filter(item => item.eligible);
      if (!eligible.length) throw new Error('NO_ELIGIBLE_FILES');
      emit('confirming');
      const accepted = await confirm({ id: selected.id, items: eligible.map(item => ({ ...item })), totalBytes: selected.totalBytes, omittedCount: selected.omittedCount, createdAt: selected.createdAt, expiresAt: selected.expiresAt });
      // TTL ends at acceptance. A valid long-running batch is not expired halfway through.
      if (accepted && selected.expiresAt <= now()) throw new Error('PLAN_EXPIRED');
      if (accepted && getScanContext()?.scanId !== selected.scanId) throw new Error('SCAN_CHANGED');
      if (!accepted || observeCancel()) {
        markPending('cancelled', 'OPERATION_CANCELLED');
        result.state = 'cancelled';
        result.spaceMeasurement.status = 'not-run';
        result.finishedAt = now();
        try { await persist(); } catch { result.historyError = 'HISTORY_WRITE_FAILED'; }
        emit('cancelled');
        return result;
      }
      try { await persist(); }
      catch { markPending('skipped', 'HISTORY_WRITE_FAILED'); throw new Error('HISTORY_WRITE_FAILED'); }
      poller = setInterval(observeCancel, 50);
      emit('running');
      before = await measure();
      result.spaceMeasurement.before = before.reading?.sample ?? null;
      for (let index = 0; index < selected.items.length; index++) {
        const planned = selected.items[index];
        const item = result.items[index];
        if (!planned.eligible) continue;
        if (observeCancel()) { markPending('cancelled', 'OPERATION_CANCELLED'); break; }
        if (getScanContext()?.scanId !== selected.scanId) {
          markPending('skipped', 'SCAN_CHANGED');
          interrupted = true;
          break;
        }
        currentPath = item.path;
        item.status = 'processing';
        // This durable marker precedes final verification and any native filesystem mutation.
        if (!await persistOrStop()) {
          item.status = 'skipped';
          item.error = 'HISTORY_WRITE_FAILED';
          break;
        }
        emit(cancelRequested ? 'cancelling' : 'running');
        const expected = selected.snapshots.get(planned.id);
        const scopedPolicy = { ...policy, scanRoot: selected.rootPath };
        let verified;
        try {
          verified = planned.kind === 'directory'
            ? await validateDirectory(expected.entry, expected.identity, expected.manifest, scopedPolicy, observeCancel)
            : await validateFile(expected.identity, policy);
        } catch { verified = { reason: 'UNREADABLE_FILE' }; }
        if (observeCancel() || verified.reason === 'OPERATION_CANCELLED') {
          item.status = 'cancelled';
          item.error = 'OPERATION_CANCELLED';
          markPending('cancelled', 'OPERATION_CANCELLED');
          break;
        }
        if (getScanContext()?.scanId !== selected.scanId) {
          item.status = 'skipped';
          item.error = 'SCAN_CHANGED';
          markPending('skipped', 'SCAN_CHANGED');
          interrupted = true;
          break;
        }
        if (verified.reason) {
          item.status = 'failed';
          item.error = verified.reason;
        } else {
          try {
            // One selected directory is one native Trash call. No recursive deletion is used.
            await trashItem(verified.identity.path);
            item.status = 'trashed';
          } catch (error) {
            item.status = 'failed';
            item.error = String(error?.code || error?.message || 'TRASH_FAILED').slice(0, 500);
          }
        }
        if (!await persistOrStop()) break;
        currentPath = undefined;
        emit(observeCancel() ? 'cancelling' : 'running');
      }
      clearInterval(poller);
      poller = undefined;
      currentPath = undefined;
      const after = await measure();
      const status = [before.error, after.error].includes('SPACE_ROOT_CHANGED') ? 'root-changed'
        : !before.reading || !after.reading ? 'unavailable'
        : before.reading.signature !== after.reading.signature || before.reading.sample.total !== after.reading.sample.total ? 'volume-changed'
        : 'comparable';
      result.spaceMeasurement = { version: 1, before: before.reading?.sample ?? null, after: after.reading?.sample ?? null, status };
      result.freeSpaceDelta = status === 'comparable' ? after.reading.sample.free - before.reading.sample.free : null;
      result.state = interrupted ? 'interrupted' : result.items.some(item => item.status === 'cancelled') ? 'cancelled' : 'completed';
      result.finishedAt = now();
      // A final best-effort journal can preserve known results after a transient write failure.
      // If it also fails, the durable processing marker must remain uncertain on restart.
      if (!await persistOrStop()) result.state = 'interrupted';
      emit(historyFailed || interrupted ? 'failed' : result.state === 'cancelled' ? 'cancelled' : 'completed');
      return result;
    } catch (error) {
      emit('failed');
      throw error;
    } finally {
      clearInterval(poller);
      active = false;
    }
  }

  return { plan, execute, invalidate: () => plans.clear() };
}

module.exports = { createCleanupService, protectedPathReason, validateFile, validateDirectory, sameIdentity, snapshot, PLAN_TTL_MS, MAX_PLAN_ITEMS, MAX_MANIFEST_ENTRIES };
