import { type EditorState, Transaction } from '@codemirror/state';
import { isolateHistory, redo, redoDepth, selectAll, undo, undoDepth } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { UserAction } from '../interaction/types';

function clipboardUnavailable(method: 'readText' | 'writeText') {
  return typeof navigator.clipboard?.[method] === 'function'
    ? undefined
    : 'Clipboard access is unavailable. Use the keyboard shortcut.';
}

function hasSelection(state: EditorState) {
  return state.selection.ranges.some((range) => !range.empty);
}

function canApply(view: EditorView, before: EditorState) {
  return (
    view.dom.isConnected &&
    view.hasFocus &&
    !view.state.readOnly &&
    view.state.doc === before.doc &&
    view.state.selection.eq(before.selection)
  );
}

function replaceSelection(view: EditorView, text: string, event: string) {
  if (!view.dom.isConnected || view.state.readOnly) {
    return;
  }
  view.dispatch({
    ...view.state.replaceSelection(text),
    annotations: [Transaction.userEvent.of(event), isolateHistory.of('full')],
    scrollIntoView: true,
  });
}

async function copySelection(view: EditorView, cut: boolean) {
  const before = view.state;
  if (!hasSelection(before) || (cut && before.readOnly)) {
    return;
  }
  const text = before.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => before.sliceDoc(range.from, range.to))
    .join(before.lineBreak);
  await navigator.clipboard.writeText(text);
  if (!cut || !view.dom.isConnected) {
    return;
  }
  if (!canApply(view, before)) {
    throw new Error('Text was copied, but the editor changed. Nothing was cut.');
  }
  replaceSelection(view, '', 'delete.cut');
}

async function paste(view: EditorView) {
  const before = view.state;
  if (before.readOnly) {
    return;
  }
  const text = await navigator.clipboard.readText();
  if (!text || !view.dom.isConnected) {
    return;
  }
  if (!canApply(view, before)) {
    throw new Error('The editor changed while reading the clipboard. Paste again.');
  }
  replaceSelection(view, text, 'input.paste');
}

export function editorActions(view: EditorView, onError: (message: string) => void): UserAction[] {
  const readOnly = view.state.readOnly ? 'This document is read-only.' : undefined;
  const selection = hasSelection(view.state) ? undefined : 'Select text first.';
  const clipboardWrite = clipboardUnavailable('writeText');

  function command(run: (editor: EditorView) => boolean, editable = true) {
    return () => {
      if (view.dom.isConnected && (!editable || !view.state.readOnly)) {
        run(view);
        view.focus();
      }
    };
  }

  function clipboard(run: () => Promise<void>, shortcut: string) {
    return async () => {
      if (!view.dom.isConnected) {
        return;
      }
      try {
        await run();
      } catch (error) {
        if (view.dom.isConnected) {
          const message = error instanceof Error ? error.message : String(error);
          onError(`Clipboard action failed: ${message} You can also use ${shortcut}.`);
        }
      }
    };
  }

  return [
    {
      id: 'editor.undo',
      label: 'Undo',
      icon: 'back',
      group: 'History',
      shortcut: 'Ctrl+Z',
      disabled: readOnly ?? (undoDepth(view.state) ? undefined : 'Nothing to undo.'),
      run: command(undo),
    },
    {
      id: 'editor.redo',
      label: 'Redo',
      icon: 'forward',
      group: 'History',
      shortcut: 'Ctrl+Shift+Z',
      disabled: readOnly ?? (redoDepth(view.state) ? undefined : 'Nothing to redo.'),
      run: command(redo),
    },
    {
      id: 'editor.cut',
      label: 'Cut',
      icon: 'cut',
      group: 'Clipboard',
      shortcut: 'Ctrl+X',
      disabled: readOnly ?? selection ?? clipboardWrite,
      run: clipboard(() => copySelection(view, true), 'Ctrl+X'),
    },
    {
      id: 'editor.copy',
      label: 'Copy',
      icon: 'copy',
      group: 'Clipboard',
      shortcut: 'Ctrl+C',
      disabled: selection ?? clipboardWrite,
      run: clipboard(() => copySelection(view, false), 'Ctrl+C'),
    },
    {
      id: 'editor.paste',
      label: 'Paste',
      icon: 'paste',
      group: 'Clipboard',
      shortcut: 'Ctrl+V',
      disabled: readOnly ?? clipboardUnavailable('readText'),
      run: clipboard(() => paste(view), 'Ctrl+V'),
    },
    {
      id: 'editor.delete',
      label: 'Delete selection',
      icon: 'trash',
      group: 'Clipboard',
      shortcut: 'Delete',
      disabled: readOnly ?? selection,
      run: () => {
        if (hasSelection(view.state)) {
          replaceSelection(view, '', 'delete.selection');
        }
      },
    },
    {
      id: 'editor.select-all',
      label: 'Select all',
      icon: 'document',
      group: 'Selection',
      shortcut: 'Ctrl+A',
      disabled: view.state.doc.length ? undefined : 'The document is empty.',
      run: command(selectAll, false),
    },
  ];
}
