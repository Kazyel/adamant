import assert from 'node:assert/strict';
import test from 'node:test';
import { MarkdownSourceHistory } from '../src/markdownSource.ts';

const original = '\uFEFFa\r\nb\nc\rd\r\ne';
const range = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => ({ startLineNumber, startColumn, endLineNumber, endColumn });

test('grouped undo and redo restore BOM and each original line ending', () => {
  const history = new MarkdownSourceHistory(original, 1);
  assert.equal(history.apply([{ range: range(1, 1, 1, 2), text: 'A' }], 2, 'edit'), '\uFEFFA\r\nb\nc\rd\r\ne');
  const edited = '\uFEFFA\r\nX\nY\r\ne';
  assert.equal(history.apply([{ range: range(2, 1, 4, 2), text: 'X\nY' }], 3, 'edit'), edited);
  // Monaco can merge several content events into a single undo/redo event.
  assert.equal(history.apply([], 1, 'undo'), original);
  assert.equal(history.apply([], 3, 'redo'), edited);
});

test('simultaneous unequal ranges invert in the opposite order', () => {
  const history = new MarkdownSourceHistory(original, 1);
  const edited = history.apply([
    { range: range(1, 1, 1, 2), text: 'long first line' },
    { range: range(2, 1, 4, 2), text: '' },
    { range: range(5, 1, 5, 2), text: 'last' },
  ], 2, 'edit');
  assert.equal(edited, '\uFEFFlong first line\r\n\r\nlast');
  assert.equal(history.apply([], 1, 'undo'), original);
  assert.equal(history.apply([], 2, 'redo'), edited);
});

test('history stays reversible past 128 groups and discards the abandoned redo branch', () => {
  const history = new MarkdownSourceHistory(original, 1);
  for (let index = 0; index < 140; index++) {
    history.apply([{ range: range(1, index + 2, 1, index + 2), text: 'x' }], index + 2, 'edit');
  }
  const allEdits = '\uFEFFa' + 'x'.repeat(140) + '\r\nb\nc\rd\r\ne';
  assert.equal(history.source, allEdits);
  for (let version = 140; version >= 1; version--) history.apply([], version, 'undo');
  assert.equal(history.source, original);
  for (let version = 2; version <= 141; version++) history.apply([], version, 'redo');
  assert.equal(history.source, allEdits);
  const beforeBranch = '\uFEFFa' + 'x'.repeat(137) + '\r\nb\nc\rd\r\ne';
  assert.equal(history.apply([], 138, 'undo'), beforeBranch);
  const branched = '\uFEFFZ' + beforeBranch.slice(2);
  assert.equal(history.apply([{ range: range(1, 1, 1, 2), text: 'Z' }], 500, 'edit'), branched);
  assert.equal(history.apply([], 138, 'undo'), beforeBranch);
  assert.equal(history.apply([], 500, 'redo'), branched);
  assert.equal(history.apply([], 141, 'redo'), null);
  assert.equal(history.source, branched);
});
