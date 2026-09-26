'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { protectedPathReason, sameIdentity, snapshot } = require('./cleanup.cjs');

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 16000000;
const TEXT_EXTENSIONS = new Set('txt md markdown csv tsv log json jsonl yaml yml toml ini xml py js jsx ts tsx css scss less c cc cpp cxx h hh hpp rs go java kt swift rb sh bash zsh sql'.split(' '));
const IMAGE_MIMES = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]);
// Deliberately excludes overlay, FUSE, network, virtual and unrecognized filesystems.
const LOCAL_FILESYSTEMS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'vfat', 'exfat', 'ntfs3']);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function fail(code) { throw Object.assign(new Error(code), { code }); }
function inside(root, filePath) {
  const relative = path.relative(root, filePath);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function mountsFrom(text) {
  const decode = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  return text.split('\n').flatMap(line => {
    const [left, right] = line.split(' - ');
    if (!right) return [];
    const fields = left.split(' ');
    const details = right.split(' ');
    if (fields.length < 6 || details.length < 3 || !/^\d+$/.test(fields[0])) return [];
    return [{ id: fields[0], path: decode(fields[4]), type: details[0], source: decode(details[1]) }];
  });
}
function localMount(mount) {
  return !!mount && LOCAL_FILESYSTEMS.has(mount.type) && mount.source.startsWith('/dev/');
}
async function verifyVolume(io, filePath, handle) {
  try {
    const mounts = mountsFrom(await io.readFile('/proc/self/mountinfo', 'utf8'));
    if (handle) {
      // fdinfo proves the open descriptor's filesystem, even if its path was remounted.
      const fdinfo = await io.readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
      const id = /^mnt_id:\s*(\d+)$/m.exec(fdinfo)?.[1];
      if (!localMount(mounts.find(mount => mount.id === id))) fail('PREVIEW_VOLUME_UNVERIFIED');
    } else {
      const mount = mounts.filter(item => inside(item.path, filePath))
        .sort((a, b) => b.path.length - a.path.length || Number(b.id) - Number(a.id))[0];
      if (!localMount(mount)) fail('PREVIEW_VOLUME_UNVERIFIED');
    }
  } catch { fail('PREVIEW_VOLUME_UNVERIFIED'); }
}

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) fail('PREVIEW_INVALID_IMAGE');
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) fail('PREVIEW_TOO_LARGE');
  return { width, height };
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Container/header validation bounds decoder work. This is not a raster codec;
// the sandboxed renderer must also handle a browser image decode failure.
// PNG: https://www.w3.org/TR/png-3/
function pngDimensions(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail('PREVIEW_INVALID_IMAGE');
  let result;
  let dataSeen = false;
  let paletteSeen = false;
  let color;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) fail('PREVIEW_INVALID_IMAGE');
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) fail('PREVIEW_INVALID_IMAGE');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('PREVIEW_INVALID_IMAGE');
    if (offset === 8 && type !== 'IHDR') fail('PREVIEW_INVALID_IMAGE');
    if (type === 'IHDR') {
      if (result || length !== 13) fail('PREVIEW_INVALID_IMAGE');
      result = dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
      const depth = bytes[offset + 16];
      color = bytes[offset + 17];
      const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!validDepths[color]?.includes(depth) || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20] > 1) fail('PREVIEW_INVALID_IMAGE');
    } else if (type === 'PLTE') {
      if (paletteSeen || dataSeen || length === 0 || length > 768 || length % 3 || color === 0 || color === 4) fail('PREVIEW_INVALID_IMAGE');
      paletteSeen = true;
    } else if (type === 'IDAT') {
      if (color === 3 && !paletteSeen) fail('PREVIEW_INVALID_IMAGE');
      if (length) dataSeen = true;
    } else if (type === 'IEND') {
      if (length || !dataSeen || end !== bytes.length) fail('PREVIEW_INVALID_IMAGE');
      return result;
    } else if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('PREVIEW_UNSUPPORTED_TYPE');
    else if (type[0] === type[0].toUpperCase()) fail('PREVIEW_INVALID_IMAGE');
    offset = end;
  }
  fail('PREVIEW_INVALID_IMAGE');
}

// JPEG marker layout: https://www.w3.org/Graphics/JPEG/itu-t81.pdf (Annex B).
function jpegDimensions(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('PREVIEW_INVALID_IMAGE');
  let offset = 2;
  let result;
  let scanSeen = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) fail('PREVIEW_INVALID_IMAGE');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!result || !scanSeen || offset !== bytes.length) fail('PREVIEW_INVALID_IMAGE');
      return result;
    }
    if (!marker || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > bytes.length) fail('PREVIEW_INVALID_IMAGE');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) fail('PREVIEW_INVALID_IMAGE');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (result || length < 11 || bytes[offset + 2] !== 8) fail('PREVIEW_INVALID_IMAGE');
      const components = bytes[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) fail('PREVIEW_INVALID_IMAGE');
      result = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) fail('PREVIEW_UNSUPPORTED_TYPE');
    if (marker === 0xda) {
      if (!result || length < 6 || length !== 6 + 2 * bytes[offset + 2]) fail('PREVIEW_INVALID_IMAGE');
      scanSeen = true;
      offset += length;
      // Entropy-coded bytes use FF00 escaping; restart markers carry no length.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        if (bytes[offset + 1] === 0 || bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7) { offset += 2; continue; }
        break;
      }
    } else offset += length;
  }
  fail('PREVIEW_INVALID_IMAGE');
}

// WebP: https://developers.google.com/speed/webp/docs/riff_container
function webpDimensions(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('PREVIEW_INVALID_IMAGE');
  let canvas;
  let image;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail('PREVIEW_INVALID_IMAGE');
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end + (length & 1) > bytes.length || length & 1 && bytes[end] !== 0) fail('PREVIEW_INVALID_IMAGE');
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || bytes[start] & 0xc1 || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) fail('PREVIEW_INVALID_IMAGE');
      if (bytes[start] & 2) fail('PREVIEW_UNSUPPORTED_TYPE');
      canvas = dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1);
    } else if (type === 'VP8 ') {
      if (image || length < 10 || bytes[start] & 1 || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) fail('PREVIEW_INVALID_IMAGE');
      image = dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff);
    } else if (type === 'VP8L') {
      if (image || length < 5 || bytes[start] !== 0x2f || bytes[start + 4] & 0xe0) fail('PREVIEW_INVALID_IMAGE');
      const bits = bytes.readUInt32LE(start + 1);
      image = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else if (type === 'ANIM' || type === 'ANMF') fail('PREVIEW_UNSUPPORTED_TYPE');
    offset = end + (length & 1);
  }
  if (!image || canvas && (canvas.width !== image.width || canvas.height !== image.height)) fail('PREVIEW_INVALID_IMAGE');
  return image;
}

function decodeText(bytes, truncated) {
  if (bytes.subarray(0, 4).toString('ascii') === '%PDF' || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]))) fail('PREVIEW_BINARY_TEXT');
  if (bytes.length >= 2 && (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) fail('PREVIEW_ENCODING_UNSUPPORTED');
  let text;
  try {
    // At a byte limit an unfinished final UTF-8 character is omitted, not replaced.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
  } catch { fail('PREVIEW_ENCODING_UNSUPPORTED'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) fail('PREVIEW_BINARY_TEXT');
  return text;
}

function createPreviewService({ getEntry, getIdentity, getScanContext, platform = process.platform, io = fs }) {
  async function preview(id) {
    if (!Number.isSafeInteger(id) || id < 1) fail('INVALID_ENTRY_ID');
    if (platform !== 'linux') fail('PREVIEW_PLATFORM_UNVERIFIED');
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) fail('PREVIEW_PLATFORM_UNVERIFIED');
    const context = getScanContext();
    if (!context?.scanId || typeof context.rootPath !== 'string') fail('NO_SCAN');
    const scan = { scanId: context.scanId, rootPath: context.rootPath };
    const entry = await getEntry(id);
    const expected = await getIdentity(id);
    const checkContext = () => {
      const current = getScanContext();
      if (current?.scanId !== scan.scanId || current?.rootPath !== scan.rootPath) fail('SCAN_CHANGED');
    };
    checkContext();
    if (!entry || !expected || entry.id !== id || expected.path !== entry.path || !inside(scan.rootPath, entry.path)) fail('NOT_IN_SCAN');
    if (entry.state !== 'ready') fail('SCAN_INCOMPLETE');
    if (entry.kind === 'symlink') fail('SYMLINK');
    if (entry.kind !== 'file') fail('NOT_REGULAR_FILE');
    if (expected.unsupportedPath) fail('UNSUPPORTED_PATH');
    if (['dev', 'ino', 'mode', 'size', 'nlink', 'mtimeNs', 'ctimeNs', 'parentRealPath', 'parentDev', 'parentIno'].some(key => expected[key] == null)) fail('SCAN_INCOMPLETE');
    if (!Number.isSafeInteger(expected.size) || expected.size < 0) fail('PREVIEW_TOO_LARGE');
    if (expected.nlink !== 1) fail('SHARED_FILE');
    const protectedReason = protectedPathReason(entry.path, { platform });
    if (protectedReason) fail(protectedReason);
    const extension = path.extname(entry.path).slice(1).toLowerCase();
    const mime = IMAGE_MIMES.get(extension);
    if (!mime && !TEXT_EXTENSIONS.has(extension)) fail('PREVIEW_UNSUPPORTED_TYPE');
    if (mime && expected.size > MAX_IMAGE_BYTES) fail('PREVIEW_TOO_LARGE');
    let handle;
    const verifyPath = async () => {
      checkContext();
      const parent = path.dirname(entry.path);
      const parentReal = await io.realpath(parent);
      if (parentReal !== expected.parentRealPath) fail('PARENT_CHANGED');
      if (parentReal !== parent || await io.realpath(scan.rootPath) !== scan.rootPath) fail('SYMLINK_PARENT');
      const parentStat = await io.lstat(parent, { bigint: true });
      if (!parentStat.isDirectory() || String(parentStat.dev) !== expected.parentDev || String(parentStat.ino) !== expected.parentIno) fail('PARENT_CHANGED');
      const stat = await io.lstat(entry.path, { bigint: true });
      if (stat.isSymbolicLink()) fail('SYMLINK');
      if (!stat.isFile()) fail('NOT_REGULAR_FILE');
      if (await io.realpath(entry.path) !== entry.path || !sameIdentity(expected, snapshot(stat, entry.path, parentReal, parentStat))) fail('IDENTITY_CHANGED');
      checkContext();
    };
    const verifyHandle = async () => {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || !sameIdentity(expected, snapshot(stat, entry.path, expected.parentRealPath))) fail('IDENTITY_CHANGED');
    };
    try {
      await verifyPath();
      await verifyVolume(io, entry.path);
      checkContext();
      handle = await io.open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      await verifyHandle();
      await verifyVolume(io, entry.path, handle);
      await verifyPath();
      const limit = mime ? expected.size : Math.min(expected.size, MAX_TEXT_BYTES);
      const bytes = Buffer.alloc(limit);
      let bytesRead = 0;
      while (bytesRead < limit) {
        checkContext();
        const read = await handle.read(bytes, bytesRead, limit - bytesRead, bytesRead);
        if (!read.bytesRead) fail('IDENTITY_CHANGED');
        bytesRead += read.bytesRead;
      }
      await verifyHandle();
      await verifyPath();
      await verifyVolume(io, entry.path, handle);
      checkContext();
      if (!mime) return { kind: 'text', text: decodeText(bytes, expected.size > bytesRead), truncated: expected.size > bytesRead, bytesRead, mime: 'text/plain', path: entry.path };
      const size = mime === 'image/png' ? pngDimensions(bytes) : mime === 'image/jpeg' ? jpegDimensions(bytes) : webpDimensions(bytes);
      return { kind: 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, mime, ...size, bytesRead, path: entry.path };
    } catch (error) {
      if (error.code === 'ELOOP') fail('SYMLINK');
      if (error.code === 'ENOENT') fail('MISSING_FILE');
      if (error.code === 'EACCES' || error.code === 'EPERM') fail('PERMISSION_DENIED');
      if (typeof error.code === 'string' && !/^E[A-Z]+$/.test(error.code)) throw error;
      fail('UNREADABLE_FILE');
    } finally { if (handle) await handle.close().catch(() => {}); }
  }
  return { preview };
}

module.exports = { createPreviewService, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS };
