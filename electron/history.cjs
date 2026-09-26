'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function safeHistoryItem(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.rootPath !== 'string' || !Array.isArray(value.items)) return null;
  return {
    id: value.id.slice(0, 100), time: Number.isFinite(value.time) ? value.time : 0,
    rootPath: value.rootPath.slice(0, 32768),
    success: Number.isSafeInteger(value.success) && value.success >= 0 ? value.success : 0,
    failed: Number.isSafeInteger(value.failed) && value.failed >= 0 ? value.failed : 0,
    items: value.items.slice(0, 500).filter((item) => item && typeof item.path === 'string' && typeof item.status === 'string').map((item) => ({
      path: item.path.slice(0, 32768), status: item.status.slice(0, 40),
      ...(typeof item.error === 'string' ? { error: item.error.slice(0, 500) } : {}),
    })),
    freeSpaceDelta: Number.isFinite(value.freeSpaceDelta) ? value.freeSpaceDelta : null,
    ...(typeof value.historyError === 'string' ? { historyError: value.historyError } : {}),
  };
}

function createHistoryStore(filePath) {
  let queue = Promise.resolve();
  let records;
  async function read() {
    if (records) return records;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 8 * 1024 * 1024) throw new Error('HISTORY_TOO_LARGE');
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!Array.isArray(data)) throw new Error('INVALID_HISTORY');
      records = data.map(safeHistoryItem).filter(Boolean).slice(0, 50);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Corrupt files are not interpreted as operations or automatically executed.
        // A subsequent user operation may replace them with a valid local history.
      }
      records = [];
    }
    return records;
  }
  async function write(next) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next, null, 2));
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, filePath);
      records = next;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }
  function enqueue(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }
  return {
    list: () => enqueue(async () => (await read()).map((item) => structuredClone(item))),
    append: (item) => enqueue(async () => {
      const clean = safeHistoryItem(item);
      if (!clean) throw new Error('INVALID_HISTORY_ITEM');
      await write([clean, ...(await read())].slice(0, 50));
    }),
    clear: () => enqueue(() => write([])),
  };
}

module.exports = { createHistoryStore, safeHistoryItem };
