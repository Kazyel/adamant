import assert from 'node:assert/strict';
import test from 'node:test';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { joinMarkdownSource, validatedMarkdownPrefix } from './markdownSource.ts';
import { createMarkdownState, readMarkdownSource } from './markdownState.ts';

const original = '\uFEFFa\r\nb\nc\rd\r\ne';

function createEditor(source: string) {
  const editor = {
    state: createMarkdownState(source),
    dispatch(transaction: Transaction) {
      editor.state = transaction.state;
    },
  };
  return editor;
}

await test('grouped newline edits undo and redo BOM and each original line ending', () => {
  const editor = createEditor(original);
  assert.equal(editor.state.doc.toString(), 'a\nb\nc\nd\ne');
  assert.equal(readMarkdownSource(editor.state), original);
  editor.dispatch(
    editor.state.update({
      changes: { from: 2, to: 7, insert: 'X\nY' },
      userEvent: 'input.type',
      annotations: Transaction.time.of(1000),
    }),
  );
  assert.equal(readMarkdownSource(editor.state), '\uFEFFa\r\nX\nY\r\ne');
  editor.dispatch(
    editor.state.update({
      changes: { from: 3, to: 4, insert: '\nZ\n' },
      userEvent: 'input.type',
      annotations: Transaction.time.of(1100),
    }),
  );
  const edited = '\uFEFFa\r\nX\nZ\nY\r\ne';
  assert.equal(readMarkdownSource(editor.state), edited);
  assert.equal(undo(editor), true);
  assert.equal(readMarkdownSource(editor.state), original);
  assert.equal(undo(editor), false);
  assert.equal(redo(editor), true);
  assert.equal(readMarkdownSource(editor.state), edited);
  assert.equal(redo(editor), false);
});

await test('simultaneous unequal ranges restore the original source on undo', () => {
  const editor = createEditor(original);
  editor.dispatch(
    editor.state.update({
      changes: [
        { from: 0, to: 1, insert: 'long first line' },
        { from: 2, to: 7, insert: '' },
        { from: 8, to: 9, insert: 'last' },
      ],
    }),
  );
  const edited = '\uFEFFlong first line\r\n\r\nlast';
  assert.equal(readMarkdownSource(editor.state), edited);
  assert.equal(undo(editor), true);
  assert.equal(readMarkdownSource(editor.state), original);
  assert.equal(redo(editor), true);
  assert.equal(readMarkdownSource(editor.state), edited);
});

await test('history stays reversible past 128 groups and discards the abandoned redo branch', () => {
  const editor = createEditor(original);
  for (let index = 0; index < 140; index++) {
    editor.dispatch(
      editor.state.update({
        changes: { from: index + 1, insert: 'x' },
        userEvent: 'input.type',
        annotations: isolateHistory.of('full'),
      }),
    );
  }
  const allEdits = '\uFEFFa' + 'x'.repeat(140) + '\r\nb\nc\rd\r\ne';
  assert.equal(readMarkdownSource(editor.state), allEdits);
  for (let index = 0; index < 140; index++) {
    assert.equal(undo(editor), true);
  }
  assert.equal(readMarkdownSource(editor.state), original);
  assert.equal(undo(editor), false);
  for (let index = 0; index < 140; index++) {
    assert.equal(redo(editor), true);
  }
  assert.equal(readMarkdownSource(editor.state), allEdits);
  assert.equal(redo(editor), false);
  for (let index = 0; index < 3; index++) {
    assert.equal(undo(editor), true);
  }
  const beforeBranch = '\uFEFFa' + 'x'.repeat(137) + '\r\nb\nc\rd\r\ne';
  assert.equal(readMarkdownSource(editor.state), beforeBranch);
  editor.dispatch(
    editor.state.update({
      changes: { from: 0, to: 1, insert: 'Z' },
      annotations: isolateHistory.of('full'),
    }),
  );
  const branched = '\uFEFFZ' + beforeBranch.slice(2);
  assert.equal(readMarkdownSource(editor.state), branched);
  assert.equal(redo(editor), false);
  assert.equal(undo(editor), true);
  assert.equal(readMarkdownSource(editor.state), beforeBranch);
  assert.equal(redo(editor), true);
  assert.equal(readMarkdownSource(editor.state), branched);
  assert.equal(redo(editor), false);
  assert.equal(readMarkdownSource(editor.state), branched);
});

await test('validated metadata survives replacing the entire body, including an EOF delimiter', () => {
  const prefix = '\uFEFF---\r\nid: note\nkind: markdown\r\n---\r\n';
  const body = 'one\r\ntwo\nthree';
  const source = prefix + body;
  const preserved = validatedMarkdownPrefix(source, prefix + 'previous body');
  assert.equal(preserved, prefix);
  assert.equal(validatedMarkdownPrefix(source), '');
  assert.equal(validatedMarkdownPrefix(source, source.replace('id: note', 'id: other')), '');
  const unclosed = '\uFEFF---\r\nid: note\nkind: markdown';
  assert.equal(validatedMarkdownPrefix(unclosed, unclosed), '');

  const editor = createEditor(source.slice(preserved.length));
  editor.dispatch(
    editor.state.update({
      changes: { from: 0, to: editor.state.doc.length, insert: '' },
      userEvent: 'input.type',
      annotations: Transaction.time.of(1000),
    }),
  );
  assert.equal(joinMarkdownSource(preserved, readMarkdownSource(editor.state)), prefix);
  editor.dispatch(
    editor.state.update({
      changes: { from: 0, insert: 'replacement' },
      userEvent: 'input.type',
      annotations: Transaction.time.of(1100),
    }),
  );
  assert.equal(
    joinMarkdownSource(preserved, readMarkdownSource(editor.state)),
    prefix + 'replacement',
  );
  assert.equal(undo(editor), true);
  assert.equal(joinMarkdownSource(preserved, readMarkdownSource(editor.state)), source);
  assert.equal(redo(editor), true);
  assert.equal(
    joinMarkdownSource(preserved, readMarkdownSource(editor.state)),
    prefix + 'replacement',
  );

  const eofPrefix = prefix.slice(0, -2);
  const preservedEof = validatedMarkdownPrefix(eofPrefix, eofPrefix);
  const empty = createEditor(eofPrefix.slice(preservedEof.length));
  empty.dispatch(empty.state.update({ changes: { from: 0, insert: 'body' } }));
  assert.equal(
    joinMarkdownSource(preservedEof, readMarkdownSource(empty.state)),
    eofPrefix + '\r\nbody',
  );
  assert.equal(undo(empty), true);
  assert.equal(joinMarkdownSource(preservedEof, readMarkdownSource(empty.state)), eofPrefix);
  assert.equal(redo(empty), true);
  assert.equal(
    joinMarkdownSource(preservedEof, readMarkdownSource(empty.state)),
    eofPrefix + '\r\nbody',
  );
  assert.equal(validatedMarkdownPrefix(eofPrefix + '\r\nbody', eofPrefix), prefix);
  assert.equal(validatedMarkdownPrefix(eofPrefix + '\nbody', eofPrefix), '');
  assert.equal(validatedMarkdownPrefix(eofPrefix + ' \r\nbody', eofPrefix), '');
});
