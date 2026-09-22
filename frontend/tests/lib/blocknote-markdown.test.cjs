const { afterEach, describe, mock, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const file = path.resolve(__dirname, '../../src/lib/blocknote-markdown.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const loaded = new Module(file, module);
loaded.filename = file;
loaded.paths = Module._nodeModulePaths(path.dirname(file));
loaded._compile(compiled.outputText, file);
const { blocksToMarkdownSafely } = loaded.exports;

describe('blocksToMarkdownSafely', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  test('returns markdown when conversion succeeds', async () => {
    const editor = {
      blocksToMarkdownLossy: mock.fn(async () => '# Summary'),
    };

    const result = await blocksToMarkdownSafely(editor, [], {
      source: 'test-success',
    });

    assert.deepEqual(result, {
      markdown: '# Summary',
      ok: true,
    });
    assert.equal(editor.blocksToMarkdownLossy.mock.calls.length, 1);
  });

  test('returns fallback markdown when conversion throws', async () => {
    const error = new Error('conversion failed');
    const editor = {
      blocksToMarkdownLossy: mock.fn(async () => {
        throw error;
      }),
    };
    const consoleError = mock.method(console, 'error');

    const result = await blocksToMarkdownSafely(editor, [{ id: 'block-1' }], {
      source: 'test-fallback',
      fallbackMarkdown: 'existing markdown',
    });

    assert.deepEqual(result, {
      markdown: 'existing markdown',
      ok: false,
    });
    assert.equal(consoleError.mock.calls.length, 1);
    assert.deepEqual(consoleError.mock.calls[0].arguments, [
      'Failed to convert BlockNote blocks to markdown',
      {
        source: 'test-fallback',
        blocksCount: 1,
        error,
      },
    ]);
  });

  test('omits markdown when conversion throws without fallback', async () => {
    const editor = {
      blocksToMarkdownLossy: mock.fn(async () => {
        throw new Error('conversion failed');
      }),
    };
    mock.method(console, 'error');

    const result = await blocksToMarkdownSafely(editor, [], {
      source: 'test-empty-fallback',
    });

    assert.deepEqual(result, {
      markdown: undefined,
      ok: false,
    });
  });
});
