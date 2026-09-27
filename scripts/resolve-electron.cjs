'use strict';

// Resolve the development runtime before creating fixtures or starting tests.
// Network retries apply only to installation, never to a benchmark or its data.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const verify = "const fs = require('node:fs'); const executable = require('electron'); if (!fs.statSync(executable).isFile()) throw new Error('Electron executable is missing'); console.log(executable);";
for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`Resolve Electron runtime: attempt ${attempt}/3`);
  const result = spawnSync(process.execPath, ['-e', verify], {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit', timeout: 180000,
  });
  if (result.status === 0) process.exit(0);
  if (result.error) console.error(result.error.message);
}
console.error('Electron runtime setup failed before tests started.');
process.exitCode = 1;
