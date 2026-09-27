'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { setImmediate: yieldToEventLoop } = require('node:timers/promises');
const { buildCacheReport } = require('./cache-rules.cjs');
const { sampleVolume, spaceError } = require('./volume-space.cjs');
const { createPathVisibility } = require('./path-visibility.cjs');
const { ensureNativePolicy, createNativeSession, safeForContent, getNativePathFlags, nativeAllocatedBytes } = require('./native-metadata.cjs');

const CATEGORIES = ['apps', 'video', 'images', 'documents', 'archives', 'audio', 'other', 'system'];
const EXTENSIONS = new Map();
for (const [category, extensions] of Object.entries({
  apps: 'exe msi app appimage deb rpm dmg pkg apk dll so dylib',
  video: 'mp4 mkv mov avi webm m4v wmv mpg mpeg ts',
  images: 'jpg jpeg png gif webp avif heic heif bmp tif tiff svg raw',
  documents: 'pdf txt md doc docx odt rtf xls xlsx ods csv ppt pptx odp epub',
  archives: 'zip 7z rar tar gz bz2 xz zst iso',
  audio: 'mp3 wav flac aac m4a ogg opus aiff',
})) {
  for (const extension of extensions.split(' ')) EXTENSIONS.set(extension, category);
}

const VIRTUAL_FILESYSTEMS = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'ramfs', 'cgroup', 'cgroup2',
  'securityfs', 'debugfs', 'tracefs', 'configfs', 'pstore', 'efivarfs', 'mqueue',
  'hugetlbfs', 'fusectl', 'binfmt_misc', 'nsfs', 'autofs',
]);
const MAX_ERROR_DETAILS = 100;
const MAX_CLEANUP_MANIFEST_DESCENDANTS = 10000;
const MAX_RESOLVE_PATHS = 256;
const MAX_RESOLVE_PATH_LENGTH = 32768;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function parseMountInfo(text) {
  return text.split('\n').filter(Boolean).flatMap(line => {
    const separator = line.indexOf(' - ');
    if (separator < 0) return [];
    const fields = line.slice(0, separator).split(' ');
    const details = line.slice(separator + 3).split(' ');
    if (fields.length < 6 || !details[0]) return [];
    return [{ path: decodeMountPath(fields[4]), type: details[0], device: fields[2] }];
  });
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function kindOf(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

function allocatedBytes(stat) {
  if (stat.blocks == null || stat.blocks < 0) return null;
  const bytes = Number(stat.blocks) * 512;
  return Number.isFinite(bytes) ? bytes : null;
}

function displayPath(rawPath) {
  if (!Buffer.isBuffer(rawPath)) return { text: rawPath, unsupported: false };
  const text = rawPath.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(rawPath)) return { text, unsupported: false };
  // Escaping invalid bytes is display-only. Never turn this string back into an operation path.
  return {
    text: [...rawPath].map(byte => byte >= 32 && byte < 127 && byte !== 92 ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`).join(''),
    unsupported: true,
  };
}

function childPath(parent, name) {
  if (!Buffer.isBuffer(parent) && !Buffer.isBuffer(name)) return path.join(parent, name);
  const prefix = Buffer.isBuffer(parent) ? parent : Buffer.from(parent);
  return Buffer.concat([prefix, prefix.at(-1) === 47 ? Buffer.alloc(0) : Buffer.from('/'), Buffer.isBuffer(name) ? name : Buffer.from(name)]);
}

// Return the same stable prefix as a complete sort while keeping its candidate
// array intact. Small first pages avoid O(n log n) work during live scanning.
function sortedPrefix(entries, limit, compare) {
  if (limit <= 0) return [];
  const heap = [];
  for (const entry of entries) {
    if (heap.length < limit) {
      heap.push(entry);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (compare(heap[parent], heap[index]) >= 0) break;
        [heap[parent], heap[index]] = [heap[index], heap[parent]];
        index = parent;
      }
    } else if (compare(entry, heap[0]) < 0) {
      heap[0] = entry;
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
        if (compare(heap[index], heap[child]) >= 0) break;
        [heap[index], heap[child]] = [heap[child], heap[index]];
        index = child;
      }
    }
  }
  return heap.sort(compare);
}

class ScanIndex {
  constructor(rootPath, { onProgress, shouldCancel, scanId, visibilityContext } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) throw new TypeError('Scan root must be an absolute path.');
    this.rootPath = path.resolve(rootPath);
    this._visibility = createPathVisibility(this.rootPath,
      visibilityContext || { platform: process.platform, home: os.homedir() });
    this.scanId = scanId || randomUUID();
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.shouldCancel = typeof shouldCancel === 'function' ? shouldCancel : () => false;
    this._records = [null];
    // Reuse each entry's existing path string; values are IDs, not another Entry copy.
    // Zero marks a display-only or ambiguous name that must never restore selection.
    this._pathIds = new Map();
    this._children = new Map();
    this._hardlinks = new Map();
    this._deviceStrings = new Map();
    this._lastParentIdentity = null;
    this._mounts = [];
    this._mountPoints = new Set();
    this._state = 'idle';
    this._startedAt = 0;
    this._finishedAt = 0;
    this._files = 0;
    this._directories = 0;
    this._errors = 0;
    this._skipped = 0;
    this._errorDetails = [];
    this._lastProgress = 0;
    this._steps = 0;
    this._revision = 0;
    this._queryCache = new Map();
    this._queryCacheRevision = -1;
    this._volume = null;
    this._volumeBaseline = null;
    this._spaceCheckInFlight = false;
    this._coverage = {
      deviceId: null, mountPath: null, filesystem: null, boundaryDetection: 'device-only',
      skipped: { mounts: 0, symbolicLinks: 0, virtualFilesystems: 0, specialFiles: 0 },
      unsupportedNames: 0,
    };
    this._message = undefined;
    this._categories = new Map(CATEGORIES.map(category => [category, { category, bytes: 0, files: 0 }]));
  }

  async scan() {
    if (this._state !== 'idle') throw new Error('A ScanIndex can only scan once.');
    this._state = 'scanning';
    this._startedAt = Date.now();
    this._notify(true);
    const root = this._newRecord(null, this.rootPath, path.basename(this.rootPath) || this.rootPath, 'directory');
    try {
      if (process.platform === 'win32' || process.platform === 'darwin') {
        ensureNativePolicy();
        this._nativeSession = createNativeSession();
        this._nativeRoot = await this._nativeMetadata(this.rootPath);
        this._requireNativeDirectory(this._nativeRoot);
        this._nativeSystemRoot = this._visibility.rootIsSystem ||
          (this.rootPath !== path.parse(this.rootPath).root && this._nativeRoot.system);
      }
      const stat = await fs.lstat(this.rootPath, { bigint: true });
      this._rootDevice = stat.dev.toString();
      this._coverage.deviceId = this._rootDevice;
      this._rootRealPath = stat.isDirectory() ? await fs.realpath(this.rootPath) : this.rootPath;
      await this._loadMounts();
      const parentRealPath = await fs.realpath(path.dirname(this.rootPath)).catch(() => null);
      const parentStat = await fs.lstat(path.dirname(this.rootPath), { bigint: true }).catch(() => null);
      this._setMetadata(root, stat, parentRealPath, parentStat);
      root.identity.realPath = this._rootRealPath;
      await this._loadVolume();
      const rootMount = this._mounts.filter(mount => containsPath(mount.path, this._rootRealPath)).sort((a, b) => b.path.length - a.path.length)[0];
      this._coverage.mountPath = rootMount?.path ?? this._nativeRoot?.volume.mountPath ?? null;
      this._coverage.filesystem = rootMount?.type ?? this._nativeRoot?.volume.filesystem ?? null;
      if (root.entry.kind === 'directory' && rootMount && VIRTUAL_FILESYSTEMS.has(rootMount.type)) {
        this._skip(root, `Virtual filesystem (${rootMount.type}); contents not scanned.`, 'virtualFilesystems');
      } else if (root.entry.kind === 'directory') {
        const pending = [root];
        while (pending.length && !this.shouldCancel()) {
          const directory = pending.pop();
          await this._scanDirectory(directory, pending);
          await this._checkpoint();
        }
      } else {
        this._acceptLeaf(root);
      }
      if (!this.shouldCancel() && root.identity && root.entry.state !== 'error') await this._verifyRoot(root);
      this._state = this.shouldCancel() ? 'cancelled' : root.entry.state === 'error' ? 'error' : 'completed';
    } catch (error) {
      this._recordError(root, error);
      this._state = 'error';
    } finally {
      this._nativeSession?.close();
      this._nativeSession = null;
    }
    if (this._state === 'cancelled') this._message = 'Scan cancelled; results cover only discovered entries.';
    // Unfinished directories retain their discovered subtotals, explicitly marked partial.
    for (let i = this._records.length - 1; i >= 1; i--) {
      const record = this._records[i];
      if (record.entry.state === 'pending') {
        record.entry.state = 'partial';
        record.partial = true;
        this._markAncestorsPartial(record);
      }
    }
    this._finishedAt = Date.now();
    this._revision++;
    this._notify(true);
    return this.summary();
  }

  _requireNativeDirectory(metadata) {
    // Node filesystem operations run only after the process policy is installed.
    // A native metadata-only check rejects data-less / reparse ancestors before
    // Node attempts to enumerate the directory. File contents are never read.
    safeForContent(metadata, { allowProtected: true });
    if (metadata.kind !== 'directory' && metadata.kind !== 'file') {
      throw Object.assign(new Error('SYMLINK_PARENT'), { code: 'SYMLINK_PARENT' });
    }
  }

  async _nativeMetadata(filePath) {
    // macOS exposes standard locations such as /var via a directory symlink.
    // Resolving just the parent under the installed no-materialization policy
    // preserves the scanner's existing explicit-root semantics. Content preview
    // still rejects symlink ancestors and uses its own no-follow traversal.
    const probePath = process.platform === 'darwin'
      ? path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath))
      : filePath;
    try {
      // File-only enumeration can outlive the helper's idle timeout. Renew
      // after the parent lookup so no awaited work separates this check/request.
      if (!this._nativeSession || this._nativeSession.closed) this._nativeSession = createNativeSession();
      return await this._nativeSession.metadata(probePath);
    }
    catch (error) {
      // Preserve the scanner's OS-style error contract while native callers
      // such as preview and cleanup retain their actionable public codes.
      if (error.code === 'MISSING_FILE') error.code = 'ENOENT';
      if (error.code === 'PERMISSION_DENIED') error.code = 'EACCES';
      throw error;
    }
  }

  async _verifyRoot(root) {
    try {
      if (this._nativeSession) this._requireNativeDirectory(await this._nativeMetadata(root.entry.path));
      const current = await fs.lstat(root.rawPath, { bigint: true });
      // A cancellation arriving during this already-started call still owns the terminal state.
      if (this.shouldCancel()) return;
      if (kindOf(current) !== root.identity.kind || current.dev.toString() !== root.identity.dev || current.ino.toString() !== root.identity.ino) {
        throw Object.assign(new Error('Scan root changed during scanning.'), { code: 'ESTALE' });
      }
    } catch (error) {
      if (!this.shouldCancel()) this._recordError(root, error);
    }
  }

  _newRecord(parent, rawPath, name, kind) {
    const id = this._records.length;
    const display = displayPath(rawPath);
    if (display.unsupported) this._coverage.unsupportedNames++;
    const record = {
      rawPath, unsupportedPath: display.unsupported, identity: null,
      ...(this._nativeSession ? { nativeSystemPath: Boolean(parent?.nativeSystemPath) } : {}),
      allocatedKnown: 0, unknownAllocated: 0, partial: false, enumerated: false, pendingDirectories: 0, cacheUnsafe: false,
      entry: {
        id, parentId: parent ? parent.entry.id : null, name, path: display.text, kind,
        ...this._visibility.classify(display.text, name, parent?.entry),
        logicalSize: 0, allocatedSize: 0, fileCount: 0, childCount: 0,
        category: 'other', modifiedAt: 0, state: kind === 'directory' ? 'pending' : 'ready',
      },
    };
    this._records.push(record);
    const previousId = this._pathIds.get(display.text);
    const ambiguous = previousId !== undefined;
    this._pathIds.set(display.text, display.unsupported || ambiguous ? 0 : id);
    if (display.unsupported || ambiguous) {
      this._markCacheUnsafe(record);
      if (previousId) this._markCacheUnsafe(this._records[previousId]);
    }
    this._revision++;
    if (parent) {
      parent.entry.childCount++;
      if (!this._children.has(parent.entry.id)) this._children.set(parent.entry.id, []);
      this._children.get(parent.entry.id).push(id);
    }
    return record;
  }

  _setMetadata(record, stat, parentRealPath, parentStat) {
    const entry = record.entry;
    let flags;
    if (this._nativeSession && record.entry.parentId != null) {
      if (record.unsupportedPath) throw Object.assign(new Error('UNSUPPORTED_PATH'), { code: 'UNSUPPORTED_PATH' });
      flags = getNativePathFlags(entry.path);
      entry.hiddenPath ||= flags.hidden;
      record.nativeSystemPath ||= flags.system;
      entry.systemPath = this._nativeSystemRoot ? false : entry.systemPath || record.nativeSystemPath;
    }
    entry.kind = kindOf(stat);
    entry.modifiedAt = Number(stat.mtimeNs) / 1e6;
    // Share repeated immutable strings without dropping or rounding identity
    // fields. Parent stat values are compared so reused mutable fixtures cannot
    // cause stale identity; the cache retains only the most recent parent.
    let device = this._deviceStrings.get(stat.dev);
    if (device === undefined) {
      device = stat.dev.toString();
      this._deviceStrings.set(stat.dev, device);
    }
    let parentIdentity;
    if (parentStat) {
      if (!this._lastParentIdentity || this._lastParentIdentity.dev !== parentStat.dev || this._lastParentIdentity.ino !== parentStat.ino) {
        this._lastParentIdentity = { dev: parentStat.dev, ino: parentStat.ino,
          fields: { parentDev: parentStat.dev.toString(), parentIno: parentStat.ino.toString() } };
      }
      parentIdentity = this._lastParentIdentity.fields;
    }
    const mtimeNs = stat.mtimeNs.toString();
    const ctimeNs = stat.ctimeNs === stat.mtimeNs ? mtimeNs : stat.ctimeNs.toString();
    record.identity = {
      path: entry.path, dev: device, ino: stat.ino.toString(),
      mode: Number(stat.mode), size: Number(stat.size), nlink: Number(stat.nlink),
      birthtimeMs: Number(stat.birthtimeNs) / 1e6,
      mtimeNs, ctimeNs,
      parentRealPath, kind: entry.kind,
      ...(parentIdentity || {}),
      ...(record.unsupportedPath ? { unsupportedPath: true, rawPathHex: record.rawPath.toString('hex') } : {}),
    };
    if (entry.kind === 'directory') {
      this._directories++;
      entry.state = 'pending';
      return;
    }
    if (entry.kind === 'file' || entry.kind === 'symlink') {
      entry.logicalSize = Number(stat.size);
      entry.allocatedSize = process.platform === 'win32' ? nativeAllocatedBytes(stat, flags) : allocatedBytes(stat);
      if (entry.kind === 'file') {
        entry.fileCount = 1;
        entry.category = EXTENSIONS.get(path.extname(entry.name).slice(1).toLowerCase()) || 'other';
      }
    }
    entry.state = 'ready';
  }

  async _scanDirectory(directory, pending) {
    let handle;
    try {
      if (this._nativeSession) {
        if (directory.unsupportedPath) throw Object.assign(new Error('UNSUPPORTED_PATH'), { code: 'UNSUPPORTED_PATH' });
        const metadata = await this._nativeMetadata(directory.entry.path);
        this._requireNativeDirectory(metadata);
        if (metadata.kind !== 'directory' || metadata.identity.dev !== directory.identity.dev || metadata.identity.ino !== directory.identity.ino) {
          throw Object.assign(new Error('Directory changed during scanning.'), { code: 'ESTALE' });
        }
        if (metadata.volume.mountPath !== this._nativeRoot.volume.mountPath) {
          this._skip(directory, 'Mount boundary; scan this volume separately.', 'mounts');
          directory.enumerated = true;
          this._finishDirectory(directory);
          return;
        }
      }
      const parentRealPath = await fs.realpath(directory.rawPath);
      // Recheck the directory before opening: scanning a changed symlink must not expand scope.
      const current = await fs.lstat(directory.rawPath, { bigint: true });
      if (!current.isDirectory() || current.dev.toString() !== directory.identity.dev || current.ino.toString() !== directory.identity.ino) {
        throw Object.assign(new Error('Directory changed during scanning.'), { code: 'ESTALE' });
      }
      handle = await fs.opendir(directory.rawPath, { encoding: process.platform === 'win32' ? 'utf8' : 'buffer', bufferSize: 64 });
      while (!this.shouldCancel()) {
        const dirent = await handle.read();
        if (!dirent) break;
        const rawPath = childPath(directory.rawPath, dirent.name);
        const name = displayPath(dirent.name).text;
        const record = this._newRecord(directory, rawPath, name, dirent.isDirectory() ? 'directory' : 'other');
        try {
          const stat = await fs.lstat(rawPath, { bigint: true });
          this._setMetadata(record, stat, parentRealPath, current);
          const canonicalPath = record.unsupportedPath ? null : displayPath(childPath(parentRealPath, dirent.name)).text;
          const mountBoundary = canonicalPath != null && this._mountPoints.has(canonicalPath);
          if (stat.dev.toString() !== this._rootDevice || mountBoundary) {
            this._skip(record, 'Mount boundary; scan this volume separately.', 'mounts');
          } else if (record.entry.kind === 'directory') {
            directory.pendingDirectories++;
            pending.push(record);
          } else {
            this._acceptLeaf(record);
          }
        } catch (error) {
          this._recordError(record, error);
        }
        await this._checkpoint();
      }
      directory.enumerated = !this.shouldCancel();
    } catch (error) {
      this._recordError(directory, error);
      directory.enumerated = true;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    this._finishDirectory(directory);
  }

  _acceptLeaf(record) {
    const entry = record.entry;
    if (entry.kind === 'file') this._files++;
    if ((entry.kind === 'file' || entry.kind === 'symlink') && record.identity.nlink > 1) {
      entry.shared = true;
      const key = `${record.identity.dev}:${record.identity.ino}`;
      if (this._hardlinks.has(key)) {
        entry.allocatedSize = 0;
        entry.sharedWith = this._hardlinks.get(key);
      } else {
        this._hardlinks.set(key, entry.id);
      }
    }
    if (entry.kind === 'symlink') {
      this._markCacheUnsafe(record);
      entry.state = 'skipped';
      entry.error = 'Symbolic link; target not scanned.';
      this._skipped++;
      this._coverage.skipped.symbolicLinks++;
    } else if (entry.kind === 'other') {
      this._skip(record, 'Special file; contents not read.', 'specialFiles');
      return;
    }
    const known = entry.allocatedSize ?? 0;
    const unknown = entry.allocatedSize == null ? 1 : 0;
    record.allocatedKnown = known;
    record.unknownAllocated = unknown;
    let parentId = entry.parentId;
    while (parentId != null) {
      const parent = this._records[parentId];
      parent.entry.logicalSize += entry.logicalSize;
      parent.entry.fileCount += entry.fileCount;
      parent.allocatedKnown += known;
      parent.unknownAllocated += unknown;
      parent.entry.allocatedSize = parent.unknownAllocated ? null : parent.allocatedKnown;
      parentId = parent.entry.parentId;
    }
    const category = this._categories.get(entry.category);
    category.bytes += known;
    category.files += entry.fileCount;
  }

  _skip(record, reason, category) {
    record.entry.state = 'skipped';
    record.entry.error = reason;
    record.entry.allocatedSize = null;
    record.entry.fileCount = 0;
    record.partial = true;
    this._skipped++;
    this._coverage.skipped[category]++;
    this._markAncestorsPartial(record);
  }

  _markAncestorsPartial(record) {
    let parentId = record.entry.parentId;
    while (parentId != null) {
      const parent = this._records[parentId];
      parent.partial = true;
      if (parent.entry.state === 'ready') parent.entry.state = 'partial';
      parentId = parent.entry.parentId;
    }
  }

  _markCacheUnsafe(record) {
    // An indexed directory can be ready while containing a link or a display-only name.
    // Preserve existing scan/cleanup semantics; this aggregate only qualifies cache reporting.
    while (record && !record.cacheUnsafe) {
      record.cacheUnsafe = true;
      record = this._records[record.entry.parentId];
    }
  }

  _recordError(record, error) {
    this._errors++;
    record.entry.state = 'error';
    record.entry.allocatedSize = null;
    record.partial = true;
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'SCAN_ERROR';
    // Keep per-entry codes compact; arbitrary OS error strings are bounded separately.
    record.entry.error = code;
    if (this._errorDetails.length < MAX_ERROR_DETAILS) {
      this._errorDetails.push({ id: record.entry.id, code, message: String(error?.message || error).slice(0, 300) });
    }
    this._markAncestorsPartial(record);
  }

  _finishDirectory(record) {
    while (record && record.enumerated && record.pendingDirectories === 0) {
      if (record.entry.state === 'pending') record.entry.state = record.partial ? 'partial' : 'ready';
      record = this._records[record.entry.parentId];
      if (record) record.pendingDirectories--;
    }
  }

  async _loadMounts() {
    if (process.platform !== 'linux') return;
    try {
      this._mounts = parseMountInfo(await fs.readFile('/proc/self/mountinfo', 'utf8'));
      this._mountPoints = new Set(this._mounts.map(mount => mount.path));
      this._coverage.boundaryDetection = this._mounts.length ? 'mount-table' : 'device-only';
    } catch {
      this._message = 'Mount information unavailable; only device boundaries can be detected.';
    }
  }

  async _loadVolume() {
    try {
      this._volumeBaseline = await sampleVolume(this.rootPath, this._records[1]?.identity, this._rootRealPath);
      const { total, free } = this._volumeBaseline.sample;
      this._volume = { total, free };
    } catch {
      this._volume = null;
      this._volumeBaseline = null;
    }
  }

  async measureSpace() {
    if (!['completed', 'cancelled'].includes(this._state)) throw spaceError('SPACE_SCAN_NOT_READY');
    if (this._spaceCheckInFlight) throw spaceError('SPACE_CHECK_IN_PROGRESS');
    this._spaceCheckInFlight = true;
    try {
      const current = await sampleVolume(this.rootPath, this._records[1]?.identity, this._rootRealPath);
      const baseline = this._volumeBaseline;
      const comparison = !baseline ? 'baseline-unavailable'
        : baseline.signature === current.signature ? 'comparable' : 'volume-changed';
      return {
        scanId: this.scanId, rootPath: this.rootPath,
        baseline: baseline ? { ...baseline.sample } : null,
        current: { ...current.sample },
        delta: comparison === 'comparable' ? current.sample.free - baseline.sample.free : null,
        comparison,
      };
    } finally {
      // A request timeout does not cancel filesystem I/O; keep the guard until it settles.
      this._spaceCheckInFlight = false;
    }
  }

  async _checkpoint() {
    this._steps++;
    this._revision++;
    this._notify();
    if (this._steps % 64 === 0) await yieldToEventLoop();
  }

  _notify(force = false) {
    const now = Date.now();
    if (!force && now - this._lastProgress < 120) return;
    this._lastProgress = now;
    try { this.onProgress(this.summary()); } catch { /* A disconnected UI must not abort indexing. */ }
  }

  summary() {
    const root = this._records[1];
    return {
      scanId: this.scanId, rootPath: this.rootPath, rootId: 1, state: this._state,
      files: this._files, directories: this._directories,
      scannedBytes: root?.allocatedKnown || 0, logicalBytes: root?.entry.logicalSize || 0,
      errors: this._errors, skipped: this._skipped, startedAt: this._startedAt,
      elapsedMs: this._startedAt ? (this._finishedAt || Date.now()) - this._startedAt : 0,
      volume: this._volume ? { ...this._volume } : null,
      // Unknown allocations count indexed file/link entries, not unread descendants.
      // Skip counts likewise describe excluded entries, not their unknown subtree sizes.
      coverage: { ...this._coverage, skipped: { ...this._coverage.skipped }, unknownAllocatedEntries: root?.unknownAllocated || 0 },
      visibility: {
        rootIsSystem: Boolean(this._nativeSystemRoot || this._visibility.rootIsSystem),
        hiddenRule: this._nativeRoot ? 'native-and-dot-paths' : 'dot-paths',
        systemRule: this._nativeRoot ? 'native-and-known-paths' : 'known-paths',
      },
      categories: CATEGORIES.map(category => ({ ...this._categories.get(category) })),
      ...(this._message ? { message: this._message } : {}),
      errorDetails: this._errorDetails.map(({ id, code }) => ({ id, code })),
    };
  }

  entry(id) {
    const entry = Number.isInteger(id) ? this._records[id]?.entry : null;
    return entry ? { ...entry } : null;
  }

  entryIdentity(id) {
    const identity = Number.isInteger(id) ? this._records[id]?.identity : null;
    // Keep the exact nanoseconds once internally. Milliseconds are a public
    // convenience field and can be reconstructed without losing precision.
    return identity ? { ...identity, mtimeMs: Number(identity.mtimeNs) / 1e6, ctimeMs: Number(identity.ctimeNs) / 1e6 } : null;
  }

  cacheReport(context) {
    return buildCacheReport(this, context);
  }

  resolvePaths(paths) {
    if (!Array.isArray(paths) || paths.length > MAX_RESOLVE_PATHS) throw Object.assign(new Error('INVALID_PATHS'), { code: 'INVALID_PATHS' });
    // Validate the whole request before returning anything. Iteration also rejects holes.
    for (const value of paths) {
      if (typeof value !== 'string' || !value.length || value.length > MAX_RESOLVE_PATH_LENGTH || value.includes('\0') || !value.isWellFormed() || !path.isAbsolute(value)) {
        throw Object.assign(new Error('INVALID_PATHS'), { code: 'INVALID_PATHS' });
      }
    }
    // Exact string keys deliberately avoid normalization, case folding and filesystem I/O.
    return paths.map(value => this.entry(this._pathIds.get(value)));
  }

  retryTarget(id) {
    const record = Number.isSafeInteger(id) && id > 0 ? this._records[id] : null;
    if (!record || record.entry.state !== 'error') throw Object.assign(new Error('INVALID_RETRY_TARGET'), { code: 'INVALID_RETRY_TARGET' });
    if (record.unsupportedPath) throw Object.assign(new Error('UNSUPPORTED_PATH'), { code: 'UNSUPPORTED_PATH' });
    const target = record.entry.kind === 'directory' ? record : this._records[record.entry.parentId];
    if (target?.unsupportedPath) throw Object.assign(new Error('UNSUPPORTED_PATH'), { code: 'UNSUPPORTED_PATH' });
    if (!target || target.entry.kind !== 'directory' || !path.isAbsolute(target.entry.path) || !containsPath(this.rootPath, target.entry.path)) {
      throw Object.assign(new Error('INVALID_RETRY_TARGET'), { code: 'INVALID_RETRY_TARGET' });
    }
    return target.entry.path;
  }

  cleanupManifest(id) {
    const root = Number.isInteger(id) ? this._records[id] : null;
    if (!root || root.entry.state !== 'ready') return { entries: [], truncated: false };
    const entries = [];
    // Iterators bound memory even when one directory has millions of direct children.
    const stack = [{ ids: [id], offset: 0 }];
    while (stack.length) {
      const frame = stack.at(-1);
      if (frame.offset >= frame.ids.length) { stack.pop(); continue; }
      const nextId = frame.ids[frame.offset++];
      if (entries.length === MAX_CLEANUP_MANIFEST_DESCENDANTS + 1) return { entries, truncated: true };
      const record = this._records[nextId];
      entries.push({ entry: { ...record.entry }, identity: this.entryIdentity(nextId) });
      // Keep unsafe descendants visible to the policy checker; never silently omit them.
      if (record.entry.kind === 'directory') {
        const children = this._children.get(nextId);
        if (children?.length) stack.push({ ids: children, offset: 0 });
      }
    }
    return { entries, truncated: false };
  }

  ancestors(id) {
    const result = [];
    let parentId = this._records[id]?.entry.parentId;
    while (parentId != null) {
      const entry = this.entry(parentId);
      if (!entry) break;
      result.push(entry);
      parentId = entry.parentId;
    }
    return result.reverse();
  }

  query(query = {}) {
    const search = typeof query.search === 'string' ? query.search.trim().toLocaleLowerCase() : '';
    const minSize = Number.isFinite(query.minSize) ? Math.max(0, query.minSize) : 0;
    const sortBy = ['allocatedSize', 'logicalSize', 'name', 'modifiedAt'].includes(query.sortBy) ? query.sortBy : 'allocatedSize';
    const direction = query.sortDirection === 'asc' ? 1 : -1;
    const includeHidden = query.includeHidden !== false;
    const includeSystem = query.includeSystem !== false;
    const reportFilteredCount = typeof query.includeHidden === 'boolean' || typeof query.includeSystem === 'boolean';
    if (this._queryCacheRevision !== this._revision) {
      this._queryCache.clear();
      this._queryCacheRevision = this._revision;
    }
    const key = JSON.stringify([query.parentId ?? null, search, query.category ?? null, query.kind ?? null, minSize, sortBy, direction, includeHidden, includeSystem]);
    const membershipKey = JSON.stringify([query.parentId ?? null, search, query.category ?? null, query.kind ?? null, minSize, includeHidden, includeSystem]);
    const compare = (a, b) => {
        const aValue = a[sortBy];
        const bValue = b[sortBy];
        if (aValue == null || bValue == null) return aValue == null ? bValue == null ? a.id - b.id : 1 : -1;
        const comparison = sortBy === 'name' ? collator.compare(aValue, bValue) : aValue - bValue;
        return comparison * direction || collator.compare(a.name, b.name) || a.id - b.id;
    };
    let cached = this._queryCache.get(key);
    if (!cached) {
      // Sorting does not change membership. Share the existing filtered array
      // instead of traversing the index and allocating it again on each sort.
      const shared = [...this._queryCache.values()].find(item => item.membershipKey === membershipKey);
      const entries = shared?.entries ?? [];
      let filteredCount = shared?.filteredCount ?? 0;
      if (!shared) {
        const ids = query.parentId == null ? null : this._children.get(query.parentId) || [];
        const firstGlobal = this._records[1]?.entry.kind === 'directory' ? 2 : 1;
        const length = ids ? ids.length : this._records.length - firstGlobal;
        for (let index = 0; index < length; index++) {
          const entry = this._records[ids ? ids[index] : index + firstGlobal].entry;
          if ((search && !entry.name.toLocaleLowerCase().includes(search) && !entry.path.toLocaleLowerCase().includes(search)) ||
            (query.category && entry.category !== query.category) ||
            (query.kind && entry.kind !== query.kind) || entry.logicalSize < minSize) continue;
          if ((!includeHidden && entry.hiddenPath) || (!includeSystem && entry.systemPath)) filteredCount++;
          else entries.push(entry);
        }
      }
      // Two result sets are enough for tree/list paging without retaining unbounded arrays.
      if (this._queryCache.size >= 2) this._queryCache.delete(this._queryCache.keys().next().value);
      // Keep small prefixes with their membership, so changing among sort
      // orders does not repeatedly traverse the same candidate array. The
      // normalized API admits only four fields and two directions: at most
      // eight prefixes per membership, each bounded below to 1,000 entries.
      cached = { entries, filteredCount, membershipKey, prefixes: shared?.prefixes ?? new Map() };
      this._queryCache.set(key, cached);
    }
    const { entries, filteredCount } = cached;
    const offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset)) : 0;
    const limit = Number.isFinite(query.limit) ? Math.min(10000, Math.max(0, Math.floor(query.limit))) : 200;
    const wanted = Math.min(entries.length, offset + limit);
    let ordered = entries;
    if (limit > 0 && !cached.sorted) {
      if (wanted <= 1000) {
        const orderKey = `${sortBy}:${direction}`;
        let prefix = cached.prefixes.get(orderKey);
        if (!prefix || prefix.length < wanted) {
          prefix = sortedPrefix(entries, wanted, compare);
          cached.prefixes.set(orderKey, prefix);
        }
        ordered = prefix;
      } else {
        // Larger/deep pages pay for one full sort and all later pages reuse it.
        // Other sort keys may share this array. Their independent prefixes stay
        // valid, but the full-array ordering is no longer theirs after mutation.
        for (const other of this._queryCache.values()) if (other !== cached && other.entries === entries) other.sorted = false;
        entries.sort(compare);
        cached.sorted = true;
      }
    }
    return { entries: limit ? ordered.slice(offset, offset + limit).map(entry => ({ ...entry })) : [], total: entries.length,
      ...(reportFilteredCount ? { filteredCount } : {}) };
  }
}

module.exports = { ScanIndex, parseMountInfo, MAX_CLEANUP_MANIFEST_DESCENDANTS, MAX_RESOLVE_PATHS, MAX_RESOLVE_PATH_LENGTH };
