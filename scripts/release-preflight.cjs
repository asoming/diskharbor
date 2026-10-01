'use strict';

// Presence checks only: never decode certificates or print credential values.
// This is the signing/build gate. Product acceptance is a separate release gate.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLATFORMS = ['linux', 'win32', 'darwin'];
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const REQUIRED = {
  win32: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'EXPECTED_WINDOWS_CERT_SHA256'],
  darwin: ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  linux: [],
};

function preflight({ env, metadata, platform = 'all', actualSha, dirty = false }) {
  const missing = [];
  const invalid = [];
  const present = name => typeof env[name] === 'string' && env[name].length > 0;
  const platforms = platform === 'all' ? PLATFORMS : [platform];
  if (!platforms.every(value => PLATFORMS.includes(value))) invalid.push('UNSUPPORTED_PLATFORM');
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.DISKHARBOR_STABLE_BUILD !== '1') {
    invalid.push('MANUAL_HOSTED_BUILD_REQUIRED');
  }
  for (const name of ['RELEASE_VERSION', 'RELEASE_SOURCE_SHA']) if (!present(name)) missing.push(name);
  if (!STABLE_VERSION.test(metadata?.version || '') || env.RELEASE_VERSION !== metadata?.version) invalid.push('STABLE_VERSION_REQUIRED');
  if (metadata?.license !== 'MIT') invalid.push('PROJECT_LICENSE_MISMATCH');
  if (!SHA.test(actualSha || '') || env.RELEASE_SOURCE_SHA !== actualSha || env.GITHUB_SHA !== actualSha) invalid.push('SOURCE_SHA_MISMATCH');
  if (dirty) invalid.push('WORKTREE_NOT_CLEAN');
  for (const target of platforms) for (const name of REQUIRED[target] || []) if (!present(name)) missing.push(name);
  if (platforms.includes('win32') && present('EXPECTED_WINDOWS_CERT_SHA256') && !/^[A-Fa-f0-9]{64}$/.test(env.EXPECTED_WINDOWS_CERT_SHA256)) invalid.push('INVALID_WINDOWS_CERT_SHA256');
  if (platforms.includes('darwin') && present('APPLE_TEAM_ID') && !/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) invalid.push('INVALID_APPLE_TEAM_ID');
  if (platforms.includes('darwin') && (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' || env.CSC_NAME === '-')) invalid.push('MAC_SIGNING_DISABLED');
  return {
    schemaVersion: 1, ok: missing.length === 0 && invalid.length === 0, platform,
    version: STABLE_VERSION.test(metadata?.version || '') ? metadata.version : null,
    sourceSha: SHA.test(actualSha || '') ? actualSha : null,
    missing, invalid, publication: 'manual-only', acceptance: 'signing-and-build-only',
  };
}

function inspectCheckout(root, env = process.env, platform = process.platform) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return preflight({ env, metadata, platform, actualSha, dirty: status.length > 0 });
}

function assertPreflight(root, env = process.env, platform = process.platform) {
  const result = inspectCheckout(root, env, platform);
  if (!result.ok) throw new Error(`STABLE_PREFLIGHT_FAILED: ${[...result.missing, ...result.invalid].join(', ')}`);
  return result;
}

if (require.main === module) {
  try {
    const platform = process.argv[2] || 'all';
    const result = inspectCheckout(path.resolve(__dirname, '..'), process.env, platform);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    // Git/config errors must not include arbitrary command output or environment values.
    process.stderr.write('STABLE_PREFLIGHT_INSPECTION_FAILED\n');
    process.exitCode = 1;
  }
}

module.exports = { preflight, inspectCheckout, assertPreflight, STABLE_VERSION, SHA };
