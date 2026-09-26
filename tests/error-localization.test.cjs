'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/errors.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const translations = import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('each published error has distinct Chinese and English text, including Electron-wrapped errors', async () => {
  const { errorText } = await translations;
  const codes = [...source.matchAll(/^  ([A-Z][A-Z_0-9]+): \[/gm)].map(match => match[1]);
  assert.ok(codes.length > 85);
  for (const code of new Set(codes)) {
    const zh = errorText(code, 'zh-CN'); const en = errorText(code, 'en');
    assert.match(zh, /[\u3400-\u9fff]/, code);
    assert.doesNotMatch(en, /[\u3400-\u9fff]/, code);
    assert.notEqual(zh, en, code);
    assert.equal(errorText(`Error invoking remote method 'diskharbor:test': Error: ${code}`, 'en'), en);
  }
});

test('unknown system messages have a localized fallback without exposing raw paths', async () => {
  const { errorText, rawError } = await translations;
  const raw = 'Unexpected failure at /home/synthetic/private/report.txt <script>bad()</script>';
  assert.doesNotMatch(errorText(raw, 'zh-CN'), /Unexpected|private|script/);
  assert.doesNotMatch(errorText(raw, 'en'), /private|script/);
  assert.equal(rawError(`Error invoking remote method 'test': Error: ${raw}`), raw);
});

test('preview permission and link errors describe preview instead of trash operations', async () => {
  const { previewErrorText } = await translations;
  for (const code of ['SYSTEM_PATH', 'HIDDEN_PATH', 'APPLICATION_DATA', 'SYMLINK', 'SHARED_FILE', 'UNSUPPORTED_VOLUME']) {
    assert.match(previewErrorText(code, 'zh-CN'), /预览/);
    assert.doesNotMatch(previewErrorText(code, 'en'), /trash/i);
  }
});
