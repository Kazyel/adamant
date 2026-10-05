import { EditorSelection, type EditorState, Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { relativeMarkdownLink } from '../navigation/navigationTypes.ts';

/** A single undo step, through the same source-preserving history as ordinary typing. */
export function insertNoteLink(state: EditorState, from: string, to: string, title: string) {
  const destination = relativeMarkdownLink(from, to);
  return state.update({
    ...state.changeByRange((range) => {
      const label = (state.sliceDoc(range.from, range.to) || title)
        .replace(/\s+/g, ' ')
        .replace(/[\\`*_{}[\]()#+.!<>|~&-]/g, '\\$&');
      const insert = `[${label}](${destination})`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    }),
    annotations: [Transaction.userEvent.of('input.note-link'), isolateHistory.of('full')],
    scrollIntoView: true,
  });
}
