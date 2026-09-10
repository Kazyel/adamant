import { history, invertedEffects } from '@codemirror/commands';
import {
  ChangeSet,
  type ChangeSpec,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  Text,
} from '@codemirror/state';

const endingTags: Record<string, string> = { '\r\n': 'c', '\r': 'r', '\n': 'n' };
const tagEndings: Record<string, string> = { c: '\r\n', r: '\r', n: '\n', '': '' };

// Every document edit enters history; disk updates remount the editor. These
// persistent ending maps share unchanged branches and need no position mapping.
const restoreEndings = StateEffect.define<Text>();

const rawSource = StateField.define<{ bom: string; endings: Text }>({
  create: () => ({ bom: '', endings: Text.empty }),
  update(value, transaction) {
    // Grouped history stores inverse effects newest first, so the oldest wins.
    for (let index = transaction.effects.length - 1; index >= 0; index--) {
      const effect = transaction.effects[index];
      if (effect.is(restoreEndings)) {
        return { ...value, endings: effect.value };
      }
    }
    if (!transaction.docChanged) {
      return value;
    }

    let changes: ChangeSpec[] | undefined;
    const document = transaction.startState.doc;
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (fromA === toA && inserted.lines === 1) {
        return;
      }
      const from = document.lineAt(fromA).number - 1;
      const to = fromA === toA ? from : document.lineAt(toA).number - 1;
      if (from === to && inserted.lines === 1) {
        return;
      }
      // Each break is a one-character tag plus LF, so its offset is index * 2.
      (changes ??= []).push({
        from: from * 2,
        to: to * 2,
        insert: 'n\n'.repeat(inserted.lines - 1),
      });
    });
    return changes
      ? { ...value, endings: ChangeSet.of(changes, value.endings.length).apply(value.endings) }
      : value;
  },
  provide: (field) =>
    invertedEffects.of((transaction) => {
      const before = transaction.startState.field(field).endings;
      return before === transaction.state.field(field).endings ? [] : [restoreEndings.of(before)];
    }),
});

export function createMarkdownState(source: string, extensions: Extension[] = []): EditorState {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const tags = Array.from(source.matchAll(/\r\n|\r|\n/g), ([ending]) => endingTags[ending]);
  // A trailing empty line keeps every ending tag at a fixed-width Text offset.
  tags.push('');
  const initial = { bom, endings: Text.of(tags) };
  return EditorState.create({
    doc: source.slice(bom.length),
    extensions: [rawSource.init(() => initial), history({ minDepth: 200 }), extensions],
  });
}

export function readMarkdownSource(state: EditorState): string {
  const metadata = state.field(rawSource);
  const endings = metadata.endings.iterLines();
  let source = metadata.bom;
  for (const line of state.doc.iterLines()) {
    source += line + tagEndings[endings.next().value];
  }
  return source;
}
