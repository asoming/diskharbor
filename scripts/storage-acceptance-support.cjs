'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

function blocked(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: 'STORAGE_ACCEPTANCE_BLOCKED' });
}

async function prerequisites({ platform = process.platform, env = process.env, run = execute } = {}) {
  if (platform !== 'linux') throw blocked('Storage acceptance requires Linux; no acceptance checks ran.');
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw blocked('A Linux display session is required for Electron native Trash acceptance.');
  const binaries = [
    ['gio', ['version']], ['gdbus', ['help']], ['dbus-run-session', ['--version']],
    ['mount', ['--version']], ['umount', ['--version']],
    ['/usr/bin/python3', ['-c', 'from gi.repository import Gio']],
    ['unshare', ['--user', '--map-root-user', '--mount', process.execPath, '-e', 'process.exit(0)']],
  ];
  for (const [binary, args] of binaries) {
    try { await run(binary, args, { timeout: 10000, maxBuffer: 65536, shell: false }); }
    catch (cause) { throw blocked(`Required capability unavailable: ${binary}. No acceptance checks ran.`, cause); }
  }
  if (!['/usr/libexec/gvfsd', '/usr/lib/gvfs/gvfsd'].some(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  })) throw blocked('gvfsd is unavailable; install gvfs-daemons before acceptance.');
}

function fixtureIdentity(fixture) {
  const stat = fs.lstatSync(fixture, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(fixture) !== fixture
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o777n) !== 0o700n) {
    throw new Error('Owned fixture directory identity/permissions could not be verified.');
  }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

async function sourceSnapshot(project) {
  const git = async args => (await execute('git', args, { cwd: project, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
  const files = ['package.json', 'package-lock.json', ...fs.readdirSync(path.join(project, 'electron')).filter(name => name.endsWith('.cjs')).map(name => `electron/${name}`)];
  for (const folder of ['scripts', 'tests']) files.push(...fs.readdirSync(path.join(project, folder))
    .filter(name => name.startsWith('storage-acceptance')).map(name => `${folder}/${name}`));
  const nativeRoot = path.join(project, 'electron', 'native');
  const nativeExists = fs.existsSync(nativeRoot);
  function appendNative(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Native fingerprint input must not be a symlink.');
      if (entry.isDirectory()) appendNative(file);
      else if (entry.isFile()) files.push(path.relative(project, file).split(path.sep).join('/'));
    }
  }
  if (nativeExists) appendNative(nativeRoot);
  const fingerprints = Object.fromEntries(files.sort().map(file => {
    const target = path.join(project, file);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Fingerprint input is not a regular file: ${file}`);
    return [file, { sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'), bytes: stat.size }];
  }));
  const status = (await git(['status', '--porcelain=v1'])).trimEnd();
  return { capturedAt: new Date().toISOString(), capturePhase: 'before acceptance checks',
    head: (await git(['rev-parse', 'HEAD'])).trim(), dirty: Boolean(status), status: status ? status.split('\n') : [],
    trackedElectronDiffAgainstHeadEmpty: !(await git(['diff', 'HEAD', '--', 'electron'])),
    nativeDirectoryPresent: nativeExists, files: fingerprints };
}

module.exports = { blocked, prerequisites, fixtureIdentity, sourceSnapshot };
