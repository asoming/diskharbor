'use strict';

// Installation and uninstallation are intentionally unavailable on a personal
// machine or a self-hosted runner. The workflow is manually dispatched and all
// launch data, scan fixtures and temporary bundle locations belong to this run.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { workspace, ownedChild, run, waitFor, exists, sha256 } = require('./validation-common.cjs');
const { safeHistoryItem } = require('../electron/history.cjs');

const UPGRADE_BASE_SHA = '9849cc99641930303d7c9ad0fc1366d2a358dd5f';
const UPGRADE_BASE_VERSION = '0.1.0-alpha.13';
function upgradeHistory(fixture) {
  const now = Date.now();
  return safeHistoryItem({ id: `synthetic-upgrade-${randomUUID()}`, planId: 'synthetic-no-native-operation',
    time: now, finishedAt: now, rootPath: fixture, state: 'cancelled',
    success: 0, failed: 0, skipped: 0, cancelled: 1, total: 1, totalBytes: 0,
    freeSpaceDelta: null, spaceMeasurement: { version: 1, before: null, after: null, status: 'not-run' },
    items: [{ path: path.join(fixture, 'keep.txt'), kind: 'file', size: 0, status: 'cancelled', error: 'USER_CANCELLED' }],
  });
}

function packageFiles(names, platform) {
  const suffix = { linux: '.deb', win32: '.exe', darwin: '.dmg' }[platform];
  if (!suffix) throw new Error('UNSUPPORTED_PLATFORM');
  const matches = names.filter(name => path.basename(name) === name && name.endsWith(suffix));
  if (matches.length !== 1) throw new Error('PACKAGE_ARTIFACT_AMBIGUOUS');
  return matches[0];
}
function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('INVALID_ICON_PNG');
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error('INVALID_ICON_DIMENSIONS');
  return { width, height };
}
async function validateInstalledIcon(executable, base, metadata) {
  const platform = process.platform; const key = { linux: 'linux', darwin: 'mac', win32: 'win' }[platform];
  const source = metadata.build[key].icon;
  assert.equal(source, platform === 'linux' ? 'assets/icon.png' : 'assets/icon.svg');
  const evidence = { source, sourceSha256: await sha256(path.resolve(source)) };
  // Electron 44 downloads its development runtime lazily through this entry
  // point. electron-builder's separate runtime download does not populate
  // node_modules/electron/dist, so a guessed path can be absent after packaging.
  const standardExecutable = platform === 'linux' ? null : require('electron');
  if (standardExecutable) {
    assert.equal(typeof standardExecutable, 'string');
    const stat = await fs.lstat(standardExecutable); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    evidence.electronDefaultExecutable = standardExecutable;
    evidence.electronVersion = require('electron/package.json').version;
  }
  if (platform === 'darwin') {
    const contents = path.dirname(path.dirname(executable));
    const iconName = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', path.join(contents, 'Info.plist')])).stdout.trim();
    assert.equal(path.basename(iconName), iconName);
    const icon = ownedChild(path.join(contents, 'Resources'), path.join(contents, 'Resources', iconName.endsWith('.icns') ? iconName : `${iconName}.icns`));
    const standardContents = path.dirname(path.dirname(standardExecutable));
    const standardName = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', path.join(standardContents, 'Info.plist')])).stdout.trim();
    assert.equal(path.basename(standardName), standardName);
    const standard = ownedChild(path.join(standardContents, 'Resources'), path.join(standardContents, 'Resources', standardName.endsWith('.icns') ? standardName : `${standardName}.icns`));
    const bytes = await fs.readFile(icon); assert.equal(bytes.toString('ascii', 0, 4), 'icns'); assert.equal(bytes.readUInt32BE(4), bytes.length);
    evidence.resource = iconName; evidence.electronDefaultResource = standardName; evidence.installedSha256 = await sha256(icon); evidence.electronDefaultSha256 = await sha256(standard);
    assert.notEqual(evidence.installedSha256, evidence.electronDefaultSha256, 'Installed ICNS must not be the Electron default.');
    const ownPNG = path.join(base, 'installed-icon.png'); const defaultPNG = path.join(base, 'electron-default-icon.png');
    await run('sips', ['-s', 'format', 'png', icon, '--out', ownPNG]);
    await run('sips', ['-s', 'format', 'png', standard, '--out', defaultPNG]);
    evidence.renderedSha256 = await sha256(ownPNG); evidence.renderedDefaultSha256 = await sha256(defaultPNG);
    assert.notEqual(evidence.renderedSha256, evidence.renderedDefaultSha256);
    evidence.dimensions = pngDimensions(await fs.readFile(ownPNG));
  } else if (platform === 'win32') {
    const literal = value => `'${value.replace(/'/g, "''")}'`;
    const ownPNG = path.join(base, 'installed-icon.png'); const defaultPNG = path.join(base, 'electron-default-icon.png');
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; function Save-Icon($exe,$output) { $icon=[System.Drawing.Icon]::ExtractAssociatedIcon($exe); if($null -eq $icon){throw 'MISSING_EXE_ICON'}; $bitmap=$icon.ToBitmap(); try{$bitmap.Save($output,[System.Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose();$icon.Dispose()} }; Save-Icon ${literal(executable)} ${literal(ownPNG)}; Save-Icon ${literal(standardExecutable)} ${literal(defaultPNG)};`;
    await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script]);
    evidence.renderedSha256 = await sha256(ownPNG); evidence.renderedDefaultSha256 = await sha256(defaultPNG);
    assert.notEqual(evidence.renderedSha256, evidence.renderedDefaultSha256, 'Installed EXE icon must not be the Electron default.');
    evidence.dimensions = pngDimensions(await fs.readFile(ownPNG));
  } else {
    const installed = (await run('dpkg-query', ['-L', 'diskharbor'])).stdout.split(/\r?\n/);
    const desktops = installed.filter(file => file === '/usr/share/applications/diskharbor.desktop'); assert.equal(desktops.length, 1);
    assert.match(await fs.readFile(desktops[0], 'utf8'), /^Icon=diskharbor\r?$/m);
    const icons = installed.filter(file => /^\/usr\/share\/icons\/hicolor\/[^/]+\/apps\/diskharbor\.png$/.test(file)); assert.ok(icons.length > 0);
    evidence.desktopIcon = 'diskharbor';
    evidence.installed = await Promise.all(icons.map(async file => ({ path: file, sha256: await sha256(file), ...pngDimensions(await fs.readFile(file)) })));
  }
  return evidence;
}
function connectCDP(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') return reject(new Error('CDP_MUST_BE_LOOPBACK'));
    const socket = new WebSocket(url); const pending = new Map(); let next = 0;
    const errors = [];
    socket.addEventListener('error', () => reject(new Error('CDP_CONNECTION_FAILED')), { once: true });
    socket.addEventListener('close', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP_CLOSED')); } pending.clear(); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
      const call = pending.get(message.id);
      if (call) { pending.delete(message.id); clearTimeout(call.timer); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); }
    });
    socket.addEventListener('open', () => resolve({ errors, close: () => socket.close(), send(method, params = {}, sessionId) {
      return new Promise((resolveCall, rejectCall) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error(`CDP_TIMEOUT_${method}`)); }, 30000);
        pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    } }), { once: true });
  });
}
async function validateLaunch(executable, base, version, { expectedHistory = [], expectLocale, setEnglish = false, label = 'application' } = {}) {
  const fixture = path.join(base, 'scan-fixture'); await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'keep.txt'), 'Owned package validation sentinel.');
  await fs.writeFile(path.join(fixture, '.hidden.txt'), 'Hidden metadata is still scanned.');
  const expectedBytes = (await fs.stat(path.join(fixture, 'keep.txt'))).size + (await fs.stat(path.join(fixture, '.hidden.txt'))).size;
  const userData = path.join(base, 'app-data'); await fs.mkdir(userData, { recursive: true });
  const sentinelHash = await sha256(path.join(fixture, 'keep.txt'));
  const env = { ...process.env, XDG_DATA_HOME: path.join(base, 'xdg-data') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.DISKHARBOR_DEV_URL;
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const debugPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; let launchError; let cdp;
  child.once('error', error => { launchError = error; });
  child.stdout.on('data', data => { log = (log + data).slice(-64000); });
  child.stderr.on('data', data => { log = (log + data).slice(-64000); });
  try {
    // Windows GUI applications do not reliably send Chromium logs to inherited
    // stderr. Query the explicitly selected loopback port instead of parsing it.
    const socketURL = await waitFor('packaged Electron loopback debugging endpoint', async () => {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`PACKAGED_APP_EXITED: ${log}`);
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2000) });
        return response.ok && (await response.json()).webSocketDebuggerUrl;
      } catch { return false; }
    });
    cdp = await connectCDP(socketURL);
    const target = await waitFor('packaged application page', async () => (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'page' && target.url.startsWith('diskharbor://app/')));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await waitFor('production preload bridge', () => evaluate('Boolean(window.diskharbor && document.querySelector("input[aria-label=\\"扫描路径\\"],input[aria-label=\\"Scan path\\"]"))'));
    const info = await evaluate('window.diskharbor.info()'); assert.equal(info.version, version);
    assert.equal(await evaluate('typeof require'), 'undefined');
    assert.equal(await evaluate('window.diskharbor.summary()'), null, 'Launch must not automatically scan user directories.');
    assert.deepEqual(await evaluate('window.diskharbor.history()'), expectedHistory);
    if (expectLocale) assert.equal(await evaluate('localStorage.getItem("diskharbor.locale")'), expectLocale);
    if (setEnglish) {
      await evaluate('document.querySelector("button.language-button").click()');
      await waitFor('real language preference persists', () => evaluate('localStorage.getItem("diskharbor.locale") === "en" && Boolean(document.querySelector("input[aria-label=\\"Scan path\\"]"))'));
    }
    await evaluate(`(()=>{const input=document.querySelector('input[aria-label="扫描路径"],input[aria-label="Scan path"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(fixture)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await waitFor('real scan button becomes available', () => evaluate(`(()=>{const section=document.querySelector('section[aria-label="扫描位置"],section[aria-label="Scan location"]');const button=[...section.querySelectorAll('button')].find(b=>['开始扫描','Start scan'].includes(b.textContent.trim()));if(!button||button.disabled)return false;button.click();return true;})()`));
    const summary = await waitFor('packaged application scans owned fixture', async () => { const value = await evaluate('window.diskharbor.summary()'); if (value?.state === 'error') throw new Error(JSON.stringify(value)); return value?.state === 'completed' ? value : false; });
    assert.equal(summary.rootPath, fixture); assert.equal(summary.files, 2); assert.equal(summary.logicalBytes, expectedBytes); assert.equal(summary.errors, 0);
    assert.equal(await sha256(path.join(fixture, 'keep.txt')), sentinelHash);
    assert.deepEqual(cdp.errors, []);
    await cdp.send('Browser.close').catch(error => { if (!/CDP_CLOSED/.test(error.message)) throw error; });
    await waitFor('owned packaged process exits', () => child.exitCode !== null || child.signalCode !== null);
    return { info, summary: { files: summary.files, logicalBytes: summary.logicalBytes, errors: summary.errors }, preloadNodeRequire: 'undefined', noAutomaticScan: true, historyCount: expectedHistory.length, ...(expectLocale || setEnglish ? { locale: expectLocale || 'en' } : {}), errors: cdp.errors, fixture, sentinelHash, sandboxBypassFlags: false };
  } finally {
    cdp?.close();
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { allowFailure: true });
      else child.kill();
    }
    await fs.writeFile(path.join(base, `${label}.log`), log);
  }
}

async function main() {
  const base = await workspace('package-validation');
  const output = path.resolve('output', `package-validation-${randomUUID()}`); await fs.mkdir(output, { recursive: true });
  const metadata = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
  const release = path.resolve('release', metadata.version);
  const names = await fs.readdir(release);
  const artifact = path.join(release, packageFiles(names, process.platform));
  const install = ownedChild(base, path.join(base, 'installed'));
  const report = { platform: process.platform, arch: process.arch, osVersion: os.version(), osRelease: os.release(), version: metadata.version, commit: process.env.GITHUB_SHA,
    result: 'running', checks: [], errors: [], signing: { releaseClass: 'unsigned-prerelease', developerIdentity: false, notarized: false, gatekeeperDistributionApproved: false },
    boundary: `GitHub-hosted disposable runner only; native install, ${UPGRADE_BASE_VERSION}-to-current upgrade and uninstall of unsigned locally-built artifacts, not a signed/notarized stable distribution.` };
  let installed = false; let mount; let executable; let uninstaller;
  try {
    const artifacts = names.filter(name => /\.(deb|tar\.gz|exe|dmg)$/.test(name));
    report.artifacts = await Promise.all(artifacts.map(async name => ({ file: name, bytes: (await fs.stat(path.join(release, name))).size, sha256: await sha256(path.join(release, name)) })));
    await fs.writeFile(path.join(release, `SHA256SUMS-${process.platform}-${process.arch}.txt`), report.artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''));
    const installArtifact = async (selectedArtifact, upgrade = false) => {
      if (upgrade) assert.equal(installed, true, 'Only this run’s previously installed package may be upgraded.');
      if (process.platform === 'linux') {
        const previous = await run('dpkg-query', ['-W', '-f=${Status}', 'diskharbor'], { allowFailure: true });
        if (!upgrade && previous.code === 0) throw new Error('EXISTING_INSTALLATION_REFUSED');
        const name = (await run('dpkg-deb', ['-f', selectedArtifact, 'Package'])).stdout.trim(); assert.equal(name, 'diskharbor');
        // A local DEB still has declared runtime dependencies. apt installs those
        // from the runner's configured repository; plain dpkg does not resolve them.
        installed = true;
        await run('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', selectedArtifact], { timeout: 300000 });
        const files = (await run('dpkg-query', ['-L', 'diskharbor'])).stdout.split(/\r?\n/);
        const choices = files.filter(file => file.startsWith('/opt/') && path.basename(file) === 'diskharbor'); assert.equal(choices.length, 1); executable = choices[0];
        const sandbox = path.join(path.dirname(executable), 'chrome-sandbox');
        const stat = await fs.stat(sandbox); assert.equal(stat.uid, 0);
        // Electron can use user namespaces or the setuid helper. Record the
        // installed helper state; actual default-sandbox launch is the gate.
        report.installation = { kind: 'native-deb', package: name, executable, sandboxHelperSetuid: Boolean(stat.mode & 0o4000), sandboxHelperMode: (stat.mode & 0o7777).toString(8) };
      } else if (process.platform === 'darwin') {
        if (await exists('/Applications/DiskHarbor.app')) throw new Error('EXISTING_INSTALLATION_REFUSED');
        mount = path.join(base, 'disk-image'); await fs.mkdir(mount, { recursive: true }); await fs.mkdir(install, { recursive: true });
        await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, selectedArtifact]);
        const bundles = (await fs.readdir(mount)).filter(name => name === 'DiskHarbor.app'); assert.equal(bundles.length, 1);
        if (upgrade) await fs.rm(ownedChild(install, path.join(install, 'DiskHarbor.app')), { recursive: true });
        await run('ditto', [path.join(mount, bundles[0]), path.join(install, 'DiskHarbor.app')]); installed = true;
        await run('hdiutil', ['detach', mount]); mount = undefined;
        executable = path.join(install, 'DiskHarbor.app', 'Contents', 'MacOS', 'DiskHarbor');
        const signature = await run('codesign', ['-dv', '--verbose=2', path.join(install, 'DiskHarbor.app')], { allowFailure: true });
        report.signing.observed = signature.stderr.trim();
        report.installation = { kind: 'dmg-app-bundle-copy', executable, note: 'Read-only DMG mount and copy to an owned application directory; not a pkg installer or Gatekeeper approval.' };
      } else if (process.platform === 'win32') {
        if (!upgrade) {
          for (const hive of ['HKCU', 'HKLM']) {
            for (const view of ['/reg:64', '/reg:32']) {
              const registered = await run('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'DiskHarbor', '/d', view], { allowFailure: true });
              if (registered.code === 0) throw new Error('EXISTING_INSTALLATION_REFUSED');
            }
          }
          for (const parent of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DiskHarbor'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DiskHarbor'), process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'DiskHarbor')]) if (parent && await exists(parent)) throw new Error('EXISTING_INSTALLATION_REFUSED');
        }
        await run(selectedArtifact, ['/S', '/currentuser', `/D=${install}`], { windowsVerbatimArguments: true }); installed = true;
        await waitFor('NSIS owned installation', () => exists(path.join(install, 'DiskHarbor.exe')));
        executable = path.join(install, 'DiskHarbor.exe');
        const uninstallers = (await fs.readdir(install)).filter(name => /^Uninstall DiskHarbor.*\.exe$/i.test(name)); assert.equal(uninstallers.length, 1);
        uninstaller = ownedChild(install, path.join(install, uninstallers[0]));
        const stat = await fs.lstat(uninstaller); assert.ok(stat.isFile() && !stat.isSymbolicLink());
        // Match the hosted runner's PowerShell 7 shell. Launching Windows
        // PowerShell 5.1 through Node inherits PS7's module search path and can
        // resolve incompatible versions of Microsoft.PowerShell.Security.
        const signature = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Get-AuthenticodeSignature -LiteralPath '${selectedArtifact.replace(/'/g, "''")}' | Select-Object Status,StatusMessage | ConvertTo-Json -Compress`]);
        report.signing.observed = JSON.parse(signature.stdout); report.installation = { kind: 'native-nsis-current-user', executable, uninstaller };
      } else throw new Error('UNSUPPORTED_PLATFORM');
    };
    const oldSource = path.resolve('work', 'upgrade-source');
    const sourceSHA = (await run('git', ['-C', oldSource, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(sourceSHA, UPGRADE_BASE_SHA, 'Upgrade baseline must be the actual previously verified source, never a relabeled current build.');
    const oldMetadata = JSON.parse(await fs.readFile(path.join(oldSource, 'package.json'), 'utf8'));
    assert.equal(oldMetadata.version, UPGRADE_BASE_VERSION); assert.notEqual(metadata.version, oldMetadata.version);
    const oldRelease = path.join(oldSource, 'release', oldMetadata.version);
    const oldArtifact = path.join(oldRelease, packageFiles(await fs.readdir(oldRelease), process.platform));
    report.upgrade = { from: oldMetadata.version, to: metadata.version, sourceSHA, oldArtifact: { file: path.basename(oldArtifact), sha256: await sha256(oldArtifact) },
      baselineBuildOverride: 'NSIS runAfterFinish=false only; source and version unchanged.',
      historyFixture: 'A schema-valid synthetic cancelled record is seeded only while the owned application is closed; this is persistence evidence, not a claim of a real Trash operation.' };
    await installArtifact(oldArtifact);
    report.upgrade.oldLaunch = await validateLaunch(executable, base, oldMetadata.version, { setEnglish: true, label: 'old-first-launch' });
    const historyFixture = upgradeHistory(report.upgrade.oldLaunch.fixture); assert.ok(historyFixture);
    const historyFile = path.join(base, 'app-data', 'operation-history.json');
    await fs.writeFile(historyFile, JSON.stringify([historyFixture]), { flag: 'wx' });
    report.upgrade.oldReload = await validateLaunch(executable, base, oldMetadata.version, { expectedHistory: [historyFixture], expectLocale: 'en', label: 'old-history-reload' });
    const historyHash = await sha256(historyFile);
    report.checks.push(`The published ${UPGRADE_BASE_VERSION} source is built and installed, its real language control persists English, and its own history reader accepts an explicitly synthetic cancelled record.`);
    await installArtifact(artifact, true);
    report.icon = await validateInstalledIcon(executable, base, metadata);
    report.checks.push('The new native artifact upgrades only this run’s old installation (macOS replaces the owned app bundle); no pre-existing installation is overwritten.');
    report.checks.push('The installed native application icon is present; Windows/macOS extracted icon fingerprints differ from the bundled Electron default, and Linux desktop/icon resources match the application name.');
    report.launch = await validateLaunch(executable, base, metadata.version, { expectedHistory: [historyFixture], expectLocale: 'en' });
    assert.equal(await sha256(historyFile), historyHash);
    report.upgrade.preferencePreserved = true; report.upgrade.historyPreserved = true; report.upgrade.historySha256 = historyHash;
    report.checks.push('The upgraded production application preserves the exact history and language preference, starts with its sandbox, and scans only explicitly chosen synthetic files through its actual UI.');
    if (process.platform === 'linux') {
      await run('sudo', ['dpkg', '--purge', 'diskharbor']);
      const state = await run('dpkg-query', ['-W', '-f=${Status}', 'diskharbor'], { allowFailure: true }); assert.notEqual(state.code, 0);
    } else if (process.platform === 'win32') {
      assert.ok(uninstaller && ownedChild(install, uninstaller));
      await run(uninstaller, ['/S', `_?=${install}`], { windowsVerbatimArguments: true });
    } else await fs.rm(ownedChild(install, path.join(install, 'DiskHarbor.app')), { recursive: true });
    await waitFor('installed executable removed', async () => !await exists(executable)); installed = false;
    assert.equal(await sha256(path.join(report.launch.fixture, 'keep.txt')), report.launch.sentinelHash);
    assert.equal(await sha256(historyFile), historyHash);
    report.checks.push('Native uninstall (or removal of the owned macOS app bundle) removes the executable and preserves the separate user-file sentinel and isolated application history.');
    report.result = 'passed';
  } catch (error) { report.result = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    if (mount) await run('hdiutil', ['detach', mount], { allowFailure: true }).catch(error => report.errors.push(error.message));
    // Only undo an installation made by this run. Never invent an uninstall
    // target after a failed/ambiguous discovery or delete default user data.
    if (installed && process.platform === 'linux') await run('sudo', ['dpkg', '--purge', 'diskharbor'], { allowFailure: true }).catch(error => report.errors.push(error.message));
    if (installed && process.platform === 'win32' && uninstaller) await run(uninstaller, ['/S', `_?=${install}`], { windowsVerbatimArguments: true, allowFailure: true }).catch(error => report.errors.push(error.message));
    if (installed && process.platform === 'darwin') await fs.rm(ownedChild(install, path.join(install, 'DiskHarbor.app')), { recursive: true, force: true }).catch(error => report.errors.push(error.message));
    if (report.errors.length) { report.result = 'failed'; process.exitCode = 1; }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    for (const name of ['application.log', 'old-first-launch.log', 'old-history-reload.log']) if (await exists(path.join(base, name))) await fs.copyFile(path.join(base, name), path.join(output, name));
    console.log(JSON.stringify({ output, ...report }, null, 2));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { packageFiles, connectCDP, upgradeHistory, UPGRADE_BASE_SHA, UPGRADE_BASE_VERSION, pngDimensions };
