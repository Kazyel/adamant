import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, KeyboardEvent } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder,
} from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { joinMarkdownSource, validatedMarkdownPrefix } from './markdownSource';
import { createMarkdownState, readMarkdownSource } from './markdownState';
import type { EditorPreferences } from '../interaction/types';
import { defaultEditorPreferences } from '../interaction/types';
import { ContextMenu } from '../interaction/ContextMenu';
import { OverlayPresence } from '../interaction/OverlayPresence';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import { editorActions } from './editorActions';
import { NoteLinkPicker } from './NoteLinks';
import { insertNoteLink } from './insertNoteLink';
import { resolveFontFamily } from '../../shared/styles/fontFamilies';

type EditorMenu = { view: EditorView; x: number; y: number };

const scrollFadeMask =
  'linear-gradient(to bottom, transparent calc(var(--scroll-fade-top) * .12), #000 var(--scroll-fade-top), #000 calc(100% - var(--scroll-fade-bottom)), transparent calc(100% - var(--scroll-fade-bottom) * .12))';

const theme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--text)',
      backgroundColor: 'var(--reading)',
      fontSize: '17px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      overflow: 'auto',
      scrollbarWidth: 'none',
      '--scroll-fade-top': '0px',
      '--scroll-fade-bottom': '0px',
    },
    '&[data-scroll-top] .cm-scroller': { '--scroll-fade-top': '56px' },
    '&[data-scroll-bottom] .cm-scroller': { '--scroll-fade-bottom': '56px' },
    '&[data-scroll-top] .cm-scroller, &[data-scroll-bottom] .cm-scroller': {
      maskImage: scrollFadeMask,
      '-webkit-mask-image': scrollFadeMask,
    },
    '.cm-scroller::-webkit-scrollbar': { display: 'none' },
    '.cm-content': { padding: '56px 0 24px', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 20px' },
    '.cm-placeholder': { color: 'var(--muted)', whiteSpace: 'pre-wrap' },
    '.cm-placeholder::first-line': {
      fontFamily: 'var(--heading-font)',
      color: 'var(--text)',
      fontSize: 'clamp(28px, 3vw, 40px)',
      fontWeight: '600',
      letterSpacing: '-0.025em',
      lineHeight: '1.5',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground': { backgroundColor: 'var(--raised)' },
    '&.cm-focused .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--selection)',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--surface)' },
    '.cm-searchMatch': {
      backgroundColor: 'var(--raised)',
      outline: '1px solid var(--border)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'var(--selection)',
      outline: '1px solid var(--accent)',
    },
    '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-button': {
      background: 'var(--surface)',
      color: 'var(--text)',
      border: '1px solid var(--border)',
    },
    '.cm-button:focus-visible': {
      outline: '1px solid var(--accent)',
    },
  },
  { dark: true },
);

const highlighting = HighlightStyle.define([
  { tag: [tags.heading, tags.keyword, tags.link], color: 'var(--accent)' },
  { tag: tags.strong, color: 'var(--text)', fontWeight: 'bold' },
  { tag: tags.emphasis, color: 'var(--text)', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.string, tags.url], color: 'var(--accent)' },
  { tag: tags.monospace, color: 'var(--text)', fontFamily: '"Adamant Mono", monospace' },
  { tag: [tags.comment, tags.meta, tags.processingInstruction], color: 'var(--muted)' },
]);
const editorMode = new Compartment();
const editorSettings = new Compartment();
const editorObservers = new Compartment();
const emptyPlaceholder = placeholder('A place to think.\nStart writing Markdown…');

function editingMode(readOnly: boolean) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    readOnly ? [] : emptyPlaceholder,
  ];
}

function settings(preferences: EditorPreferences) {
  return [
    preferences.wordWrap ? EditorView.lineWrapping : [],
    indentUnit.of(' '.repeat(preferences.indentSize)),
    EditorState.tabSize.of(preferences.indentSize),
    EditorView.theme({
      '.cm-scroller': {
        fontFamily: resolveFontFamily(preferences.editorFont ?? 'inter'),
        fontSize: `${preferences.fontSize}px`,
        lineHeight: '1.65',
      },
    }),
  ];
}

function columnOffset(text: string, column: number) {
  let offset = 0;
  let current = 1;
  for (const character of text) {
    if (current++ >= column) {
      break;
    }
    offset += character.length;
  }
  return offset;
}

export default function MarkdownEditor({
  initialValue,
  validatedSource,
  onChange,
  onStateChange,
  editorState,
  preferences = defaultEditorPreferences,
  location,
  onLocationChange,
  readOnly = false,
  focusOnOpen = false,
  noteLinkSource,
}: {
  initialValue: string;
  validatedSource?: string;
  onChange: (value: string) => void;
  onStateChange?: (state: EditorState) => void;
  editorState?: EditorState;
  preferences?: EditorPreferences;
  location?: { line: number; column: number };
  onLocationChange?: (line: number, column: number) => void;
  readOnly?: boolean;
  focusOnOpen?: boolean;
  noteLinkSource?: { path: string; expectedIdentity: string | null; vaultKey: string };
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<EditorMenu | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [linkSelection, setLinkSelection] = useState<EditorState | null>(null);
  function openNotePicker() {
    const view = editor.current;
    if (!noteLinkSource || !view || view.state.readOnly || readOnly) {
      return;
    }
    view.focus();
    setLinkSelection(view.state);
  }
  // The parent remounts on disk refresh/navigation. Metadata never enters select-all or undo.
  const [initial] = useState(() => {
    const prefix = validatedMarkdownPrefix(initialValue, validatedSource);
    return { prefix, body: initialValue.slice(prefix.length), readOnly };
  });
  const suppliedState = useRef(editorState);
  const prefix = useRef(initial.prefix);
  useLayoutEffect(() => {
    prefix.current = validatedMarkdownPrefix(initialValue, validatedSource);
  }, [initialValue, validatedSource]);
  const [initialPreferences] = useState(preferences);
  const mode = editorMode;
  const notifyChange = useEffectEvent((value: string) => onChange(value));
  const notifyState = useEffectEvent((state: EditorState) => onStateChange?.(state));
  const notifyLocation = useEffectEvent((line: number, column: number) =>
    onLocationChange?.(line + prefix.current.split('\n').length - 1, column),
  );

  const focusWhenReady = useEffectEvent((view: EditorView) => {
    if (focusOnOpen) {
      view.focus();
    }
  });

  function showMenu(view: EditorView, position?: { x: number; y: number }) {
    const caret = view.coordsAtPos(view.state.selection.main.head);
    const bounds = view.dom.getBoundingClientRect();
    setMenuError(null);
    setMenu({
      view,
      x: position?.x ?? caret?.left ?? bounds.left,
      y: position?.y ?? caret?.bottom ?? bounds.top,
    });
  }

  function preserveSelection(event: MouseEvent<HTMLDivElement>) {
    const view = editor.current;
    if (event.button !== 2 || !view?.scrollDOM.contains(event.target as Node)) {
      return;
    }
    event.preventDefault();
    if (view.state.selection.ranges.every((range) => range.empty)) {
      const anchor = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (anchor !== null) {
        view.dispatch({ selection: { anchor } });
      }
    }
    view.focus();
  }

  function openContextMenu(event: MouseEvent<HTMLDivElement>) {
    const view = editor.current;
    if (!view?.scrollDOM.contains(event.target as Node)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    showMenu(
      view,
      event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined,
    );
  }

  function openKeyboardMenu(event: KeyboardEvent<HTMLDivElement>) {
    const view = editor.current;
    if (
      view?.contentDOM.contains(event.target as Node) &&
      noteLinkSource &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'k'
    ) {
      event.preventDefault();
      event.stopPropagation();
      openNotePicker();
      return;
    }
    if (
      !view?.contentDOM.contains(event.target as Node) ||
      !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    showMenu(view);
  }

  useLayoutEffect(() => {
    const extensions = [
      markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
      syntaxHighlighting(highlighting),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorState.allowMultipleSelections.of(true),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown source editor' }),
      EditorView.scrollMargins.of(() => ({ top: 56, bottom: 56 })),
      mode.of(editingMode(initial.readOnly)),
      theme,
      editorSettings.of(settings(initialPreferences)),
      editorObservers.of([]),
    ];
    const observer = EditorView.updateListener.of((update) => {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.state.readOnly !== update.startState.readOnly
      ) {
        setMenu(null);
      }
      if (update.docChanged) {
        notifyChange(joinMarkdownSource(prefix.current, readMarkdownSource(update.state)));
      }
      if (update.state !== update.startState) {
        notifyState(update.state);
      }
      if (update.docChanged || update.selectionSet) {
        const line = update.state.doc.lineAt(update.state.selection.main.head);
        const offset = update.state.selection.main.head - line.from;
        let units = 0;
        let column = 1;
        for (const character of line.text) {
          if (units >= offset) {
            break;
          }
          units += character.length;
          column++;
        }
        notifyLocation(line.number, column);
      }
    });
    const state = suppliedState.current ?? createMarkdownState(initial.body, extensions);
    const instance = new EditorView({
      parent: container.current!,
      state: state.update({
        effects: [
          mode.reconfigure(editingMode(initial.readOnly)),
          editorObservers.reconfigure(observer),
        ],
      }).state,
    });
    editor.current = instance;
    focusWhenReady(instance);

    const updateScrollEdges = () =>
      instance.requestMeasure({
        key: instance,
        read: ({ scrollDOM }) => ({
          top: scrollDOM.clientHeight > 0 && scrollDOM.scrollTop > 1,
          bottom:
            scrollDOM.clientHeight > 0 &&
            scrollDOM.scrollHeight - scrollDOM.clientHeight - scrollDOM.scrollTop > 1,
        }),
        write: (edges, view) => {
          view.dom.toggleAttribute('data-scroll-top', edges.top);
          view.dom.toggleAttribute('data-scroll-bottom', edges.bottom);
        },
      });
    const resizeObserver = new ResizeObserver(updateScrollEdges);
    resizeObserver.observe(instance.scrollDOM);
    resizeObserver.observe(instance.contentDOM);
    instance.scrollDOM.addEventListener('scroll', updateScrollEdges, { passive: true });
    updateScrollEdges();

    return () => {
      resizeObserver.disconnect();
      instance.scrollDOM.removeEventListener('scroll', updateScrollEdges);
      instance.destroy();
      editor.current = null;
    };
  }, [initial, initialPreferences, mode]);
  useLayoutEffect(() => {
    editor.current?.dispatch({
      effects: mode.reconfigure(editingMode(readOnly)),
    });
  }, [mode, readOnly]);
  useEffect(() => {
    const view = editor.current;
    if (!view) {
      return;
    }
    view.dispatch({ effects: editorSettings.reconfigure(settings(preferences)) });
    const family = resolveFontFamily(preferences.editorFont ?? 'inter');
    let disposed = false;
    void Promise.all(
      ['400', '700', 'italic 400', 'italic 700'].map((style) =>
        document.fonts.load(`${style} ${preferences.fontSize}px ${family}`),
      ),
    ).then(() => {
      if (!disposed) {
        view.requestMeasure();
      }
    });
    return () => {
      disposed = true;
    };
  }, [preferences]);

  useEffect(() => {
    const view = editor.current;
    if (!view || !location) {
      return;
    }
    const prefixLines = prefix.current.split('\n').length - 1;
    const line = view.state.doc.line(
      Math.max(1, Math.min(view.state.doc.lines, location.line - prefixLines)),
    );
    const anchor = line.from + columnOffset(line.text, location.column);
    if (view.state.selection.main.head !== anchor) {
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
    }
  }, [initial.prefix, location]);

  return (
    <>
      {menuError ? (
        <div className="workbench-notice error editor-action-notice" role="alert">
          <span>{menuError}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss clipboard error"
            onClick={() => setMenuError(null)}
          >
            <WorkspaceIcon name="close" />
          </button>
        </div>
      ) : null}
      <div
        className="editor-container"
        role="presentation"
        ref={container}
        onMouseDownCapture={preserveSelection}
        onContextMenu={openContextMenu}
        onKeyDownCapture={openKeyboardMenu}
      />
      <OverlayPresence>
        {menu ? (
          <ContextMenu
            actions={editorActions(menu.view, setMenuError)}
            position={menu}
            label="Editor actions"
            returnFocus={menu.view.contentDOM}
            onClose={() => setMenu(null)}
          />
        ) : null}
      </OverlayPresence>
      <OverlayPresence>
        {linkSelection && noteLinkSource ? (
          <NoteLinkPicker
            {...noteLinkSource}
            onClose={() => setLinkSelection(null)}
            onSelect={(target) => {
              const view = editor.current;
              if (
                !view ||
                !view.dom.isConnected ||
                readOnly ||
                view.state.readOnly ||
                view.state.doc !== linkSelection.doc ||
                !view.state.selection.eq(linkSelection.selection)
              ) {
                setLinkSelection(null);
                setMenuError('The editor changed while choosing a note. Insert the link again.');
                return;
              }
              view.dispatch(
                insertNoteLink(view.state, noteLinkSource.path, target.path, target.title),
              );
              setLinkSelection(null);
              view.focus();
            }}
          />
        ) : null}
      </OverlayPresence>
    </>
  );
}
