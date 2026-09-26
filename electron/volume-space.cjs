'use strict';

const fs = require('node:fs/promises');

function spaceError(code) {
  return Object.assign(new Error(code), { code });
}

// This brackets a path-based metadata sample. It is not an atomic volume snapshot,
// and cannot detect a replacement that is restored between the checks.
async function sampleVolume(rootPath, identity, realPath) {
  if (!identity || identity.kind !== 'directory' || identity.unsupportedPath || typeof realPath !== 'string') {
    throw spaceError('SPACE_ROOT_CHANGED');
  }
  const verifyRoot = async () => {
    let stat;
    let currentRealPath;
    try {
      stat = await fs.lstat(rootPath, { bigint: true });
      currentRealPath = await fs.realpath(rootPath);
    } catch {
      throw spaceError('SPACE_ROOT_CHANGED');
    }
    if (!stat.isDirectory() || stat.dev.toString() !== identity.dev || stat.ino.toString() !== identity.ino || currentRealPath !== realPath) {
      throw spaceError('SPACE_ROOT_CHANGED');
    }
  };

  await verifyRoot();
  let stat;
  try { stat = await fs.statfs(rootPath, { bigint: true }); }
  catch { throw spaceError('SPACE_UNAVAILABLE'); }
  const measuredAt = Date.now();
  await verifyRoot();
  if (!stat || !['type', 'bsize', 'blocks', 'bavail'].every(key => typeof stat[key] === 'bigint') ||
      stat.bsize <= 0n || stat.blocks <= 0n || stat.bavail < 0n || stat.bavail > stat.blocks) {
    throw spaceError('SPACE_UNAVAILABLE');
  }
  const total = Number(stat.blocks * stat.bsize);
  const free = Number(stat.bavail * stat.bsize);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(free)) throw spaceError('SPACE_UNAVAILABLE');
  return {
    sample: { measuredAt, total, free },
    signature: `${stat.type}:${stat.bsize}:${total}`,
  };
}

module.exports = { sampleVolume, spaceError };
