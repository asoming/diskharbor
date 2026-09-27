'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

function requireHostedCI(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.DISKHARBOR_RELEASE_VALIDATION !== '1' || !env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) {
    throw new Error('HOSTED_CI_REQUIRED: installation and real default-profile validation only run on an explicitly enabled disposable GitHub-hosted runner.');
  }
}
function ownedChild(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('OUTSIDE_OWNED_DIRECTORY');
  return path.resolve(target);
}
async function workspace(kind) {
  requireHostedCI();
  const root = path.join(process.env.RUNNER_TEMP, `diskharbor-${kind}-${randomUUID()}`);
  await fs.mkdir(root, { recursive: false });
  await fs.writeFile(path.join(root, 'validation-owner.json'), JSON.stringify({ kind, run: process.env.GITHUB_RUN_ID, repository: process.env.GITHUB_REPOSITORY }));
  return root;
}
function run(executable, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, ...options, timeout: undefined });
    let stdout = ''; let stderr = ''; let settled = false;
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code: child.exitCode, signal: child.signalCode, stdout, stderr };
      // A descendant may retain these pipes after the direct child has exited.
      // Killing that child alone cannot close them or settle this operation.
      try { child.kill(); } catch { /* The timeout still rejects if stopping the child fails. */ }
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      child.unref();
      reject(Object.assign(new Error(`${path.basename(executable)} timed out waiting for process and output completion.`), { code: 'ETIMEDOUT', result }));
    }, options.timeout ?? 180000);
    child.once('error', error => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    });
    // exit does not guarantee that piped stdout/stderr have drained. Commands
    // such as git rev-parse must be checked only after their stdio has closed.
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr };
      if (code === 0 || options.allowFailure) resolve(result);
      else reject(Object.assign(new Error(`${path.basename(executable)} exited ${code ?? signal}: ${stderr.slice(-5000) || stdout.slice(-5000)}`), { result }));
    });
  });
}
async function waitFor(description, read, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${description}`);
}
async function exists(target) { try { await fs.lstat(target); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function sha256(target) {
  const hash = createHash('sha256');
  for await (const chunk of fsSync.createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(url, destination, allowedHosts) {
  let next = url;
  for (let redirects = 0; redirects < 8; redirects++) {
    const parsed = new URL(next);
    if (parsed.protocol !== 'https:' || !allowedHosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) throw new Error('UNTRUSTED_DOWNLOAD_HOST');
    const response = await fetch(next, { redirect: 'manual', signal: AbortSignal.timeout(180000), headers: { 'User-Agent': 'DiskHarbor-release-validation' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) { next = new URL(response.headers.get('location'), next).href; await response.body?.cancel(); continue; }
    if (!response.ok || !response.body) throw new Error(`DOWNLOAD_FAILED_${response.status}`);
    const { pipeline } = require('node:stream/promises');
    await pipeline(require('node:stream').Readable.fromWeb(response.body), fsSync.createWriteStream(destination, { flags: 'wx' }));
    return { requestedURL: url, finalURL: next, sha256: await sha256(destination), bytes: (await fs.stat(destination)).size };
  }
  throw new Error('TOO_MANY_DOWNLOAD_REDIRECTS');
}
function firefoxProfileRoots(platform, home, env = process.env) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    if (!api.isAbsolute(env.APPDATA || '') || !api.isAbsolute(env.LOCALAPPDATA || '')) throw new Error('DEFAULT_PROFILE_ROOT_UNAVAILABLE');
    return { root: api.join(env.APPDATA, 'Mozilla', 'Firefox', 'Profiles'), local: api.join(env.LOCALAPPDATA, 'Mozilla', 'Firefox', 'Profiles') };
  }
  if (platform === 'darwin') return { root: api.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles'), local: api.join(home, 'Library', 'Caches', 'Firefox', 'Profiles') };
  if (platform === 'linux') return { root: api.join(home, '.mozilla', 'firefox'), local: api.join(env.XDG_CACHE_HOME && api.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : api.join(home, '.cache'), 'mozilla', 'firefox') };
  throw new Error('UNSUPPORTED_PLATFORM');
}
module.exports = { requireHostedCI, ownedChild, workspace, run, waitFor, exists, sha256, download, firefoxProfileRoots };
