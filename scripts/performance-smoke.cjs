'use strict';

// Run after npm run build. Uses only generated files under work/performance-*.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const project = path.resolve(__dirname, '..');
const id = randomUUID();
const base = path.join(project, 'output', `performance-smoke-${id}`);
const fixture = path.resolve(project, '../../work', `performance-${id}`);
(async () => {
  await fs.mkdir(base, { recursive: true });
  const realRoot = path.join(fixture, 'real-100k');
  await fs.mkdir(realRoot, { recursive: true });
  const started = Date.now();
  let next = 0;
  await Promise.all(Array.from({ length: 64 }, async () => {
    while (next < 100000) {
      const number = next++;
      await fs.writeFile(path.join(realRoot, `file-${String(number).padStart(6, '0')}.txt`), '');
    }
  }));
  const branch = path.join(realRoot, '000-branch');
  await fs.mkdir(branch);
  await Promise.all(Array.from({ length: 128 }, (_, index) => fs.writeFile(path.join(branch, `nested-${String(index).padStart(3, '0')}.txt`), `Fixture ${index}\n`)));
  let deep = path.join(realRoot, '001-deep');
  for (let level = 0; level < 80; level++) { await fs.mkdir(deep, { recursive: true }); deep = path.join(deep, `d${level}`); }
  await fs.mkdir(deep); await fs.writeFile(path.join(deep, 'leaf.txt'), 'Deep fixture\n');
  await fs.mkdir(path.join(fixture, 'synthetic-million'));
  await fs.writeFile(path.join(base, 'fixture.json'), JSON.stringify({ fixture, realRoot, sameLevelFiles: 100000, totalFiles: 100129, maxDepth: 82, zeroByteSiblings: true, creationMs: Date.now() - started, cache: 'warm filesystem metadata after fixture creation; no OS cache flush', cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, ramBytes: os.totalmem() }, null, 2));
  console.log(`Performance fixture ready: ${fixture}`);
  if (process.env.DISKHARBOR_PERFORMANCE_PREPARE_ONLY === '1') { console.log(JSON.stringify({ base, fixture })); return; }
  const env = { ...process.env, DISKHARBOR_PERFORMANCE_SMOKE_DIR: base, DISKHARBOR_PERFORMANCE_FIXTURE_DIR: fixture, XDG_DATA_HOME: path.join(base, 'xdg-data') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.DISKHARBOR_DEV_URL;
  const child = spawn(require('electron'), [path.join(project, 'tests/performance-smoke.cjs')], { cwd: project, env, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
})().catch(error => { console.error(error); process.exitCode = 1; });
