'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const PLATFORMS = new Set(['win32', 'darwin']);
const MAX_PATH_LENGTH = 32768;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 64;
const ERROR_CODES = new Set([
  'INVALID_NATIVE_REQUEST', 'UNSUPPORTED_PATH', 'NATIVE_POLICY_UNAVAILABLE',
  'NATIVE_METADATA_UNAVAILABLE', 'PERMISSION_DENIED', 'MISSING_FILE', 'EBUSY',
  'CLOUD_PLACEHOLDER', 'SYMLINK_PARENT', 'PARENT_CHANGED', 'NOT_REGULAR_FILE',
  'PREVIEW_VOLUME_UNVERIFIED', 'SHARED_FILE', 'IDENTITY_CHANGED', 'UNREADABLE_FILE',
  'HIDDEN_PATH', 'SYSTEM_PATH',
]);
const IDENTITY_KEYS = ['dev', 'ino', 'size', 'nlink', 'mtimeNs', 'ctimeNs', 'parentDev', 'parentIno'];
const error = code => Object.assign(new Error(code), { code });

function nativePaths(platform = process.platform, arch = process.arch) {
  // Executables cannot run inside ASAR. This exact directory is unpacked by the
  // packaging configuration; never resolve a program supplied by a renderer.
  const directory = path.join(__dirname, 'native', `${platform}-${arch}`)
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return {
    policy: path.join(directory, 'file-policy.node'),
    probe: path.join(directory, `file-probe${platform === 'win32' ? '.exe' : ''}`),
  };
}

function ensureNativePolicy({ platform = process.platform, load = require } = {}) {
  if (platform === 'linux') return true;
  if (!PLATFORMS.has(platform)) throw error('NATIVE_POLICY_UNAVAILABLE');
  try {
    // Run install on each calling thread, not just once per process. macOS's
    // process policy is also required for libuv filesystem pool threads.
    if (load(nativePaths(platform).policy).install() !== true) throw error('NATIVE_POLICY_UNAVAILABLE');
    return true;
  } catch { throw error('NATIVE_POLICY_UNAVAILABLE'); }
}

function validatePath(filePath, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (typeof filePath !== 'string' || !filePath || filePath.length > MAX_PATH_LENGTH ||
      filePath.includes('\0') || !api.isAbsolute(filePath) ||
      Buffer.from(filePath, 'utf8').toString('utf8') !== filePath) throw error('UNSUPPORTED_PATH');
  if (platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(filePath) || filePath.slice(2).includes(':'))) throw error('UNSUPPORTED_PATH');
  return filePath;
}

function validateMetadata(value, platform) {
  if (!value || !['file', 'directory', 'symlink', 'other'].includes(value.kind) ||
      !['hidden', 'system', 'reparsePoint'].every(key => typeof value[key] === 'boolean') ||
      !['resident', 'placeholder', 'unknown'].includes(value.cloudState) ||
      typeof value.volume?.local !== 'boolean' || typeof value.volume.filesystem !== 'string' ||
      value.volume.filesystem.length > 63 ||
      !(value.volume.mountPath === null || typeof value.volume.mountPath === 'string' && value.volume.mountPath.length <= MAX_PATH_LENGTH) ||
      !IDENTITY_KEYS.every(key => typeof value.identity?.[key] === 'string' &&
        (key === 'mtimeNs' || key === 'ctimeNs' ? /^-?\d{1,22}$/ : /^\d{1,22}$/).test(value.identity[key]))) {
    throw error('NATIVE_METADATA_UNAVAILABLE');
  }
  return {
    source: 'native', platform, kind: value.kind, hidden: value.hidden,
    system: value.system, reparsePoint: value.reparsePoint, cloudState: value.cloudState,
    volume: { mountPath: value.volume.mountPath, filesystem: value.volume.filesystem, local: value.volume.local },
    identity: Object.fromEntries(IDENTITY_KEYS.map(key => [key, value.identity[key]])),
  };
}

function nativeSafetyReason(metadata, { allowProtected = false, allowHidden = false } = {}) {
  if (metadata?.source !== 'native') return 'NATIVE_METADATA_UNAVAILABLE';
  if (metadata.cloudState === 'placeholder') return 'CLOUD_PLACEHOLDER';
  if (metadata.reparsePoint || metadata.kind === 'symlink') return 'SYMLINK_PARENT';
  if (metadata.cloudState !== 'resident') return 'NATIVE_METADATA_UNAVAILABLE';
  if (!metadata.volume?.local) return 'NATIVE_VOLUME_UNVERIFIED';
  if (!allowProtected && metadata.system) return 'SYSTEM_PATH';
  // A cleanup plan may explicitly include Windows H attributes only. This
  // never changes scanner policy, preview defaults, or system/cloud protection.
  if (!allowProtected && metadata.hidden && !(allowHidden === true && metadata.platform === 'win32')) return 'HIDDEN_PATH';
  return null;
}

function safeForContent(metadata, options) {
  const reason = nativeSafetyReason(metadata, options);
  if (reason) throw error(reason);
}

function getNativePathFlags(filePath, { platform = process.platform, load = require } = {}) {
  validatePath(filePath, platform);
  if (!PLATFORMS.has(platform)) throw error('NATIVE_METADATA_UNAVAILABLE');
  let flags;
  try { flags = load(nativePaths(platform).policy).pathFlags(filePath); }
  catch (failure) { throw error(failure?.code === 'NATIVE_POLICY_UNAVAILABLE' ? failure.code : 'NATIVE_METADATA_UNAVAILABLE'); }
  if (!flags || !['hidden', 'system', 'reparsePoint'].every(key => typeof flags[key] === 'boolean') ||
      !['resident', 'placeholder', 'unknown'].includes(flags.cloudState) ||
      !(flags.allocatedSize === null || Number.isSafeInteger(flags.allocatedSize) && flags.allocatedSize >= 0) ||
      !(flags.allocationIdentity === null || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key =>
        typeof flags.allocationIdentity?.[key] === 'string' && /^-?\d{1,22}$/.test(flags.allocationIdentity[key]))) ||
      flags.allocatedSize !== null && !flags.allocationIdentity) throw error('NATIVE_METADATA_UNAVAILABLE');
  return {
    hidden: flags.hidden, system: flags.system, reparsePoint: flags.reparsePoint, cloudState: flags.cloudState,
    allocatedSize: flags.allocatedSize, allocationIdentity: flags.allocationIdentity && { ...flags.allocationIdentity },
  };
}

function nativeAllocatedBytes(stat, flags) {
  if (!flags || !Number.isSafeInteger(flags.allocatedSize) || flags.allocatedSize < 0 || !flags.allocationIdentity || flags.cloudState !== 'resident' || flags.reparsePoint) return null;
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key =>
    stat[key] != null && String(stat[key]) === flags.allocationIdentity[key]) ? flags.allocatedSize : null;
}

function matchesNativeIdentity(expected, metadata) {
  return !!expected && !!metadata?.identity && IDENTITY_KEYS.every(key =>
    expected[key] != null && String(expected[key]) === metadata.identity[key]);
}

function createNativeSession({
  platform = process.platform, spawnProcess = spawn, installPolicy = ensureNativePolicy,
  timeoutMs = 15000, idleMs = 30000,
} = {}) {
  if (!PLATFORMS.has(platform)) throw error('NATIVE_METADATA_UNAVAILABLE');
  installPolicy({ platform });
  const child = spawnProcess(nativePaths(platform).probe, [], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
  const pending = new Map();
  let nextId = 1;
  let output = '';
  let closed = false;
  let idleTimer;
  const setReferenced = referenced => {
    const method = referenced ? 'ref' : 'unref';
    child[method]?.();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream[method]?.();
  };
  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (!pending.size) {
      setReferenced(false);
      idleTimer = setTimeout(() => close(), idleMs);
      idleTimer.unref?.();
    }
  };
  const close = (reason = 'NATIVE_METADATA_UNAVAILABLE') => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error(reason)); }
    pending.clear();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.kill();
  };
  child.once('error', () => close());
  child.once('exit', () => close());
  child.stdin.on('error', () => close());
  // Drain bounded-by-stream stderr without exposing arbitrary native diagnostics
  // or allowing an unconsumed pipe to stall the protocol.
  child.stderr.on('data', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (Buffer.byteLength(output, 'utf8') > MAX_RESPONSE_BYTES) { close(); return; }
    for (;;) {
      const newline = output.indexOf('\n');
      if (newline < 0) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      let response;
      try { response = JSON.parse(line); } catch { close(); return; }
      const item = pending.get(response?.id);
      if (!item) { close(); return; }
      pending.delete(response.id);
      clearTimeout(item.timer);
      try {
        if (response.error != null) {
          if (!ERROR_CODES.has(response.error)) throw error('NATIVE_METADATA_UNAVAILABLE');
          throw error(response.error);
        }
        const metadata = validateMetadata(response.metadata, platform);
        if (item.operation === 'R') {
          safeForContent(metadata);
          if (metadata.kind !== 'file' || !IDENTITY_KEYS.every(key => metadata.identity[key] === item.expected[key])) throw error('IDENTITY_CHANGED');
          if (typeof response.bytes !== 'string' || response.bytes.length !== Math.ceil(item.limit / 3) * 4) throw error('NATIVE_METADATA_UNAVAILABLE');
          const bytes = Buffer.from(response.bytes, 'base64');
          if (bytes.length !== item.limit || bytes.toString('base64') !== response.bytes) throw error('NATIVE_METADATA_UNAVAILABLE');
          item.resolve({ metadata, bytes });
        } else {
          if ('bytes' in response) throw error('NATIVE_METADATA_UNAVAILABLE');
          item.resolve(metadata);
        }
      } catch (failure) { item.reject(failure); }
      scheduleIdle();
    }
  });
  scheduleIdle();

  function request(operation, filePath, expected, limit) {
    try {
      validatePath(filePath, platform);
      if (closed || pending.size >= MAX_PENDING) throw error('NATIVE_METADATA_UNAVAILABLE');
      clearTimeout(idleTimer);
      setReferenced(true);
      const id = nextId++;
      const fields = [id, operation, Buffer.from(filePath, 'utf8').toString('hex')];
      let canonical;
      if (operation === 'R') {
        if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PREVIEW_BYTES || limit > expected?.size) throw error('INVALID_NATIVE_REQUEST');
        canonical = Object.fromEntries(IDENTITY_KEYS.map(key => [key, String(expected?.[key])]));
        if (!IDENTITY_KEYS.every(key => (key === 'mtimeNs' || key === 'ctimeNs' ? /^-?\d{1,22}$/ : /^\d{1,22}$/).test(canonical[key]))) throw error('INVALID_NATIVE_REQUEST');
        fields.push(limit, ...IDENTITY_KEYS.map(key => canonical[key]));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => close(), timeoutMs);
        pending.set(id, { operation, expected: canonical, limit, resolve, reject, timer });
        child.stdin.write(`${fields.join('\t')}\n`, failure => { if (failure) close(); });
      });
    } catch (failure) { scheduleIdle(); return Promise.reject(failure); }
  }
  return {
    metadata: filePath => request('M', filePath),
    read: (filePath, expected, limit) => request('R', filePath, expected, limit),
    close,
    get closed() { return closed; },
  };
}

let shared;
function session() {
  if (!shared || shared.closed) shared = createNativeSession();
  return shared;
}
function getNativeMetadata(filePath) { return session().metadata(filePath); }
function readNativePreview(filePath, expected, limit) { return session().read(filePath, expected, limit); }
function closeNativeSession() { shared?.close(); shared = undefined; }

module.exports = {
  ensureNativePolicy, createNativeSession, getNativeMetadata, readNativePreview,
  closeNativeSession, nativePaths, validateMetadata, safeForContent,
  nativeSafetyReason, matchesNativeIdentity,
  getNativePathFlags,
  nativeAllocatedBytes,
};
