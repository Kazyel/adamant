import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { MarkdownSourceHistory } from './markdownSource';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.editor.defineTheme('adamant', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'E6E4EC' },
    { token: 'keyword', foreground: 'B99AF7' },
    { token: 'strong', foreground: 'F0EEF5', fontStyle: 'bold' },
    { token: 'emphasis', foreground: 'D8D2E4', fontStyle: 'italic' },
    { token: 'string', foreground: 'D2BB93' },
    { token: 'string.link', foreground: 'B99AF7' },
    { token: 'variable', foreground: 'D2BB93' },
    { token: 'variable.source', foreground: 'D8D2E4' },
    { token: 'comment', foreground: 'A09BA9' },
    { token: 'tag', foreground: 'B99AF7' },
    { token: 'delimiter', foreground: 'A09BA9' },
  ],
  colors: {
    'editor.background': '#101014',
    'editor.foreground': '#E6E4EC',
    'editorCursor.foreground': '#B99AF7',
    'editorLineNumber.foreground': '#686370',
    'editorLineNumber.activeForeground': '#A09BA9',
    'editor.selectionBackground': '#B99AF733',
    'editor.inactiveSelectionBackground': '#B99AF71A',
    'editor.selectionHighlightBackground': '#B99AF71A',
    'editor.lineHighlightBackground': '#FFFFFF03',
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': '#303039',
    'editorWhitespace.foreground': '#303039',
    'editorGutter.background': '#101014',
    'editorWidget.background': '#15151C',
    'editorWidget.border': '#46424F',
    'editorWidget.foreground': '#E6E4EC',
    'editor.findMatchBackground': '#B99AF74D',
    'editor.findMatchHighlightBackground': '#B99AF726',
    'editorError.foreground': '#E8A0A0',
    'editorWarning.foreground': '#D2BB93',
    'input.background': '#09090D',
    'input.foreground': '#E6E4EC',
    'input.border': '#46424F',
    'focusBorder': '#B99AF7',
    'scrollbarSlider.background': '#A09BA926',
    'scrollbarSlider.hoverBackground': '#A09BA947',
    'scrollbarSlider.activeBackground': '#B99AF766',
  },
});


export default function MarkdownEditor({ initialValue, onChange, readOnly = false }: { initialValue: string; onChange: (value: string) => void; readOnly?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const initial = useRef(initialValue);
  const change = useRef(onChange);
  change.current = onChange;
  const [historyNotice, setHistoryNotice] = useState(false);

  useEffect(() => {
    const model = monaco.editor.createModel(initial.current, 'markdown');
    const instance = monaco.editor.create(container.current!, {
      model,
      readOnly,
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
    let history = new MarkdownSourceHistory(initial.current, model.getAlternativeVersionId());
    let resetting = false;
    const listener = model.onDidChangeContent((event) => {
      if (resetting) return;
      let direction: 'edit' | 'undo' | 'redo' = 'edit';
      if (event.isUndoing) direction = 'undo';
      else if (event.isRedoing) direction = 'redo';
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
      change.current(source);
    });
    // Webfont arrival changes glyph widths; invalidate Monaco's cached measurements.
    let disposed = false;
    void Promise.all([
      document.fonts.load('400 17px "Adamant Sans"'),
      document.fonts.load('700 17px "Adamant Sans"'),
      document.fonts.load('italic 17px "Adamant Sans"'),
    ]).then(() => {
      if (!disposed) monaco.editor.remeasureFonts();
    });
    return () => {
      disposed = true;
      listener.dispose();
      instance.dispose();
      model.dispose();
      editor.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    editor.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <>{historyNotice ? <div role="alert">The editor history was reset to protect the original source. The last operation was not applied; your Markdown buffer is unchanged.</div> : null}<div className="editor-container" ref={container} /></>;
}
