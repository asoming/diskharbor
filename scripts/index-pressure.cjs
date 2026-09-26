'use strict';

// Execute with Node 22.12+; does not create a million files or scan user paths.
// The retained 1M records use the production scanner's complete record model.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { randomUUID, createHash } = require('node:crypto');
const { ScanIndex } = require('../electron/scanner.cjs');
const { populateSyntheticIndex, percentile } = require('../tests/performance-fixtures.cjs');

const count = 1000000;
const memoryBudgetBytes = 1.5 * 1024 ** 3;
const base = path.resolve(__dirname, '../output', `index-pressure-${randomUUID()}`);
const report = {
  workload: '1M synthetic metadata using full production ScanIndex records',
  count, memoryBudgetBytes, platform: process.platform, arch: process.arch,
  node: process.version, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
  ramBytes: os.totalmem(), startedAt: new Date().toISOString(),
  samples: [], queries: [], errors: [],
  limitation: 'Core process only; the separate Electron benchmark includes renderer and application processes. Not a real 1M-file scan.',
};
const sample = phase => report.samples.push({ phase, ...process.memoryUsage(), peakRSS: process.resourceUsage().maxRSS * 1024 });
(async () => {
  await fs.mkdir(base, { recursive: true });
  report.scannerSHA256 = createHash('sha256').update(await fs.readFile(path.resolve(__dirname, '../electron/scanner.cjs'))).digest('hex');
  sample('empty');
  const index = new ScanIndex(path.join(base, 'synthetic-index'));
  const started = performance.now();
  const summary = await populateSyntheticIndex(index, count, current => {
    if (current._files % 100000 === 0) sample(`indexed-${current._files}`);
  });
  report.buildMs = performance.now() - started;
  assert.equal(summary.files, count);
  assert.equal(index._records.length, count + 2);
  const timings = [];
  for (const sortBy of ['name', 'allocatedSize', 'logicalSize', 'modifiedAt']) {
    for (const sortDirection of ['asc', 'desc']) {
      const start = performance.now();
      const result = index.query({ parentId: summary.rootId, sortBy, sortDirection, limit: 100, includeHidden: false, includeSystem: false });
      const elapsedMs = performance.now() - start;
      assert.equal(result.total, count);
      assert.equal(result.entries.length, 100);
      assert.equal(result.filteredCount, 0);
      const lastStart = performance.now();
      const last = index.query({ parentId: summary.rootId, sortBy, sortDirection, offset: count - 1, limit: 100, includeHidden: false, includeSystem: false });
      const lastPageMs = performance.now() - lastStart;
      assert.equal(last.entries.length, 1);
      timings.push(elapsedMs);
      report.queries.push({ sortBy, sortDirection, coldMs: elapsedMs, lastPageMs, total: result.total, lastId: last.entries[0].id });
      sample(`query-${sortBy}-${sortDirection}`);
    }
  }
  report.queryP95Ms = percentile(timings, .95);
  report.queryTimingScope = 'cold first 100 entries; last-page timings separately include full-order completion';
  report.lastPageP95Ms = percentile(report.queries.map(item => item.lastPageMs), .95);
  report.retainedFiles = index.summary().files;
  report.retainedRecords = index._records.length;
  report.peakRSSBytes = process.resourceUsage().maxRSS * 1024;
  report.memoryPassed = report.peakRSSBytes <= memoryBudgetBytes;
  report.result = report.memoryPassed ? 'passed-core-budget' : 'failed-core-budget';
})().catch(error => {
  report.result = 'failed'; report.errors.push(String(error.stack || error));
}).finally(async () => {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(base, 'report.json'), result: report.result, count: report.retainedFiles, buildMs: report.buildMs, peakRSSBytes: report.peakRSSBytes, queryP95Ms: report.queryP95Ms, errors: report.errors }, null, 2));
  process.exitCode = report.result === 'passed-core-budget' ? 0 : 1;
});
