import assert from 'node:assert/strict';
import test from 'node:test';
import { redo, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import { marked } from 'marked';
import { createMarkdownState, readMarkdownSource } from './markdownState.ts';
import { insertNoteLink } from './insertNoteLink.ts';
import { resolveMarkdownLink } from '../navigation/navigationTypes.ts';

void test('note insertion escapes labels and filenames and remains one reversible source-preserving edit', () => {
  const source = '\uFEFFBefore\r\n[auth]*\nAfter\r\n';
  const editor = {
    state: createMarkdownState(source),
    dispatch(transaction: Transaction) {
      editor.state = transaction.state;
    },
  };
  editor.dispatch(editor.state.update({ selection: { anchor: 7, head: 14 } }));
  const target = 'research/OAuth (v2) #日本語.md';
  editor.dispatch(insertNoteLink(editor.state, 'notes/decision.md', target, 'Unused title'));
  const edited = readMarkdownSource(editor.state);
  assert.ok(edited.startsWith('\uFEFFBefore\r\n'));
  assert.ok(edited.endsWith('\nAfter\r\n'));
  const links: string[] = [];
  void marked.walkTokens(marked.lexer(edited), (token) => {
    if (token.type === 'link') {
      links.push(token.href);
    }
  });
  assert.equal(links.length, 1);
  assert.equal(resolveMarkdownLink('notes/decision.md', links[0]).path, target);
  assert.match(edited, /\\\[auth\\\]\\\*/);
  assert.equal(undo(editor), true);
  assert.equal(readMarkdownSource(editor.state), source);
  assert.equal(redo(editor), true);
  assert.equal(readMarkdownSource(editor.state), edited);
});

void test('each selection gets its own label and empty cursors use the target title', () => {
  let state = createMarkdownState('one two', [EditorState.allowMultipleSelections.of(true)]);
  state = state.update({
    selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.cursor(7)]),
  }).state;
  state = insertNoteLink(state, 'source.md', 'target.md', '<Target>&copy;').state;
  assert.equal(state.doc.toString(), '[one](target.md) two[\\<Target\\>\\&copy;](target.md)');
  assert.equal(state.selection.ranges.length, 2);
});
