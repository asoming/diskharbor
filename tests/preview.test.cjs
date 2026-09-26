'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { deflateSync } = require('node:zlib');
const { ScanIndex } = require('../electron/scanner.cjs');
const { createPreviewService, MAX_TEXT_BYTES, MAX_IMAGE_BYTES } = require('../electron/preview.cjs');

const linuxTest = (name, fn) => test(name, { skip: process.platform !== 'linux' }, fn);
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlKKKK7z5g/9k=', 'base64');
const WEBP = Buffer.from('UklGRjYAAABXRUJQVlA4ICoAAACwAQCdASoCAAMAAUAmJaACdLoABGaAAP7w1wPFsUhuZ/87B/Zv70eAAAA=', 'base64');
// Complete 2x3 images, generated once with Pillow; no test/runtime codec dependency.
const PROGRESSIVE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAADBf/aAAwDAQACEAMQAAABkh5f/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/AP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Qf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Qf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Qf//Z', 'base64');
const LOSSLESS_WEBP = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAfQt150rv+BiOh/AAA=', 'base64');

function pngChunk(type, data) {
  const tag = Buffer.from(type);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  tag.copy(chunk, 4); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([tag, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

function png(width = 2, height = 3) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  // Oversized-header fixtures deliberately keep their compressed payload tiny.
  const pixels = Buffer.alloc(Math.min(height, 3) * (1 + Math.min(width, 2) * 3));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t, content = 'hello', name = 'sample.txt', setup) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-preview-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  if (setup) await setup(root, target);
  const index = new ScanIndex(root);
  await index.scan();
  const entry = index.query({ limit: 100 }).entries.find(item => item.path === target);
  let context = { rootPath: root, scanId: index.scanId };
  const hooks = {};
  const counts = { opens: 0, closes: 0, reads: 0, bytes: 0, flags: 0 };
  const io = {
    ...fs,
    async open(filePath, flags) {
      counts.opens++; counts.flags = flags;
      await hooks.beforeOpen?.();
      const handle = await fs.open(filePath, flags);
      await hooks.afterOpen?.();
      return {
        fd: handle.fd,
        stat: options => handle.stat(options),
        async read(buffer, offset, length, position) {
          await hooks.beforeRead?.();
          const result = await handle.read(buffer, offset, Math.min(length, hooks.chunkSize || length), position);
          counts.reads++; counts.bytes += result.bytesRead;
          await hooks.afterRead?.();
          return result;
        },
        async close() { counts.closes++; await handle.close(); },
      };
    },
  };
  const create = overrides => createPreviewService({ getEntry: id => index.entry(id), getIdentity: id => index.entryIdentity(id), getScanContext: () => context, platform: 'linux', io, ...overrides });
  return { root, target, entry, index, hooks, counts, io, create, setContext: value => { context = value; } };
}

test('unverified Windows and macOS refuse before metadata lookup or content access', async () => {
  for (const platform of ['win32', 'darwin', 'freebsd']) {
    const called = () => { throw new Error('unexpected I/O'); };
    const service = createPreviewService({ platform, getEntry: called, getIdentity: called, getScanContext: called, io: new Proxy({}, { get: called }) });
    await assert.rejects(service.preview(1), { code: 'PREVIEW_PLATFORM_UNVERIFIED' });
  }
});

linuxTest('short UTF-8 documents and source code are plain text, preserve markup, and use no-follow handles', async t => {
  const content = '<h1>示例</h1>\n<script>alert("literal")</script>\n';
  const f = await fixture(t, content, 'example.ts');
  f.hooks.chunkSize = 3;
  const result = await f.create().preview(f.entry.id);
  assert.deepEqual(result, { kind: 'text', text: content, mime: 'text/plain', path: f.target, truncated: false, bytesRead: Buffer.byteLength(content) });
  assert.equal(f.counts.opens, 1); assert.equal(f.counts.closes, 1);
  assert.ok(f.counts.flags & constants.O_NOFOLLOW);
  assert.ok(f.counts.flags & constants.O_NONBLOCK);
  assert.ok(f.counts.reads > 1);
});

linuxTest('empty files do not require a read and each click starts a fresh uncached preview', async t => {
  const f = await fixture(t, '');
  const service = f.create();
  assert.equal((await service.preview(f.entry.id)).text, '');
  assert.equal((await service.preview(f.entry.id)).text, '');
  assert.equal(f.counts.reads, 0);
  assert.equal(f.counts.opens, 2); assert.equal(f.counts.closes, 2);
});

linuxTest('large text is capped at 64 KiB without a broken UTF-8 replacement character', async t => {
  const f = await fixture(t, 'a'.repeat(MAX_TEXT_BYTES - 1) + '中' + 'rest');
  const result = await f.create().preview(f.entry.id);
  assert.equal(result.truncated, true);
  assert.equal(result.bytesRead, MAX_TEXT_BYTES);
  assert.equal(result.text, 'a'.repeat(MAX_TEXT_BYTES - 1));
  assert.equal(f.counts.bytes, MAX_TEXT_BYTES);
});

linuxTest('complete PNG, baseline/progressive JPEG, and lossy/lossless WebP fixtures use fixed raster MIME types', async t => {
  for (const [name, content, mime] of [['a.png', png(), 'image/png'], ['a.jpg', JPEG, 'image/jpeg'], ['progressive.jpg', PROGRESSIVE_JPEG, 'image/jpeg'], ['a.webp', WEBP, 'image/webp'], ['lossless.webp', LOSSLESS_WEBP, 'image/webp']]) {
    const f = await fixture(t, content, name);
    const result = await f.create().preview(f.entry.id);
    assert.equal(result.kind, 'image'); assert.equal(result.mime, mime);
    assert.equal(result.width, 2); assert.equal(result.height, 3);
    assert.equal(result.bytesRead, content.length);
    assert.equal(result.dataUrl, `data:${mime};base64,${content.toString('base64')}`);
    assert.equal(f.counts.closes, 1);
  }
});

linuxTest('an exactly 8 MiB valid PNG passes the encoded-size boundary with bounded dimensions', async t => {
  const base = png();
  const large = Buffer.concat([base.subarray(0, -12), pngChunk('teSt', Buffer.alloc(MAX_IMAGE_BYTES - base.length - 12)), base.subarray(-12)]);
  const f = await fixture(t, large, 'boundary.png');
  const started = performance.now();
  const result = await f.create().preview(f.entry.id);
  const elapsed = performance.now() - started;
  assert.equal(result.bytesRead, MAX_IMAGE_BYTES);
  assert.equal(result.width, 2); assert.equal(result.height, 3);
  assert.equal(f.counts.bytes, MAX_IMAGE_BYTES); assert.equal(f.counts.closes, 1);
  t.diagnostic(`8 MiB PNG read + container/CRC validation + base64: ${elapsed.toFixed(1)} ms (single local observation, not a benchmark guarantee)`);
});

linuxTest('animated raster containers are explicitly unsupported', async t => {
  const base = png();
  const control = Buffer.alloc(8); control.writeUInt32BE(1);
  const apng = Buffer.concat([base.subarray(0, 33), pngChunk('acTL', control), base.subarray(33)]);
  const f = await fixture(t, apng, 'animated.png');
  await assert.rejects(f.create().preview(f.entry.id), { code: 'PREVIEW_UNSUPPORTED_TYPE' });
  assert.equal(f.counts.closes, 1);
});

linuxTest('SVG, HTML, PDF, hidden config and hard links are blocked before any content open', async t => {
  for (const [name, code] of [['a.svg', 'PREVIEW_UNSUPPORTED_TYPE'], ['a.html', 'PREVIEW_UNSUPPORTED_TYPE'], ['a.pdf', 'PREVIEW_UNSUPPORTED_TYPE'], ['.config/a.json', 'HIDDEN_PATH']]) {
    const f = await fixture(t, '<svg/>', name);
    await assert.rejects(f.create().preview(f.entry.id), { code });
    assert.equal(f.counts.opens, 0);
  }
  const f = await fixture(t, 'shared', 'a.txt', (root, target) => fs.link(target, path.join(root, 'other.txt')));
  await assert.rejects(f.create().preview(f.entry.id), { code: 'SHARED_FILE' });
  assert.equal(f.counts.opens, 0);
});

linuxTest('binary content and unsupported text encodings never become decoded previews', async t => {
  for (const [content, code] of [[Buffer.from([0x61, 0, 0x62]), 'PREVIEW_BINARY_TEXT'], [Buffer.from('%PDF-1.7\n'), 'PREVIEW_BINARY_TEXT'], [Buffer.from([0xff, 0xfe, 0x61, 0]), 'PREVIEW_ENCODING_UNSUPPORTED'], [Buffer.from([0x61, 0xff]), 'PREVIEW_ENCODING_UNSUPPORTED']]) {
    const f = await fixture(t, content);
    await assert.rejects(f.create().preview(f.entry.id), { code });
    assert.equal(f.counts.closes, 1);
  }
});

linuxTest('malformed raster containers and extensions that disagree with their signature are refused', async t => {
  const corruptPng = png(); corruptPng[corruptPng.length - 1] ^= 1;
  const corruptWebp = Buffer.from(WEBP); corruptWebp.writeUInt32LE(0xffffff, 16);
  for (const [name, content] of [['a.png', corruptPng], ['a.jpg', JPEG.subarray(0, -2)], ['a.webp', corruptWebp], ['a.png', JPEG], ['a.jpg', Buffer.from('<svg/>')]]) {
    const f = await fixture(t, content, name);
    await assert.rejects(f.create().preview(f.entry.id), { code: 'PREVIEW_INVALID_IMAGE' });
    assert.equal(f.counts.closes, 1);
  }
});

linuxTest('image encoded byte, side length and total pixel limits all reject oversized inputs', async t => {
  const large = await fixture(t, Buffer.alloc(MAX_IMAGE_BYTES + 1), 'a.png');
  await assert.rejects(large.create().preview(large.entry.id), { code: 'PREVIEW_TOO_LARGE' });
  assert.equal(large.counts.opens, 0);
  for (const [width, height] of [[8193, 1], [5000, 5000]]) {
    const f = await fixture(t, png(width, height), 'a.png');
    await assert.rejects(f.create().preview(f.entry.id), { code: 'PREVIEW_TOO_LARGE' });
    assert.equal(f.counts.closes, 1);
  }
});

linuxTest('unknown, network, FUSE and virtual volumes are refused before opening content', async t => {
  const f = await fixture(t);
  for (const [type, source] of [['nfs', 'server:/export'], ['cifs', '//server/share'], ['fuse.rclone', 'remote'], ['overlay', 'overlay'], ['tmpfs', 'tmpfs'], ['unknown', '/dev/sda'], ['ext4', 'unverified-source']]) {
    const io = { ...f.io, readFile: async file => { assert.equal(file, '/proc/self/mountinfo'); return `1 0 8:1 / / rw - ${type} ${source} rw\n`; } };
    await assert.rejects(f.create({ io }).preview(f.entry.id), { code: 'PREVIEW_VOLUME_UNVERIFIED' });
  }
  assert.equal(f.counts.opens, 0);
});

linuxTest('an unverified open-descriptor mount is refused without reading content and closes the handle', async t => {
  const f = await fixture(t);
  const io = { ...f.io, readFile: (file, ...args) => file.startsWith('/proc/self/fdinfo/') ? Promise.resolve('mnt_id:\t999999999\n') : fs.readFile(file, ...args) };
  await assert.rejects(f.create({ io }).preview(f.entry.id), { code: 'PREVIEW_VOLUME_UNVERIFIED' });
  assert.equal(f.counts.reads, 0); assert.equal(f.counts.closes, 1);
});

linuxTest('incomplete entries, missing identities and paths outside the current scan are refused', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({ getEntry: () => ({ ...f.entry, state: 'partial' }) }).preview(f.entry.id), { code: 'SCAN_INCOMPLETE' });
  await assert.rejects(f.create({ getIdentity: () => null }).preview(f.entry.id), { code: 'NOT_IN_SCAN' });
  const identity = f.index.entryIdentity(f.entry.id); delete identity.parentIno;
  await assert.rejects(f.create({ getIdentity: () => identity }).preview(f.entry.id), { code: 'SCAN_INCOMPLETE' });
  f.setContext({ scanId: f.index.scanId, rootPath: path.join(f.root, 'another-root') });
  await assert.rejects(f.create().preview(f.entry.id), { code: 'NOT_IN_SCAN' });
  assert.equal(f.counts.opens, 0);
});

linuxTest('a pathname replaced after scanning is refused before reading its new contents', async t => {
  const f = await fixture(t, 'old');
  await fs.rename(f.target, `${f.target}.old`);
  await fs.writeFile(f.target, 'new');
  await assert.rejects(f.create().preview(f.entry.id), { code: 'IDENTITY_CHANGED' });
  assert.equal(f.counts.opens, 0);
});

linuxTest('last-component symlink substitution at open cannot follow or read the target', async t => {
  const f = await fixture(t, 'old');
  f.hooks.beforeOpen = async () => { await fs.rename(f.target, `${f.target}.old`); await fs.symlink(`${f.target}.old`, f.target); };
  await assert.rejects(f.create().preview(f.entry.id), { code: 'SYMLINK' });
  assert.equal(f.counts.reads, 0);
  assert.equal(await fs.readFile(`${f.target}.old`, 'utf8'), 'old');
});

linuxTest('a regular-file substitution during open is caught by handle identity before reading', async t => {
  const f = await fixture(t, 'old');
  f.hooks.beforeOpen = async () => { await fs.rename(f.target, `${f.target}.old`); await fs.writeFile(f.target, 'new'); };
  await assert.rejects(f.create().preview(f.entry.id), { code: 'IDENTITY_CHANGED' });
  assert.equal(f.counts.reads, 0); assert.equal(f.counts.closes, 1);
});

linuxTest('content or pathname changes during a read discard the result and close the descriptor', async t => {
  for (const changePath of [false, true]) {
    const f = await fixture(t, 'initial');
    f.hooks.afterRead = async () => {
      if (changePath) { await fs.rename(f.target, `${f.target}.old`); await fs.writeFile(f.target, 'changed'); }
      else await fs.writeFile(f.target, 'changed and longer');
    };
    await assert.rejects(f.create().preview(f.entry.id), { code: 'IDENTITY_CHANGED' });
    assert.equal(f.counts.closes, 1);
  }
});

linuxTest('scan changes during lookup and reading discard late results', async t => {
  const f = await fixture(t);
  const changing = f.create({ getEntry: id => { f.setContext(null); return f.index.entry(id); } });
  await assert.rejects(changing.preview(f.entry.id), { code: 'SCAN_CHANGED' });
  assert.equal(f.counts.opens, 0);
  const reading = await fixture(t);
  reading.hooks.afterRead = () => reading.setContext(null);
  await assert.rejects(reading.create().preview(reading.entry.id), { code: 'SCAN_CHANGED' });
  assert.equal(reading.counts.closes, 1);
});

linuxTest('parent symlinks and denied metadata are rejected without opening content', async t => {
  const f = await fixture(t, 'safe', 'nested/a.txt');
  await fs.rename(path.join(f.root, 'nested'), path.join(f.root, 'renamed'));
  await fs.symlink(path.join(f.root, 'renamed'), path.join(f.root, 'nested'));
  await assert.rejects(f.create().preview(f.entry.id), { code: 'PARENT_CHANGED' });
  assert.equal(f.counts.opens, 0);
  const denied = await fixture(t);
  const io = { ...denied.io, lstat: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  await assert.rejects(denied.create({ io }).preview(denied.entry.id), { code: 'PERMISSION_DENIED' });
  assert.equal(denied.counts.opens, 0);
});
