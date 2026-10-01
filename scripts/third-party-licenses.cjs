'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const sections = ['DiskHarbor third-party notices\n\nApplication code: see LICENSE (MIT).\nDependency licenses below apply to their respective components.\nElectron and Chromium notices are distributed separately with the desktop runtime.'];
for (const [location, entry] of Object.entries(lock.packages).filter(([location, entry]) => location && !entry.dev).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  const directory = path.resolve(root, location);
  if (!directory.startsWith(path.join(root, 'node_modules') + path.sep)) throw new Error('Unexpected dependency location');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.version !== entry.version) throw new Error(`Installed version differs from lockfile: ${location}`);
  const licenses = fs.readdirSync(directory).filter(name => /^(licen[sc]e|notice)(\.|$)/i.test(name)).sort();
  if (!licenses.length) throw new Error(`Missing license text: ${location}`);
  sections.push(`${manifest.name}@${entry.version} (${entry.license || manifest.license || 'see text'})\n\n` + licenses.map(name => `${name}\n${fs.readFileSync(path.join(directory, name), 'utf8').replace(/\r\n?/g, '\n').trim()}`).join('\n\n'));
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_LICENSES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
console.log(`Collected ${sections.length - 1} production dependency license notices.`);
