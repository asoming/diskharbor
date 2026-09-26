'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_RECORDS = 50;
const MAX_ITEMS = 500;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const STATES = new Set(['running', 'completed', 'cancelled', 'interrupted']);
const ITEM_STATES = new Set(['pending', 'processing', 'trashed', 'failed', 'skipped', 'cancelled', 'unknown']);
const KINDS = new Set(['file', 'directory', 'symlink', 'other']);
const SPACE_STATES = new Set(['pending', 'comparable', 'unavailable', 'root-changed', 'volume-changed', 'not-run', 'interrupted']);

function historyError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function safeSpaceMeasurement(value, delta) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !SPACE_STATES.has(value.status)) return null;
  const validSample = sample => sample && typeof sample === 'object' && !Array.isArray(sample) &&
    Number.isSafeInteger(sample.measuredAt) && sample.measuredAt >= 0 &&
    Number.isSafeInteger(sample.total) && sample.total > 0 &&
    Number.isSafeInteger(sample.free) && sample.free >= 0 && sample.free <= sample.total;
  if ((value.before !== null && !validSample(value.before)) || (value.after !== null && !validSample(value.after))) return null;
  const { before, after, status } = value;
  if (status === 'comparable') {
    if (!before || !after || before.total !== after.total || delta !== after.free - before.free) return null;
  } else {
    if (delta !== null) return null;
    if (['pending', 'not-run', 'interrupted'].includes(status) && after !== null) return null;
    if (status === 'not-run' && before !== null) return null;
    if (status === 'volume-changed' && (!before || !after)) return null;
    if (['unavailable', 'root-changed'].includes(status) && before !== null && after !== null) return null;
  }
  const copySample = sample => sample ? { measuredAt: sample.measuredAt, total: sample.total, free: sample.free } : null;
  return { version: 1, before: copySample(before), after: copySample(after), status };
}

function safeHistoryItem(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id || value.id.length > 100 || typeof value.rootPath !== 'string' || value.rootPath.length > 32768 || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) return null;
  if (!Number.isFinite(value.time) || value.time < 0 || !Number.isSafeInteger(value.success) || value.success < 0 || !Number.isSafeInteger(value.failed) || value.failed < 0) return null;
  const items = [];
  for (const item of value.items) {
    if (!item || typeof item.path !== 'string' || item.path.length > 32768 || !ITEM_STATES.has(item.status)) return null;
    if (item.kind !== undefined && !KINDS.has(item.kind)) return null;
    if (item.size !== undefined && (!Number.isFinite(item.size) || item.size < 0)) return null;
    if (item.error !== undefined && (typeof item.error !== 'string' || item.error.length > 4096)) return null;
    items.push({
      path: item.path, status: item.status,
      ...(item.kind !== undefined ? { kind: item.kind } : {}),
      ...(item.size !== undefined ? { size: item.size } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    });
  }
  // Alpha.1 stored terminal records without an operation state.
  const inferredState = items.some((item) => item.status === 'pending' || item.status === 'processing')
    ? 'running' : items.length && items.every((item) => item.status === 'cancelled') ? 'cancelled' : 'completed';
  const state = value.state ?? inferredState;
  if (!STATES.has(state)) return null;
  if (value.planId !== undefined && (typeof value.planId !== 'string' || value.planId.length > 100)) return null;
  if (value.totalBytes !== undefined && (!Number.isFinite(value.totalBytes) || value.totalBytes < 0)) return null;
  for (const key of ['total', 'skipped', 'cancelled']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  if (value.finishedAt !== undefined && (!Number.isFinite(value.finishedAt) || value.finishedAt < 0)) return null;
  if (value.freeSpaceDelta !== undefined && value.freeSpaceDelta !== null && !Number.isFinite(value.freeSpaceDelta)) return null;
  // A malformed new measurement is corruption, not an invitation to reinterpret
  // the record as legacy history. Absence alone retains the old schema.
  const hasSpaceMeasurement = 'spaceMeasurement' in value;
  const spaceMeasurement = hasSpaceMeasurement ? safeSpaceMeasurement(value.spaceMeasurement, value.freeSpaceDelta) : undefined;
  if (hasSpaceMeasurement && !spaceMeasurement) return null;
  if (value.historyError !== undefined && (typeof value.historyError !== 'string' || value.historyError.length > 500)) return null;
  const totalBytes = value.totalBytes ?? items.reduce((sum, item) => sum + (item.size || 0), 0);
  if (!Number.isFinite(totalBytes) || totalBytes < 0) return null;
  return {
    id: value.id, time: value.time, rootPath: value.rootPath, state,
    success: value.success, failed: value.failed, items,
    skipped: value.skipped ?? items.filter((item) => item.status === 'skipped').length,
    cancelled: value.cancelled ?? items.filter((item) => item.status === 'cancelled').length,
    total: value.total ?? items.length,
    totalBytes,
    freeSpaceDelta: value.freeSpaceDelta ?? null,
    ...(spaceMeasurement ? { spaceMeasurement } : {}),
    ...(value.planId !== undefined ? { planId: value.planId } : {}),
    ...(value.finishedAt !== undefined ? { finishedAt: value.finishedAt } : {}),
    ...(value.historyError !== undefined ? { historyError: value.historyError } : {}),
  };
}

function recoverInterrupted(record) {
  if (record.state !== 'running') return record;
  const items = record.items.map((item) => {
    if (item.status === 'pending') return { ...item, status: 'cancelled', error: 'APP_INTERRUPTED' };
    if (item.status === 'processing') return { ...item, status: 'unknown', error: 'RESULT_UNCERTAIN' };
    return item;
  });
  return {
    ...record, state: 'interrupted', items,
    success: items.filter((item) => item.status === 'trashed').length,
    failed: items.filter((item) => item.status === 'failed').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length,
    // The final measurement was never completed; do not infer it from paths.
    freeSpaceDelta: null,
    ...(record.spaceMeasurement ? {
      spaceMeasurement: {
        version: 1, before: record.spaceMeasurement.before ? { ...record.spaceMeasurement.before } : null,
        after: null, status: 'interrupted',
      },
    } : {}),
  };
}

function createHistoryStore(filePath, { io = fs } = {}) {
  let queue = Promise.resolve();
  let records;

  async function write(next) {
    const serialized = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(serialized) > MAX_HISTORY_BYTES) {
      records = undefined;
      throw historyError('HISTORY_TOO_LARGE');
    }
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      await io.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      handle = await io.open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      handle = null;
      await io.rename(temporary, filePath);
      records = next;
    } catch (error) {
      // The operation must stop after a journal failure. Reload its last
      // persisted checkpoint on the next access instead of displaying a
      // cached running state as though work were still progressing.
      records = undefined;
      throw historyError('HISTORY_WRITE_FAILED', error);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await io.unlink(temporary).catch(() => {});
    }
  }

  async function read() {
    if (records !== undefined) return records;
    let serialized;
    try {
      const stat = await io.stat(filePath);
      if (stat.size > MAX_HISTORY_BYTES) throw historyError('HISTORY_TOO_LARGE');
      serialized = await io.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') { records = []; return records; }
      if (error.code === 'HISTORY_TOO_LARGE') throw error;
      throw historyError('HISTORY_READ_FAILED', error);
    }
    let data;
    try { data = JSON.parse(serialized); }
    catch (error) { throw historyError('HISTORY_CORRUPT', error); }
    if (!Array.isArray(data) || data.length > MAX_RECORDS) throw historyError('HISTORY_CORRUPT');
    const parsed = data.map(safeHistoryItem);
    if (parsed.some((item) => !item) || new Set(parsed.map((item) => item.id)).size !== parsed.length) throw historyError('HISTORY_CORRUPT');
    if (parsed.some((record) => record.state === 'running')) {
      // Cold recovery only uses persisted states. It never inspects file paths,
      // invokes native trash, or automatically resumes interrupted operations.
      await write(parsed.map(recoverInterrupted));
    } else records = parsed;
    return records;
  }

  function enqueue(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }

  function upsert(item) {
    // Snapshot at the call boundary, before it can be mutated by the caller.
    const clean = safeHistoryItem(item);
    if (!clean) return Promise.reject(historyError('INVALID_HISTORY_ITEM'));
    return enqueue(async () => {
      const previous = await read();
      await write([clean, ...previous.filter((record) => record.id !== clean.id)].slice(0, MAX_RECORDS));
    });
  }

  return {
    list: () => enqueue(async () => structuredClone(await read())),
    upsert,
    append: upsert,
    // An explicit user clear may reset even a corrupted existing history.
    clear: () => enqueue(() => write([])),
  };
}

module.exports = { createHistoryStore, safeHistoryItem, MAX_HISTORY_BYTES };
