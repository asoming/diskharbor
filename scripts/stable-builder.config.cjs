'use strict';

const path = require('node:path');
const { assertPreflight } = require('./release-preflight.cjs');
const root = path.resolve(__dirname, '..');
assertPreflight(root);
const base = require('../package.json').build;

// Dedicated opt-in configuration; the unsigned preview configuration is unchanged.
module.exports = {
  ...base,
  publish: null,
  forceCodeSigning: true,
  artifactName: 'DiskHarbor-${version}-${os}-${arch}.${ext}',
  directories: { ...base.directories, output: `release/stable-build/${process.platform}-${process.arch}` },
  win: {
    ...base.win,
    forceCodeSigning: true,
    requestedExecutionLevel: 'asInvoker',
    signAndEditExecutable: true,
    signExecutable: true,
    signExts: ['.exe', '.dll', '.node'],
    signtoolOptions: { signingHashAlgorithms: ['sha256'] },
  },
  mac: {
    ...base.mac,
    forceCodeSigning: true,
    type: 'distribution',
    hardenedRuntime: true,
    notarize: true,
    binaries: [
      `Contents/Resources/app.asar.unpacked/electron/native/darwin-${process.arch}/file-probe`,
      `Contents/Resources/app.asar.unpacked/electron/native/darwin-${process.arch}/file-policy.node`,
    ],
  },
  dmg: { ...base.dmg, sign: true },
};
