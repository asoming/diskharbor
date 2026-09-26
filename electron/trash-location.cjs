'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');

const runFile = promisify(execFile);
const MAX_TIMEOUT_MS = 10000;

function timeout(promise, milliseconds, abort) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      abort?.();
      reject(Object.assign(new Error('TRASH_OPEN_TIMEOUT'), { code: 'TRASH_OPEN_TIMEOUT' }));
    }, milliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// Only fixed system Trash targets are accepted. This helper neither restores
// files nor empties the Trash, and it never evaluates a shell command string.
async function openSystemTrash({ platform = process.platform, home = os.homedir(), shell, run = runFile, timeoutMs = MAX_TIMEOUT_MS } = {}) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  async function command(executable, args, attemptBudget = budget) {
    const remaining = Math.min(attemptBudget, deadline - Date.now());
    if (remaining <= 0) throw new Error('TRASH_OPEN_TIMEOUT');
    const controller = new AbortController();
    const operation = run(executable, args, { shell: false, windowsHide: true, timeout: remaining, killSignal: 'SIGTERM', maxBuffer: 65536, signal: controller.signal });
    // Abort only the child launched by this call; never kill a system-wide
    // file-manager process or search for processes by name.
    return timeout(operation, remaining, () => controller.abort());
  }

  try {
    if (platform === 'linux') {
      try { await command('gio', ['open', 'trash:///'], Math.min(5000, budget)); }
      catch { await command('xdg-open', ['trash:///']); }
      return;
    }
    if (platform === 'darwin') {
      if (!shell || typeof shell.openPath !== 'function' || typeof home !== 'string' || !path.posix.isAbsolute(home) || home.includes('\0')) throw new Error('TRASH_LOCATION_UNAVAILABLE');
      const errorMessage = await timeout(shell.openPath(path.posix.join(home, '.Trash')), budget);
      if (errorMessage !== '') throw new Error('TRASH_LOCATION_UNAVAILABLE');
      return;
    }
    if (platform === 'win32') {
      try { await command('explorer.exe', ['shell:RecycleBinFolder']); }
      catch (error) {
        // Explorer may hand the request to an existing instance and exit 1.
        // This means launch was attempted, not that restoration was performed.
        if (error.code !== 1 || error.killed || error.signal) throw error;
      }
      return;
    }
    throw new Error('UNSUPPORTED_PLATFORM');
  } catch (cause) {
    throw Object.assign(new Error('TRASH_OPEN_FAILED', { cause }), { code: 'TRASH_OPEN_FAILED' });
  }
}

module.exports = { openSystemTrash, MAX_TIMEOUT_MS };
