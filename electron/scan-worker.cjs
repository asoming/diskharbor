'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { ScanIndex } = require('./scanner.cjs');

const cancellation = new Int32Array(workerData.cancelBuffer);
const index = new ScanIndex(workerData.rootPath, {
  scanId: workerData.scanId,
  shouldCancel: () => Atomics.load(cancellation, 0) !== 0,
  onProgress: (summary) => parentPort.postMessage({ type: 'progress', summary }),
});

const queries = new Set(['summary', 'query', 'entry', 'ancestors', 'entryIdentity', 'cleanupManifest']);
parentPort.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'cancel') { Atomics.store(cancellation, 0, 1); return; }
  if (message.type !== 'request' || typeof message.id !== 'string' || !queries.has(message.method)) return;
  try {
    const result = await index[message.method](message.argument);
    parentPort.postMessage({ type: 'response', id: message.id, result });
  } catch (error) {
    parentPort.postMessage({ type: 'response', id: message.id, error: String(error?.message || 'SCAN_QUERY_FAILED').slice(0, 500) });
  }
});

async function run() {
  try {
    const scanning = index.scan();
    parentPort.postMessage({ type: 'ready', summary: index.summary() });
    const summary = await scanning;
    parentPort.postMessage({ type: 'progress', summary: summary || index.summary() });
  } catch (error) {
    const summary = { ...index.summary(), state: 'error', message: String(error?.message || 'SCAN_FAILED').slice(0, 500) };
    parentPort.postMessage({ type: 'ready', summary });
    parentPort.postMessage({ type: 'progress', summary });
  }
}

run();
