'use strict';

// This is a CI-only real-browser test, never a cleanup feature. Firefox itself
// creates every cache file and performs CLEAR_NETWORK_CACHE. No cache layout,
// index, entries or browser data is fabricated by this harness.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { workspace, ownedChild, firefoxProfileRoots, waitFor, exists, sha256 } = require('./validation-common.cjs');
const { installBrowser } = require('./install-validation-browser.cjs');
const { ScanIndex } = require('../electron/scanner.cjs');

async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function snapshot(directory) {
  if (!await exists(directory)) return { files: 0, bytes: 0 };
  let files = 0; let bytes = 0;
  async function visit(current) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const target = path.join(current, entry.name); let stat;
      try { stat = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) throw new Error('UNEXPECTED_PROFILE_SYMLINK');
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) { files++; bytes += stat.size; if (files > 20000) throw new Error('CACHE_FIXTURE_TOO_LARGE'); }
    }
  }
  await visit(directory); return { files, bytes };
}
async function main() {
  const base = await workspace('browser-validation');
  const output = path.resolve('output', `browser-validation-${randomUUID()}`); await fs.mkdir(output, { recursive: true });
  const report = { platform: process.platform, checks: [], errors: [], result: 'running',
    boundary: 'Real official Firefox, isolated test profile in the OS standard profile root. No cache directory override. Native cache-only service via WebDriver, not settings GUI; no Chrome/Chromium validation claim.',
    sources: ['https://firefox-source-docs.mozilla.org/toolkit/profile/', 'https://firefox-source-docs.mozilla.org/testing/geckodriver/Profiles.html', 'https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html', 'https://raw.githubusercontent.com/mozilla-firefox/firefox/main/toolkit/components/cleardata/nsIClearDataService.idl'] };
  const name = `diskharbor-validation-${randomUUID()}`;
  const roots = firefoxProfileRoots(process.platform, os.homedir());
  const profile = ownedChild(roots.root, path.join(roots.root, name));
  const local = ownedChild(roots.local, path.join(roots.local, name));
  let driverProcess; let driverFailure; let server; let sessionId; let endpoint; let profileOwned = false; let driverLog = ''; let browserStopped = true;
  const request = async (method, route, body) => {
    const response = await fetch(endpoint + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
    const value = await response.json();
    if (!response.ok || value.value?.error) throw new Error(`WEBDRIVER_${value.value?.error || response.status}: ${value.value?.message || ''}`);
    return value.value;
  };
  const command = (route, body = {}) => request('POST', `/session/${sessionId}${route}`, body);
  const context = value => command('/moz/context', { context: value });
  const script = (source, args = [], async = false) => command(`/execute/${async ? 'async' : 'sync'}`, { script: source, args });
  const closeSession = async () => { if (sessionId) { await request('DELETE', `/session/${sessionId}`); sessionId = undefined; browserStopped = true; } };
  try {
    assert.equal(await exists(profile), false); assert.equal(await exists(local), false);
    await fs.mkdir(profile, { recursive: true }); profileOwned = true;
    const sentinel = randomUUID(); const sentinelPath = path.join(profile, 'diskharbor-user-data-sentinel.txt');
    await fs.writeFile(sentinelPath, sentinel, { flag: 'wx' });
    const sentinelHash = await sha256(sentinelPath);
    const tools = await installBrowser(base); report.browserDistribution = tools.browserDistribution; report.downloads = { firefox: tools.browserDownload, geckodriver: tools.driverDownload }; report.geckodriverRelease = tools.geckodriverRelease;
    const driverPort = await freePort(); endpoint = `http://127.0.0.1:${driverPort}`;
    driverProcess = spawn(tools.driver, ['--host', '127.0.0.1', '--port', String(driverPort), '--allow-system-access'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    driverProcess.once('error', error => { driverFailure = error; });
    driverProcess.stdout.on('data', data => { driverLog = (driverLog + data).slice(-64000); });
    driverProcess.stderr.on('data', data => { driverLog = (driverLog + data).slice(-64000); });
    await waitFor('loopback geckodriver', async () => { if (driverFailure) throw driverFailure; try { return (await request('GET', '/status')).ready; } catch { if (driverProcess.exitCode !== null) throw new Error(`GECKODRIVER_EXITED: ${driverLog}`); return false; } });
    const launch = async () => {
      browserStopped = false;
      const value = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { binary: tools.binary, args: ['-headless', '-no-remote', '-profile', profile], prefs: {
        'browser.cache.disk.enable': true, 'browser.cache.memory.enable': false,
        'browser.cache.disk.smart_size.enabled': false, 'browser.cache.disk.capacity': 32768,
        'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage': 'about:blank',
        'browser.safebrowsing.malware.enabled': false, 'browser.safebrowsing.phishing.enabled': false,
        'browser.safebrowsing.downloads.enabled': false, 'network.http.rcwn.enabled': false,
      } } } } });
      sessionId = value.sessionId; report.browserVersion = value.capabilities.browserVersion;
      await command('/timeouts', { script: 30000, pageLoad: 30000, implicit: 0 });
      await context('chrome');
      const observed = await script('return {root:Services.dirsvc.get("ProfD",Ci.nsIFile).path,local:Services.dirsvc.get("ProfLD",Ci.nsIFile).path,version:Services.appinfo.version};');
      assert.equal(path.resolve(observed.root), path.resolve(profile)); assert.equal(path.resolve(observed.local), path.resolve(local)); assert.notEqual(observed.root, observed.local);
      report.profile = observed;
      await context('content');
    };
    const payload = randomBytes(256 * 1024); let requests = 0;
    server = http.createServer((req, res) => {
      if (req.url === '/payload.bin') { requests++; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length, 'Cache-Control': 'public, max-age=31536000, immutable' }); res.end(payload); }
      else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('<!doctype html><meta charset="utf-8"><title>Owned browser-cache validation</title><p>Local synthetic content only</p>'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const fetchPayload = () => script('const done=arguments[arguments.length-1];fetch(arguments[0]).then(r=>r.arrayBuffer()).then(data=>done({bytes:data.byteLength}),e=>done({error:String(e)}));', [`${origin}/payload.bin`], true);
    await launch();
    report.checks.push('Firefox reports its real root and local profile directories in the OS standard locations, with no disk-cache path override.');
    await command('/url', { url: `${origin}/page` });
    await script('document.cookie="diskharbor="+arguments[0]+"; path=/; max-age=3600";localStorage.setItem("diskharbor",arguments[0]);return true;', [sentinel]);
    await context('chrome');
    const bookmark = await script('const done=arguments[arguments.length-1];const {PlacesUtils}=ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");PlacesUtils.bookmarks.insert({parentGuid:PlacesUtils.bookmarks.unfiledGuid,url:arguments[0],title:arguments[1]}).then(b=>done(b.guid),e=>done({error:String(e)}));', [`${origin}/bookmark`, sentinel], true);
    assert.equal(typeof bookmark, 'string'); await context('content');
    assert.equal((await fetchPayload()).bytes, payload.length); assert.equal(requests, 1);
    await closeSession();
    const cache = path.join(local, 'cache2');
    await waitFor('Firefox writes the real disk-cache index', () => exists(path.join(cache, 'index')));
    const before = await snapshot(path.join(cache, 'entries')); assert.ok(before.files > 0 && before.bytes >= payload.length);
    const index = new ScanIndex(local); await index.scan(); const found = index.cacheReport({ platform: process.platform, home: os.homedir(), ...(process.env.XDG_CACHE_HOME ? { cacheHome: process.env.XDG_CACHE_HOME } : {}), ...(process.env.LOCALAPPDATA ? { localAppData: process.env.LOCALAPPDATA } : {}) });
    const finding = found.findings.find(item => item.entry.path === cache);
    assert.ok(finding?.complete); assert.equal(finding.ruleId, `firefox-disk-cache-${process.platform}`);
    report.before = { ...before, indexed: finding.entry, ruleId: finding.ruleId, complete: finding.complete };
    report.payload = { bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
    report.checks.push('A local HTTP response creates real cache2 entries and index files; the unchanged production scanner identifies the actual default-layout Firefox cache.');
    await launch(); await command('/url', { url: `${origin}/page` });
    assert.equal((await fetchPayload()).bytes, payload.length); assert.equal(requests, 1, 'A restarted browser must reuse its persistent disk cache.');
    report.checks.push('After a real Firefox restart, fetching the same immutable response causes no second server request, demonstrating persistent cache reuse.');
    await context('chrome');
    const cleared = await script('const done=arguments[arguments.length-1];Services.clearData.deleteData(Ci.nsIClearDataService.CLEAR_NETWORK_CACHE,flags=>done({failedFlags:flags}));', [], true);
    assert.deepEqual(cleared, { failedFlags: 0 });
    report.clearMethod = 'Firefox native nsIClearDataService.CLEAR_NETWORK_CACHE via loopback privileged WebDriver; not settings GUI.';
    report.afterClear = await waitFor('native clearing removes the owned cache payload', async () => { const value = await snapshot(path.join(cache, 'entries')); return value.bytes < before.bytes ? value : false; });
    const storedBookmark = await script('const done=arguments[arguments.length-1];const {PlacesUtils}=ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");PlacesUtils.bookmarks.fetch(arguments[0]).then(b=>done(b?{title:b.title,url:b.url.href}:null),e=>done({error:String(e)}));', [bookmark], true);
    assert.deepEqual(storedBookmark, { title: sentinel, url: `${origin}/bookmark` });
    await context('content');
    const preserved = await script('return {cookie:document.cookie,storage:localStorage.getItem("diskharbor")};');
    assert.ok(preserved.cookie.split(';').some(value => value.trim() === `diskharbor=${sentinel}`)); assert.equal(preserved.storage, sentinel); assert.equal(await sha256(sentinelPath), sentinelHash);
    assert.equal((await fetchPayload()).bytes, payload.length); assert.equal(requests, 2, 'Native cache-only clearing must make the browser refetch the payload.');
    report.sentinels = { cookie: true, localStorage: true, bookmark: true, profileFile: true, payloadRequestsBeforeClear: 1, payloadRequestsAfterClear: requests };
    report.checks.push('Firefox native network-cache clearing shrinks recorded cache entries and causes a fresh HTTP request while preserving cookie, localStorage, bookmark and file sentinels.');
    await closeSession(); assert.equal(await sha256(sentinelPath), sentinelHash);
    report.result = 'passed';
  } catch (error) { report.result = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    try { await closeSession(); } catch (error) { report.errors.push(`close-session: ${error.message}`); }
    if (driverProcess && driverProcess.exitCode === null) { driverProcess.kill(); await waitFor('owned driver exit', () => driverProcess.exitCode !== null || driverProcess.signalCode !== null, 10000).catch(error => report.errors.push(error.message)); }
    if (server) await new Promise(resolve => server.close(resolve));
    // Only these two newly-created UUID leaves are ours. Never delete a browser
    // parent, default profile, registry, installation, or another running process.
    if (profileOwned && browserStopped) {
      await fs.rm(profile, { recursive: true, force: true }).catch(error => report.errors.push(error.message));
      await fs.rm(local, { recursive: true, force: true }).catch(error => report.errors.push(error.message));
    } else if (profileOwned) report.ownedProfileRetained = 'Browser shutdown could not be confirmed; leave this run-owned profile for disposal with the hosted VM.';
    if (report.errors.length) { report.result = 'failed'; process.exitCode = 1; }
    await fs.writeFile(path.join(output, 'driver.log'), driverLog);
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, ...report }, null, 2));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { snapshot };
