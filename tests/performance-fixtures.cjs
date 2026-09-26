'use strict';

// Test-only synthetic metadata. Production ScanIndex record creation, metadata
// normalization, aggregate propagation, path maps and public queries are used.
// No filesystem hook or reduced record model is installed in the application.
const path = require('node:path');
const { setImmediate: yieldToLoop } = require('node:timers/promises');

function fixtureStat(number, directory = false) {
  const size = BigInt(directory ? 0 : 1024 + number % 65536);
  return {
    dev: 42n, ino: BigInt(number + 1), mode: directory ? 16877n : 33188n,
    size, blocks: directory ? 0n : (size + 4095n) / 4096n * 8n, nlink: 1n,
    mtimeNs: 1760000000000000000n + BigInt(number) * 1000000n,
    ctimeNs: 1760000000000000000n + BigInt(number) * 1000000n,
    birthtimeNs: 1750000000000000000n,
    isDirectory: () => directory, isFile: () => !directory,
    isSymbolicLink: () => false,
  };
}

async function populateSyntheticIndex(index, count, onChunk = () => {}) {
  index._state = 'scanning';
  index._startedAt = Date.now();
  const root = index._newRecord(null, index.rootPath, path.basename(index.rootPath), 'directory');
  const rootStat = fixtureStat(0, true);
  index._setMetadata(root, rootStat, path.dirname(index.rootPath), rootStat);
  index._rootDevice = '42';
  index._rootRealPath = index.rootPath;
  root.identity.realPath = index.rootPath;
  for (let offset = 0; offset < count; offset += 5000) {
    for (let number = offset; number < Math.min(count, offset + 5000); number++) {
      // The permutation makes sorting exercise actual ordering, not sorted input.
      const permutation = Math.imul(number, 2654435761) >>> 0;
      const name = `file-${permutation.toString(16).padStart(8, '0')}-${String(number).padStart(7, '0')}.txt`;
      const record = index._newRecord(root, path.join(index.rootPath, name), name, 'file');
      index._setMetadata(record, fixtureStat(number + 1), index.rootPath, rootStat);
      index._acceptLeaf(record);
    }
    onChunk(index);
    index._notify();
    await yieldToLoop();
  }
  root.enumerated = true;
  index._finishDirectory(root);
  index._state = 'completed';
  index._finishedAt = Date.now();
  index._revision++;
  index._notify(true);
  return index.summary();
}

function percentile(samples, fraction) {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}
module.exports = { populateSyntheticIndex, percentile, fixtureStat };
