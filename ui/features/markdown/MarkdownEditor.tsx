import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
} from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { joinMarkdownSource, validatedMarkdownPrefix } from './markdownSource';
import { createMarkdownState, readMarkdownSource } from './markdownState';

const theme = EditorView.theme(
  {
    '&': { height: '100%', color: '#E8E6ED', backgroundColor: '#212129', fontSize: '17px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: '"Adamant Sans", sans-serif',
      lineHeight: '27px',
    },
    '.cm-content': { padding: '56px 0 24px', caretColor: '#BEA2F8' },
    '.cm-line': { padding: '0 20px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#BEA2F8' },
    '.cm-selectionBackground': { backgroundColor: '#BEA2F81A' },
    '&.cm-focused .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#BEA2F833',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '&.cm-focused .cm-activeLine': { backgroundColor: '#FFFFFF03' },
    '.cm-searchMatch': { backgroundColor: '#BEA2F826' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#BEA2F84D' },
    '.cm-panels': { backgroundColor: '#242431', color: '#E8E6ED' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid #544F5F' },
    '.cm-textfield': { backgroundColor: '#191924', color: '#E8E6ED', border: '1px solid #544F5F' },
    '.cm-button': { background: '#242431', color: '#E8E6ED', border: '1px solid #544F5F' },
  },
  { dark: true },
);

const highlighting = HighlightStyle.define([
  { tag: [tags.heading, tags.keyword, tags.link], color: '#BEA2F8' },
  { tag: tags.strong, color: '#F1EFF6', fontWeight: 'bold' },
  { tag: tags.emphasis, color: '#DBD6E6', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.string, tags.url], color: '#D6C09B' },
  { tag: tags.monospace, color: '#DBD6E6', fontFamily: '"Adamant Mono", monospace' },
  { tag: [tags.comment, tags.meta, tags.processingInstruction], color: '#A7A3B0' },
]);

export default function MarkdownEditor({
  initialValue,
  validatedSource,
  onChange,
  readOnly = false,
}: {
  initialValue: string;
  validatedSource?: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  // The parent remounts on disk refresh/navigation. Metadata never enters select-all or undo.
  const [initial] = useState(() => {
    const prefix = validatedMarkdownPrefix(initialValue, validatedSource);
    return { prefix, body: initialValue.slice(prefix.length), readOnly };
  });
  const [mode] = useState(() => new Compartment());
  const notifyChange = useEffectEvent((value: string) => onChange(value));

  useEffect(() => {
    const instance = new EditorView({
      parent: container.current!,
      state: createMarkdownState(initial.body, [
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
        syntaxHighlighting(highlighting),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        dropCursor(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown source editor' }),
        mode.of([
          EditorState.readOnly.of(initial.readOnly),
          EditorView.editable.of(!initial.readOnly),
        ]),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            notifyChange(joinMarkdownSource(initial.prefix, readMarkdownSource(update.state)));
          }
        }),
      ]),
    });
    editor.current = instance;

    let disposed = false;
    void Promise.all([
      document.fonts.load('400 17px "Adamant Sans"'),
      document.fonts.load('700 17px "Adamant Sans"'),
      document.fonts.load('italic 17px "Adamant Sans"'),
    ]).then(() => {
      if (!disposed) {
        instance.requestMeasure();
      }
    });

    return () => {
      disposed = true;
      instance.destroy();
      editor.current = null;
    };
  }, [initial, mode]);

  useLayoutEffect(() => {
    editor.current?.dispatch({
      effects: mode.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [mode, readOnly]);

  return <div className="editor-container" ref={container} />;
}
