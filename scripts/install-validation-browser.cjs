'use strict';

// Official Mozilla binaries only. The isolated application files are temporary;
// the browser-cache test separately verifies real standard profile locations.
const fs = require('node:fs/promises');
const path = require('node:path');
const { requireHostedCI, run, download, exists } = require('./validation-common.cjs');

async function geckodriverRelease(token = process.env.GITHUB_TOKEN) {
  const headers = { 'User-Agent': 'DiskHarbor-release-validation', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Authenticate only this fixed API endpoint. Redirects are rejected, and
  // archive downloads use the separate, unauthenticated download helper.
  const response = await fetch('https://api.github.com/repos/mozilla/geckodriver/releases/latest', {
    headers, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GECKODRIVER_RELEASE_${response.status}`);
  return response.json();
}

async function installBrowser(base) {
  requireHostedCI();
  const tools = path.join(base, 'browser-tools'); await fs.mkdir(tools);
  const platform = process.platform; const arm = process.arch === 'arm64';
  if (platform === 'win32' && arm) throw new Error('WINDOWS_ARM_BROWSER_VALIDATION_NOT_CONFIGURED');
  const browserOS = platform === 'win32' ? 'win64' : platform === 'darwin' ? 'osx' : arm ? 'linux64-aarch64' : 'linux64';
  const suffix = platform === 'win32' ? '.exe' : platform === 'darwin' ? '.dmg' : '.tar.xz';
  const archive = path.join(tools, `firefox${suffix}`);
  const browserDownload = await download(`https://download.mozilla.org/?product=firefox-latest-ssl&os=${browserOS}&lang=en-US`, archive, ['mozilla.org', 'mozilla.net']);
  let binary;
  if (platform === 'linux') {
    await run('tar', ['-xf', archive, '-C', tools]); binary = path.join(tools, 'firefox', 'firefox');
  } else if (platform === 'darwin') {
    const mount = path.join(tools, 'firefox-dmg'); await fs.mkdir(mount);
    await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, archive]);
    try { await run('ditto', [path.join(mount, 'Firefox.app'), path.join(tools, 'Firefox.app')]); }
    finally { await run('hdiutil', ['detach', mount]); }
    binary = path.join(tools, 'Firefox.app', 'Contents', 'MacOS', 'firefox');
  } else {
    const target = path.join(tools, 'firefox');
    // Mozilla's official full installer supports extraction without changing
    // the host browser installation, services, shortcuts or default app.
    await run(archive, [`/ExtractDir=${target}`]); binary = path.join(target, 'core', 'firefox.exe');
  }
  if (!await exists(binary)) throw new Error('FIREFOX_EXECUTABLE_MISSING');
  const release = await geckodriverRelease();
  const target = platform === 'win32' ? 'win64.zip' : platform === 'darwin' ? (arm ? 'macos-aarch64.tar.gz' : 'macos.tar.gz') : (arm ? 'linux-aarch64.tar.gz' : 'linux64.tar.gz');
  const assets = release.assets.filter(asset => asset.name.endsWith(`-${target}`));
  if (assets.length !== 1) throw new Error('GECKODRIVER_ASSET_AMBIGUOUS');
  const driverArchive = path.join(tools, assets[0].name);
  const driverDownload = await download(assets[0].browser_download_url, driverArchive, ['github.com', 'githubusercontent.com']);
  await run('tar', ['-xf', driverArchive, '-C', tools]);
  const driver = path.join(tools, platform === 'win32' ? 'geckodriver.exe' : 'geckodriver');
  if (!await exists(driver)) throw new Error('GECKODRIVER_EXECUTABLE_MISSING');
  return { binary, driver, browserDownload, driverDownload, geckodriverRelease: release.tag_name, browserDistribution: 'Official Firefox release archive; default profile/cache locations, isolated application binaries.' };
}
module.exports = { installBrowser, geckodriverRelease };
