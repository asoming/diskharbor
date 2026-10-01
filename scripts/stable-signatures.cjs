'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// This runner never echoes argv, environment or tool output on failure. In
// particular, notarytool authentication must not leak through an exception.
function command(executable, args, { env = process.env, timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('SIGNATURE_TOOL_TIMEOUT'));
    }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      if (output.length + chunk.length > 2 * 1024 * 1024) {
        child.kill(); finish(new Error('SIGNATURE_TOOL_OUTPUT_LIMIT'));
      } else output += chunk.toString('utf8');
    });
    child.on('error', () => finish(new Error('SIGNATURE_TOOL_START_FAILED')));
    child.on('close', code => finish(code === 0 ? null : new Error('SIGNATURE_TOOL_REJECTED')));
  });
}

function validateWindowsSignature(value, expectedFingerprint) {
  assert.equal(value?.status, 'Valid', 'WINDOWS_SIGNATURE_UNTRUSTED');
  assert.equal(value.signatureType, 'Authenticode', 'WINDOWS_EMBEDDED_SIGNATURE_REQUIRED');
  assert.equal(value.certSha256?.toUpperCase(), expectedFingerprint.toUpperCase(), 'WINDOWS_SIGNER_MISMATCH');
  assert.equal(value.timestamp, true, 'WINDOWS_TIMESTAMP_REQUIRED');
  assert.match(value.timestampCertSha256 || '', /^[a-f0-9]{64}$/i, 'WINDOWS_TIMESTAMP_REQUIRED');
  return { status: 'Valid', certSha256: value.certSha256.toUpperCase(), timestampCertSha256: value.timestampCertSha256.toUpperCase() };
}

function validateMacSignature(output, teamId, { hardened = false } = {}) {
  const lines = output.split(/\r?\n/);
  assert(lines.includes(`TeamIdentifier=${teamId}`), 'MAC_TEAM_MISMATCH');
  assert(lines.some(line => line.startsWith('Authority=Developer ID Application: ') && line.endsWith(`(${teamId})`)), 'MAC_DEVELOPER_ID_REQUIRED');
  assert(lines.some(line => /^Timestamp=\S/.test(line)), 'MAC_TIMESTAMP_REQUIRED');
  assert(!lines.includes('Signature=adhoc'), 'MAC_ADHOC_REJECTED');
  if (hardened) assert(lines.some(line => /\bflags=0x[\da-f]+\([^)]*runtime[^)]*\)/i.test(line)), 'MAC_HARDENED_RUNTIME_REQUIRED');
  return { teamId, developerId: true, timestamp: true, hardenedRuntime: hardened };
}

async function walk(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      // macOS Frameworks legitimately use symlinks; do not follow them.
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) found.push(file);
      if (found.length > 20_000) throw new Error('SIGNATURE_FILE_LIMIT');
    }
  }
  await visit(root);
  return found;
}

async function verifyWindows({ appPath, artifact, fingerprint, run = command }) {
  const files = (await walk(appPath)).filter(file => /\.(exe|dll|node)$/i.test(file));
  assert(files.some(file => path.basename(file) === 'DiskHarbor.exe'), 'WINDOWS_APP_MISSING');
  assert(files.some(file => path.basename(file) === 'file-probe.exe'), 'WINDOWS_NATIVE_HELPER_MISSING');
  assert(files.some(file => path.basename(file) === 'file-policy.node'), 'WINDOWS_NATIVE_ADDON_MISSING');
  const script = "$ErrorActionPreference='Stop';$roots=Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin';$tools=@(Get-ChildItem -LiteralPath $roots -Directory | Where-Object {$_.Name -match '^\\d+\\.'} | Sort-Object {[version]$_.Name} -Descending | ForEach-Object {Join-Path $_.FullName 'x64/signtool.exe'} | Where-Object {Test-Path -LiteralPath $_});if($tools.Count -eq 0){throw 'SIGNTOOL_MISSING'};& $tools[0] verify /pa /all /tw $env:DISKHARBOR_VERIFY_FILE | Out-Null;if($LASTEXITCODE -ne 0){throw 'SIGNTOOL_REJECTED'};$s=Get-AuthenticodeSignature -LiteralPath $env:DISKHARBOR_VERIFY_FILE;$c=$null;$t=$null;if($s.SignerCertificate){$c=$s.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)};if($s.TimeStamperCertificate){$t=$s.TimeStamperCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)};@{status=$s.Status.ToString();signatureType=$s.SignatureType.ToString();certSha256=$c;timestamp=($null -ne $s.TimeStamperCertificate);timestampCertSha256=$t}|ConvertTo-Json -Compress";
  const signatures = [];
  for (const file of [artifact, ...files]) {
    const result = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, DISKHARBOR_VERIFY_FILE: file } });
    const signature = validateWindowsSignature(JSON.parse(result.trim()), fingerprint);
    signatures.push({ path: file === artifact ? path.basename(file) : path.relative(appPath, file).split(path.sep).join('/'), ...signature });
  }
  return { method: 'Authenticode-and-SignTool', signatures };
}

function machO(buffer) {
  return buffer.length >= 4 && ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(buffer.subarray(0, 4).toString('hex'));
}

async function verifyMac({ appPath, artifact, teamId, env = process.env, run = command }) {
  const detail = async (file, hardened) => {
    await run('/usr/bin/codesign', ['--verify', '--strict', file]);
    return validateMacSignature(await run('/usr/bin/codesign', ['--display', '--verbose=4', file]), teamId, { hardened });
  };
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const appSignature = await detail(appPath, true);
  const binaries = [];
  for (const file of await walk(appPath)) {
    const handle = await fs.open(file, 'r');
    let header;
    try { const buffer = Buffer.alloc(4); const { bytesRead } = await handle.read(buffer, 0, 4, 0); header = buffer.subarray(0, bytesRead); } finally { await handle.close(); }
    if (machO(header)) binaries.push(file);
  }
  assert(binaries.some(file => path.basename(file) === 'file-probe'), 'MAC_NATIVE_HELPER_MISSING');
  assert(binaries.some(file => path.basename(file) === 'file-policy.node'), 'MAC_NATIVE_ADDON_MISSING');
  for (const binary of binaries) await detail(binary, false);
  await run('xcrun', ['stapler', 'validate', appPath]);
  await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  await detail(artifact, false);
  // electron-builder notarizes/staples the app before making the DMG. Also
  // notarize and staple the exact outer container that will be distributed.
  const submission = JSON.parse(await run('xcrun', ['notarytool', 'submit', artifact,
    '--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id', teamId, '--wait', '--timeout', '30m', '--output-format', 'json'], { timeout: 32 * 60_000 }));
  assert.equal(submission.status, 'Accepted', 'MAC_NOTARIZATION_REJECTED');
  assert.match(submission.id || '', /^[a-f\d-]{36}$/i, 'MAC_NOTARIZATION_ID_MISSING');
  await run('xcrun', ['stapler', 'staple', artifact]);
  await run('xcrun', ['stapler', 'validate', artifact]);
  await detail(artifact, false);
  await run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', artifact]);
  return { method: 'Developer-ID-notarytool-stapler-Gatekeeper', ...appSignature, nativeBinariesVerified: binaries.length, appTicket: true, artifactTicket: true, notarySubmissionId: submission.id, notaryStatus: 'Accepted', gatekeeper: 'accepted' };
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close(); }
  return hash.digest('hex');
}

module.exports = { command, validateWindowsSignature, validateMacSignature, verifyWindows, verifyMac, machO, sha256 };
