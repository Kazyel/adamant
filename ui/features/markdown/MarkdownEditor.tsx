import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import {
  joinMarkdownSource,
  MarkdownSourceHistory,
  validatedMarkdownPrefix,
} from './markdownSource';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.editor.defineTheme('adamant', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'E8E6ED' },
    { token: 'keyword', foreground: 'BEA2F8' },
    { token: 'strong', foreground: 'F1EFF6', fontStyle: 'bold' },
    { token: 'emphasis', foreground: 'DBD6E6', fontStyle: 'italic' },
    { token: 'string', foreground: 'D6C09B' },
    { token: 'string.link', foreground: 'BEA2F8' },
    { token: 'variable', foreground: 'D6C09B' },
    { token: 'variable.source', foreground: 'DBD6E6' },
    { token: 'comment', foreground: 'A7A3B0' },
    { token: 'tag', foreground: 'BEA2F8' },
    { token: 'delimiter', foreground: 'A7A3B0' },
  ],
  colors: {
    'editor.background': '#212129',
    'editor.foreground': '#E8E6ED',
    'editorCursor.foreground': '#BEA2F8',
    'editorLineNumber.foreground': '#746E7C',
    'editorLineNumber.activeForeground': '#A7A3B0',
    'editor.selectionBackground': '#BEA2F833',
    'editor.inactiveSelectionBackground': '#BEA2F81A',
    'editor.selectionHighlightBackground': '#BEA2F81A',
    'editor.lineHighlightBackground': '#FFFFFF03',
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': '#3F3F4A',
    'editorWhitespace.foreground': '#3F3F4A',
    'editorGutter.background': '#212129',
    'editorWidget.background': '#242431',
    'editorWidget.border': '#544F5F',
    'editorWidget.foreground': '#E8E6ED',
    'editor.findMatchBackground': '#BEA2F84D',
    'editor.findMatchHighlightBackground': '#BEA2F826',
    'editorError.foreground': '#EAA7A7',
    'editorWarning.foreground': '#D6C09B',
    'input.background': '#191924',
    'input.foreground': '#E8E6ED',
    'input.border': '#544F5F',
    focusBorder: '#BEA2F8',
    'scrollbarSlider.background': '#A7A3B026',
    'scrollbarSlider.hoverBackground': '#A7A3B047',
    'scrollbarSlider.activeBackground': '#BEA2F866',
  },
});

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
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Keep validated metadata outside Monaco, including select-all and undo history.
  const [initial] = useState(() => {
    const prefix = validatedMarkdownPrefix(initialValue, validatedSource);
    return { prefix, body: initialValue.slice(prefix.length), readOnly };
  });
  const notifyChange = useEffectEvent((value: string) => onChange(value));
  const [historyNotice, setHistoryNotice] = useState(false);

  useEffect(() => {
    const model = monaco.editor.createModel(initial.body, 'markdown');
    const instance = monaco.editor.create(container.current!, {
      model,
      readOnly: initial.readOnly,
      theme: 'adamant',
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: '"Adamant Sans", sans-serif',
      fontSize: 17,
      lineHeight: 27,
      fontLigatures: false,
      disableMonospaceOptimizations: true,
      padding: { top: 56, bottom: 24 },
      lineNumbers: 'off',
      lineDecorationsWidth: 20,
      glyphMargin: false,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      ariaLabel: 'Markdown source editor',
      tabFocusMode: true,
      renderLineHighlight: 'line',
      renderLineHighlightOnlyWhenFocus: true,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      folding: false,
      links: false,
      contextmenu: false,
    });
    editor.current = instance;
    let history = new MarkdownSourceHistory(initial.body, model.getAlternativeVersionId());
    let resetting = false;
    const listener = model.onDidChangeContent((event) => {
      if (resetting) {
        return;
      }
      let direction: 'edit' | 'undo' | 'redo' = 'edit';
      if (event.isUndoing) {
        direction = 'undo';
      } else if (event.isRedoing) {
        direction = 'redo';
      }
      const source = history.apply(event.changes, model.getAlternativeVersionId(), direction);
      if (source === null) {
        // Keep the editor and the save buffer aligned if an unexpected model reset
        // invalidates history. Never submit normalized undo text as original source.
        resetting = true;
        model.setValue(history.source);
        resetting = false;
        history = new MarkdownSourceHistory(history.source, model.getAlternativeVersionId());
        setHistoryNotice(true);
        return;
      }
      setHistoryNotice(false);
      notifyChange(joinMarkdownSource(initial.prefix, source));
    });
    // Webfont arrival changes glyph widths; invalidate Monaco's cached measurements.
    let disposed = false;
    void Promise.all([
      document.fonts.load('400 17px "Adamant Sans"'),
      document.fonts.load('700 17px "Adamant Sans"'),
      document.fonts.load('italic 17px "Adamant Sans"'),
    ]).then(() => {
      if (!disposed) {
        monaco.editor.remeasureFonts();
      }
    });
    return () => {
      disposed = true;
      listener.dispose();
      instance.dispose();
      model.dispose();
      editor.current = null;
    };
  }, [initial]);

  useLayoutEffect(() => {
    editor.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return (
    <>
      {historyNotice ? (
        <div role="alert">
          The editor history was reset to protect the original source. The last operation was not
          applied; your Markdown buffer is unchanged.
        </div>
      ) : null}
      <div className="editor-container" ref={container} />
    </>
  );
}
