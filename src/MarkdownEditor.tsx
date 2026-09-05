import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

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

export default function MarkdownEditor({ initialValue, onChange }: { initialValue: string; onChange: (value: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const initial = useRef(initialValue);

  useEffect(() => {
    const model = monaco.editor.createModel(initial.current, 'markdown');
    const instance = monaco.editor.create(container.current!, {
      model,
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
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      ariaLabel: 'Unsaved Markdown buffer',
      tabFocusMode: true,
      renderLineHighlight: 'line',
      renderLineHighlightOnlyWhenFocus: true,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      folding: false,
      links: false,
      contextmenu: false,
    });
    const listener = model.onDidChangeContent(() => change.current(model.getValue()));
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
    };
  }, []);

  return <div className="editor-container" ref={container} />;
}
