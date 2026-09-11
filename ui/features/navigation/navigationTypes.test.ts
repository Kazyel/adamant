import assert from 'node:assert/strict';
import test from 'node:test';
import { relativeMarkdownLink, resolveMarkdownLink, unicodeLocation } from './navigationTypes.ts';

void test('Markdown links encode path, Unicode and fragment segments', () => {
  assert.equal(
    relativeMarkdownLink('notes/日本語.md', 'assets/a b.md', '見出し'),
    '../assets/a%20b.md#%E8%A6%8B%E5%87%BA%E3%81%97',
  );
});

void test('Generated document links resolve encoded filenames and fragments from nested notes', () => {
  const from = 'notes/日本語.md';
  const to = 'assets/a #?.md';
  assert.deepEqual(resolveMarkdownLink(from, relativeMarkdownLink(from, to, '見出し')), {
    path: to,
    anchor: '#%E8%A6%8B%E5%87%BA%E3%81%97',
  });
});

void test('Root-relative links ignore the source directory and work in unsaved notes', () => {
  assert.deepEqual(resolveMarkdownLink('notes/source.md', '/assets/target.md'), {
    path: 'assets/target.md',
    anchor: '',
  });
  assert.deepEqual(resolveMarkdownLink(null, '/'), { path: '', anchor: '' });
});

void test('External and malformed destinations are not interpreted as Vault paths', () => {
  for (const href of [
    'https://example.com/a.md',
    '//example.com/a.md',
    'file:///tmp/a.md',
    '%ZZ',
  ]) {
    assert.throws(() => resolveMarkdownLink('notes/source.md', href));
  }
});

void test('Unicode locations count source characters rather than UTF-16 code units', () => {
  assert.deepEqual(unicodeLocation('a😀\n日本語', 3), { line: 1, column: 3 });
  assert.deepEqual(unicodeLocation('a😀\n日本語', 4), { line: 2, column: 1 });
});
