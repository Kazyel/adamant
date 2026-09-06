import { Component, Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Connections from './Connections';
import Atmosphere from './Atmosphere';
import WorkspaceIcon from './WorkspaceIcon';
import { errorMessage } from './document';
import type { SelectedDocument } from './document';

const MarkdownEditor = lazy(() => import('./MarkdownEditor'));
const MarkdownPreview = lazy(() => import('./MarkdownPreview'));
const PdfViewer = lazy(() => import('./PdfViewer'));
const DocxViewer = lazy(() => import('./DocxViewer'));
const native = isTauri();
const desktopWindow = native ? getCurrentWindow() : null;
type OpenedDocument = Omit<SelectedDocument, 'bytes'> & { bytes: Uint8Array; revision: number };
type BufferSource = Pick<SelectedDocument, 'name' | 'path'>;

class ViewerBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: unknown) { return { error: errorMessage(error) }; }
  render() {
    return this.state.error
      ? <div className="viewer-message error" role="alert"><h3>Component could not start</h3><p>{this.state.error}</p><p>Check the desktop runtime and bundled resources before continuing.</p></div>
      : this.props.children;
  }
}

export default function App() {
  const [section, setSection] = useState<'workbench' | 'connections'>('workbench');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [view, setView] = useState<'edit' | 'read' | 'split'>('edit');
  const [buffer, setBuffer] = useState('');
  const [bufferRevision, setBufferRevision] = useState(0);
  const [bufferSource, setBufferSource] = useState<BufferSource | null>(null);
  const currentBuffer = useRef(buffer);
  currentBuffer.current = buffer;
  const [selected, setSelected] = useState<OpenedDocument | null>(null);
  const [preview, setPreview] = useState<'markdown' | 'document'>('markdown');
  const [opening, setOpening] = useState(false);
  const [externalOpening, setExternalOpening] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<{ document: OpenedDocument; text: string } | null>(null);
  const replaceDialog = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);

  useEffect(() => {
    if (pending) replaceDialog.current?.showModal();
  }, [pending]);

  async function openDocument() {
    setOpening(true);
    setNotice(null);
    try {
      const picked = await invoke<SelectedDocument | null>('pick_document');
      if (!picked) return;
      const document: OpenedDocument = { ...picked, bytes: Uint8Array.from(picked.bytes), revision: ++revision.current };
      if (document.kind === 'markdown') {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(document.bytes);
        if (currentBuffer.current.length && currentBuffer.current !== text) {
          setPending({ document, text });
          return;
        }
        setBuffer(text);
        setBufferSource({ name: document.name, path: document.path });
        setBufferRevision((value) => value + 1);
        setPreview('markdown');
        setView('edit');
      } else {
        setPreview('document');
        setView('read');
      }
      setSelected(document);
      setSection('workbench');
    } catch (error) {
      setNotice({ error: true, text: errorMessage(error) });
    } finally {
      setOpening(false);
    }
  }

  const readingDocument = view !== 'edit' && preview === 'document' && selected?.kind !== 'markdown' ? selected : null;
  const activeSource = readingDocument ?? bufferSource;
  const bufferName = bufferSource?.name ?? 'Untitled';
  const activeName = readingDocument?.name ?? bufferName;

  async function openOriginal() {
    if (!activeSource) return;
    setExternalOpening(true);
    setNotice(null);
    try {
      await invoke('open_document', { path: activeSource.path });
      setNotice({ error: false, text: 'Open request sent to the default application. The original file is unchanged by Adamant.' });
    } catch (error) {
      setNotice({ error: true, text: errorMessage(error) });
    } finally {
      setExternalOpening(false);
    }
  }

  function showBuffer() {
    setPreview('markdown');
    setSection('workbench');
  }

  async function controlWindow(action: 'minimize' | 'toggleMaximize' | 'close') {
    if (!desktopWindow) return;
    try {
      await desktopWindow[action]();
    } catch (error) {
      setNotice({ error: true, text: errorMessage(error) });
    }
  }

  let previewNote = 'Sanitized preview. Links are inactive; only embedded raster images are shown.';
  if (readingDocument?.kind === 'pdf') {
    previewNote = 'One page rendered at a time. No PDF scripts, forms, or link actions.';
  } else if (readingDocument?.kind === 'docx') {
    previewNote = 'Isolated preview; Word layout may differ. Embedded HTML and remote resources are blocked.';
  }

  return <div className="app-shell" data-sidebar-open={sidebarOpen}>
    <a className="skip-link" href="#main">Skip to workspace</a>
    <nav className="icon-ribbon" aria-label="Workspace">
      <button className="icon-button" type="button" title={sidebarOpen ? 'Collapse explorer' : 'Expand explorer'} aria-label={sidebarOpen ? 'Collapse explorer' : 'Expand explorer'} aria-expanded={sidebarOpen} aria-controls="explorer" onClick={() => setSidebarOpen((value) => !value)}><WorkspaceIcon name="sidebar" /></button>
      <div className="ribbon-actions">
        <button className="icon-button" type="button" title="Document workbench" aria-label="Document workbench" aria-pressed={section === 'workbench'} onClick={() => setSection('workbench')}><WorkspaceIcon name="document" /></button>
        <button className="icon-button" type="button" title={native ? 'Open document' : 'Open document (desktop application required)'} aria-label="Open document" disabled={!native || opening} onClick={openDocument}><WorkspaceIcon name="folder" /></button>
      </div>
      <button className="icon-button ribbon-bottom" type="button" title="Connection checks" aria-label="Connection checks" aria-pressed={section === 'connections'} onClick={() => setSection('connections')}><WorkspaceIcon name="connections" /></button>
    </nav>
    <aside className="sidebar" id="explorer" hidden={!sidebarOpen} aria-label="Document explorer">
      <Atmosphere />
      <header className="explorer-header" data-tauri-drag-region><span className="brand" data-tauri-drag-region>Adamant</span><span className="stage" title="M0 approved" data-tauri-drag-region>M0</span></header>
      <div className="explorer-section">
        <div className="explorer-heading"><h2>Open documents</h2><button className="icon-button" type="button" title={native ? 'Open Markdown, PDF, or DOCX' : 'Open documents in the desktop application'} aria-label="Open Markdown, PDF, or DOCX" disabled={!native || opening} onClick={openDocument}><WorkspaceIcon name="folder" /></button></div>
        <button className="explorer-file" type="button" aria-pressed={section === 'workbench' && !readingDocument} title={bufferSource ? `${bufferSource.path} (in-memory Markdown buffer)` : 'Unsaved Markdown buffer'} onClick={showBuffer}><WorkspaceIcon name="document" /><span>{bufferName}</span><span className="buffer-dot" aria-label={buffer ? 'Unsaved buffer' : 'Empty buffer'} /></button>
        {selected && selected.kind !== 'markdown' ? <button className="explorer-file" type="button" aria-pressed={section === 'workbench' && !!readingDocument} title={selected.path} onClick={() => { setPreview('document'); setView('read'); setSection('workbench'); }}><WorkspaceIcon name="document" /><span>{selected.name}</span><small>{selected.kind.toUpperCase()}</small></button> : null}
      </div>
      <div className="sidebar-note"><strong>No Vault open</strong><p>Open Markdown, PDF, or DOCX.<br />Your originals stay unchanged.</p></div>
    </aside>
    <main id="main" tabIndex={-1}>
      <header className="workspace-tabs" aria-label="Open workspace views" data-tauri-drag-region>
        <button className="workspace-tab" type="button" aria-pressed={section === 'workbench'} onClick={() => setSection('workbench')} title={activeSource?.path ?? 'Untitled Markdown buffer'}><WorkspaceIcon name="document" /><span>{activeName}</span>{!readingDocument && buffer ? <span className="buffer-dot" aria-label="Unsaved" /> : null}</button>
        <button className="workspace-tab" type="button" aria-pressed={section === 'connections'} onClick={() => setSection('connections')}><WorkspaceIcon name="connections" /><span>Connections</span></button>
        <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />
        <div className="window-controls" role="group" aria-label="Window controls">
          <button className="icon-button" type="button" title="Minimize window" aria-label="Minimize window" disabled={!native} onClick={() => void controlWindow('minimize')}><WorkspaceIcon name="minimize" /></button>
          <button className="icon-button" type="button" title="Maximize or restore window" aria-label="Maximize or restore window" disabled={!native} onClick={() => void controlWindow('toggleMaximize')}><WorkspaceIcon name="maximize" /></button>
          <button className="icon-button window-close" type="button" title="Close window" aria-label="Close window" disabled={!native} onClick={() => void controlWindow('close')}><WorkspaceIcon name="close" /></button>
        </div>
      </header>
      {notice ? <div className={`workbench-notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div> : null}
      <section className="workbench" hidden={section !== 'workbench'} aria-label="Document workbench">
        <div className="document-toolbar">
          <div className="breadcrumb" title={activeSource?.path ?? 'In-memory Markdown buffer'}><span>{readingDocument ? 'Original' : 'Markdown'}</span><WorkspaceIcon name="chevron" /><strong>{activeName}</strong></div>
          <div className="view-controls" role="group" aria-label="Document view">
            <button className="icon-button" type="button" title="Edit Markdown" aria-label="Edit Markdown" aria-pressed={view === 'edit'} onClick={() => setView('edit')}><WorkspaceIcon name="edit" /></button>
            <button className="icon-button" type="button" title="Reading view" aria-label="Reading view" aria-pressed={view === 'read'} onClick={() => setView('read')}><WorkspaceIcon name="read" /></button>
            <button className="icon-button" type="button" title="Split editor and preview" aria-label="Split editor and preview" aria-pressed={view === 'split'} onClick={() => setView('split')}><WorkspaceIcon name="split" /></button>
            <span className="toolbar-divider" />
            <button className="icon-button" type="button" title={activeSource ? `Open original externally: ${activeSource.name}` : 'No original file for this buffer'} aria-label="Open original externally" disabled={!native || !activeSource || externalOpening} onClick={openOriginal}><WorkspaceIcon name="external" /></button>
          </div>
        </div>
        {selected && selected.kind !== 'markdown' && view !== 'edit' ? <div className="preview-switch" role="group" aria-label="Preview selection"><button type="button" aria-pressed={preview === 'markdown'} onClick={() => setPreview('markdown')}>Markdown buffer</button><button type="button" aria-pressed={preview === 'document'} onClick={() => setPreview('document')}>{selected.kind.toUpperCase()} original</button></div> : null}
        <div className="document-panes" data-view={view}>
          <section className="editor-pane" hidden={view === 'read'} aria-label="Markdown editor">
            {view === 'split' ? <div className="pane-heading"><span>{bufferName}</span><span className="unsaved-label">In-memory buffer</span></div> : null}
            <div className="editor-canvas"><ViewerBoundary><Suspense fallback={<div className="viewer-message" role="status">Loading Monaco editor…</div>}><MarkdownEditor key={bufferRevision} initialValue={buffer} onChange={setBuffer} /></Suspense></ViewerBoundary></div>
            {!buffer ? <div className="empty-editor-hint"><h1>A place to think.</h1><p>Start typing Markdown above, or open a document from the explorer.</p></div> : null}
          </section>
          <section className="reading-pane" hidden={view === 'edit'} aria-label="Document reading surface">
            {view === 'split' ? <div className="pane-heading"><span>{activeName}</span><span>{readingDocument ? 'Original preview' : 'Reading view'}</span></div> : null}
            <div className="reading-content" hidden={preview !== 'markdown'}><ViewerBoundary><Suspense fallback={<div className="viewer-message" role="status">Loading Markdown preview…</div>}><MarkdownPreview value={buffer} /></Suspense></ViewerBoundary></div>
            {selected && selected.kind !== 'markdown' ? <div className="reading-content" hidden={preview !== 'document'}><ViewerBoundary key={selected.revision}><Suspense fallback={<div className="viewer-message" role="status">Loading {selected.kind.toUpperCase()} viewer…</div>}>{selected.kind === 'pdf' ? <PdfViewer bytes={selected.bytes} /> : <DocxViewer bytes={selected.bytes} />}</Suspense></ViewerBoundary></div> : null}
            <div className="pane-footer">{previewNote}</div>
          </section>
        </div>
      </section>
      {section === 'connections' ? <Connections native={native} /> : null}
      <footer className="status-bar">
        {!native ? <span className="runtime-notice" title="Launch the Tauri desktop application to open local documents, check accounts, and use the OS credential store."><WorkspaceIcon name="warning" />Browser preview: desktop features unavailable</span> : <span className="runtime-status">Local session</span>}
        <span className={buffer ? 'buffer-status unsaved-label' : 'buffer-status'} role="status">{buffer ? 'Unsaved buffer — copy text before closing' : 'Empty buffer'}</span>
        <span className="status-format">{readingDocument ? `${readingDocument.kind.toUpperCase()} · Original unchanged` : 'Markdown'}</span>
      </footer>
    </main>
    <dialog className="replace-dialog" ref={replaceDialog} onCancel={() => setPending(null)} onClose={() => setPending(null)} aria-labelledby="replace-heading">
      <h2 id="replace-heading">Replace the unsaved buffer?</h2>
      <p>Opening {pending?.document.name} will replace your current Markdown. Copy anything you want to keep before continuing.</p>
      <div className="dialog-actions"><button type="button" autoFocus onClick={() => replaceDialog.current?.close()}>Keep current buffer</button><button className="primary" type="button" onClick={() => {
        if (!pending) return;
        setSelected(pending.document);
        setBuffer(pending.text);
        setBufferSource({ name: pending.document.name, path: pending.document.path });
        setBufferRevision((value) => value + 1);
        setPreview('markdown');
        setView('edit');
        setSection('workbench');
        replaceDialog.current?.close();
      }}>Replace buffer</button></div>
    </dialog>
  </div>;
}
