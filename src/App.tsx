import { Component, Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Connections from './Connections';
import Atmosphere from './Atmosphere';
import WorkspaceIcon from './WorkspaceIcon';
import VaultExplorer from './VaultExplorer';
import WorkspaceDialog from './WorkspaceDialog';
import useWorkspace, { sourceName, type IndexState } from './useWorkspace';
import { errorMessage } from './document';

const MarkdownEditor = lazy(() => import('./MarkdownEditor'));
const MarkdownPreview = lazy(() => import('./MarkdownPreview'));
const PdfViewer = lazy(() => import('./PdfViewer'));
const DocxViewer = lazy(() => import('./DocxViewer'));
const native = isTauri();
const desktopWindow = native ? getCurrentWindow() : null;
const indexLabels: Record<IndexState['state'], string> = {
  indexing: 'Indexing Vault',
  ready: 'Index ready',
  partial: 'Partial index',
  stale: 'Index out of date',
  cancelled: 'Indexing cancelled',
};

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
  const workspace = useWorkspace();
  const { vault, pages, indexing, indexAction, reconcile, cancelIndex, buffer, dirty, selected, showOriginal, busy, notice } = workspace;
  const [section, setSection] = useState<'workbench' | 'connections'>('workbench');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [view, setView] = useState<'edit' | 'read' | 'split'>('edit');
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const indexDetails = useRef<HTMLDetailsElement>(null);
  function revealIndexDetails() {
    setSidebarOpen(true);
    requestAnimationFrame(() => {
      const details = indexDetails.current;
      if (!details) return;
      details.open = true;
      details.querySelector('summary')?.focus();
      details.scrollIntoView({ block: 'nearest' });
    });
  }
  function closeMenu() {
    setMenuOpen(false);
    menuButton.current?.focus();
  }
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Node) || menu.current?.contains(event.target) || menuButton.current?.contains(event.target)) return;
      closeMenu();
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);
  useEffect(() => { if (showOriginal) setView('read'); }, [showOriginal, selected?.revision]);
  const note = buffer.source?.kind === 'vault' ? buffer.source.note : null;
  const readingDocument = view !== 'edit' && showOriginal ? selected : null;
  const bufferName = sourceName(buffer.source);
  const activeName = readingDocument?.name ?? bufferName;
  const bufferPath = note ? `${vault?.root ?? ''}/${note.path}` : buffer.source?.kind === 'standalone' ? buffer.source.path : null;
  const activePath = readingDocument?.path ?? bufferPath;
  const activeVaultPath = readingDocument ? readingDocument.vaultPath : note?.path ?? null;
  const disabled = !native || !!busy;
  let saveStatus = 'Empty buffer';
  if (busy === 'save') saveStatus = 'Saving…';
  else if (buffer.conflict) saveStatus = 'Disk conflict — buffer kept';
  else if (dirty) saveStatus = 'Unsaved changes';
  else if (note) saveStatus = 'Saved to disk';
  else if (buffer.source) saveStatus = 'Standalone original unchanged';

  function showBuffer() {
    workspace.setShowOriginal(false);
    setSection('workbench');
    setView('edit');
  }
  async function controlWindow(action: 'minimize' | 'toggleMaximize') {
    if (!desktopWindow) return;
    try { await desktopWindow[action](); }
    catch (error) { workspace.fail(error); }
  }
  let previewNote = 'Sanitized preview. Links are inactive; only embedded raster images are shown.';
  if (readingDocument?.kind === 'pdf') previewNote = 'One page rendered at a time. No PDF scripts, forms, or link actions.';
  else if (readingDocument?.kind === 'docx') previewNote = 'Isolated preview; Word layout may differ. Embedded HTML and remote resources are blocked.';

  return <div className="app-shell" data-sidebar-open={sidebarOpen}>
    <a className="skip-link" href="#main">Skip to workspace</a>
    <nav className="icon-ribbon" aria-label="Workspace">
      <button className="icon-button" type="button" title={sidebarOpen ? 'Collapse explorer' : 'Expand explorer'} aria-label={sidebarOpen ? 'Collapse explorer' : 'Expand explorer'} aria-expanded={sidebarOpen} aria-controls="explorer" onClick={() => setSidebarOpen((value) => !value)}><WorkspaceIcon name="sidebar" /></button>
      <div className="ribbon-actions">
        <button className="icon-button" type="button" title="Document workbench" aria-label="Document workbench" aria-pressed={section === 'workbench'} onClick={() => setSection('workbench')}><WorkspaceIcon name="document" /></button>
      </div>
      <button className="icon-button ribbon-bottom" type="button" title="Connection checks" aria-label="Connection checks" aria-pressed={section === 'connections'} onClick={() => setSection('connections')}><WorkspaceIcon name="connections" /></button>
    </nav>
    <aside className="sidebar" id="explorer" hidden={!sidebarOpen} aria-label="Document explorer">
      <Atmosphere />
      <header className="explorer-header" data-tauri-drag-region><span data-tauri-drag-region>Files</span></header>
      <div className="explorer-section">
        {vault ? <>
          <div className="explorer-heading vault-heading"><h2 title={vault.root}>{vault.name}</h2><div className="explorer-tools"><button className="icon-button" type="button" title="New Note" aria-label="New Note" disabled={disabled} onClick={() => { setSection('workbench'); workspace.newNote(); }}><WorkspaceIcon name="new" /></button><button className="icon-button" type="button" title="Import Markdown" aria-label="Import Markdown" disabled={disabled} onClick={() => { setSection('workbench'); workspace.importNote(); }}><WorkspaceIcon name="import" /></button></div></div>
          {indexing && indexing.state !== 'ready' && indexing.state !== 'indexing' ? <details className="index-status" ref={indexDetails}><summary><WorkspaceIcon name="warning" /><span>{indexLabels[indexing.state]} — files may be missing</span></summary><p>{indexing.message ?? 'Some files have not been checked. You can keep working with available files.'}</p><button type="button" disabled={!native || indexAction !== null} onClick={reconcile}>{indexAction === 'reconcile' ? 'Scheduling…' : 'Reconcile index'}</button></details> : null}
          <VaultExplorer pages={pages} indexing={vault.indexing} activePath={activeVaultPath} dirtyPath={dirty ? note?.path ?? null : null} disabled={!!busy} onToggleDirectory={workspace.toggleDirectory} onLoadMore={workspace.loadMore} onOpen={(entry) => { setSection('workbench'); workspace.openEntry(entry); if (window.innerWidth <= 760) setSidebarOpen(false); }} />
          {vault.issueCount > 0 ? <details className="vault-issues"><summary>{vault.issueCount.toLocaleString()} Vault {vault.issueCount === 1 ? 'issue' : 'issues'}</summary>{vault.issueCount > vault.issues.length ? <p>Showing {vault.issues.length.toLocaleString()} of {vault.issueCount.toLocaleString()} issues. The issue list is truncated.</p> : null}<ul>{vault.issues.map((issue, index) => <li key={`${issue.path}:${index}`}><strong>{issue.path}</strong><span>{issue.message}</span></li>)}</ul></details> : null}
        </> : <div className="explorer-empty"><p>No Vault open</p><button type="button" disabled={disabled} onClick={() => workspace.chooseVault('open')}>Open Vault…</button><p>Create a new Vault from the Adamant menu.</p></div>}
        {buffer.source?.kind === 'standalone' || (selected && !selected.vaultPath) ? <>
        <div className="explorer-heading standalone-heading"><h2>Standalone documents</h2></div>
        {!note ? <button className="explorer-file" type="button" aria-pressed={section === 'workbench' && !readingDocument} title={bufferPath ?? 'Unsaved Markdown buffer'} onClick={showBuffer}><WorkspaceIcon name="document" /><span>{bufferName}</span>{dirty ? <span className="buffer-dot" aria-label="Unsaved changes" /> : null}</button> : null}
        {selected && !selected.vaultPath ? <button className="explorer-file" type="button" aria-pressed={section === 'workbench' && !!readingDocument} title={selected.path} onClick={() => { workspace.setShowOriginal(true); setView('read'); setSection('workbench'); }}><WorkspaceIcon name="document" /><span>{selected.name}</span><small>{selected.kind.toUpperCase()}</small></button> : null}
        </> : null}
      </div>
    </aside>
    <main id="main" tabIndex={-1}>
      <header className="workspace-tabs" aria-label="Open workspace views" data-tauri-drag-region>
        <div className="app-menu">
          <button className="app-menu-trigger" type="button" ref={menuButton} aria-label="Adamant menu" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="app-menu" onClick={() => setMenuOpen((open) => !open)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuOpen(true); } }}><span className="brand">Adamant</span><WorkspaceIcon name="chevron" /></button>
          {menuOpen ? <div className="app-menu-panel" id="app-menu" ref={menu} role="menu" aria-label="Adamant operations" onKeyDown={(event) => {
            if (event.key === 'Tab') { closeMenu(); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            let next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            items[next]?.focus();
            event.preventDefault();
          }}>
            <button role="menuitem" type="button" disabled={disabled} onClick={() => { closeMenu(); workspace.chooseVault('create'); }}><WorkspaceIcon name="new" />Create Vault…</button>
            <button role="menuitem" type="button" disabled={disabled} onClick={() => { closeMenu(); workspace.chooseVault('open'); }}><WorkspaceIcon name="folder" />Open Vault…</button>
            <button role="menuitem" type="button" disabled={disabled || !vault} onClick={() => { closeMenu(); workspace.closeVault(); }}><WorkspaceIcon name="close" />Close Vault</button>
            <div role="separator" />
            <button role="menuitem" type="button" disabled={disabled || !vault} onClick={() => { closeMenu(); setSection('workbench'); workspace.newNote(); }}><WorkspaceIcon name="new" />New Note…</button>
            <button role="menuitem" type="button" disabled={disabled || !vault} onClick={() => { closeMenu(); setSection('workbench'); workspace.importNote(); }}><WorkspaceIcon name="import" />Import Markdown…</button>
            <button role="menuitem" type="button" disabled={disabled} onClick={() => { closeMenu(); setSection('workbench'); workspace.openDocument(); }}><WorkspaceIcon name="document" />Open standalone document…</button>
            <div role="separator" />
            {indexing && indexing.state !== 'ready' ? <>
              <div className="menu-index-description" role="presentation">{indexLabels[indexing.state]}</div>
              {indexing.state === 'indexing' || indexAction ? <button role="menuitem" type="button" disabled={!native || indexAction === 'cancel'} onClick={() => { closeMenu(); cancelIndex(); }}><WorkspaceIcon name="close" />Cancel indexing</button> : null}
              {indexing.state !== 'indexing' ? <button role="menuitem" type="button" disabled={!native || indexAction !== null} onClick={() => { closeMenu(); reconcile(); }}><WorkspaceIcon name="refresh" />Reconcile local index</button> : null}
              <div role="separator" />
            </> : null}
            <button role="menuitem" type="button" onClick={() => { closeMenu(); setSection('connections'); }}><WorkspaceIcon name="connections" />Connections</button>
          </div> : null}
        </div>
        <button className="workspace-tab" type="button" aria-pressed={section === 'workbench'} onClick={() => setSection('workbench')} title={activePath ?? 'Untitled Markdown buffer'}><WorkspaceIcon name="document" /><span>{activeName}</span>{dirty ? <span className="buffer-dot" aria-label="Unsaved Markdown changes" /> : null}</button>
        {section === 'connections' ? <button className="workspace-tab" type="button" aria-pressed="true" onClick={() => setSection('connections')}><WorkspaceIcon name="connections" /><span>Connections</span></button> : null}
        <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />
        <div className="window-controls" role="group" aria-label="Window controls">
          <button className="icon-button" type="button" title="Minimize window" aria-label="Minimize window" disabled={!native} onClick={() => void controlWindow('minimize')}><WorkspaceIcon name="minimize" /></button>
          <button className="icon-button" type="button" title="Maximize or restore window" aria-label="Maximize or restore window" disabled={!native} onClick={() => void controlWindow('toggleMaximize')}><WorkspaceIcon name="maximize" /></button>
          <button className="icon-button window-close" type="button" title="Close window" aria-label="Close window" disabled={!native} onClick={workspace.closeWindow}><WorkspaceIcon name="close" /></button>
        </div>
      </header>
      {notice ? <div className={`workbench-notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div> : null}
      {busy === 'navigate' && !workspace.prompt ? <div className="workbench-notice" role="status">Working with local files… Your buffer is kept until the operation succeeds.</div> : null}
      <section className="workbench" hidden={section !== 'workbench'} aria-label="Document workbench">
        <div className="document-toolbar">
          <div className="breadcrumb" title={activePath ?? 'In-memory Markdown buffer'}><span>{readingDocument ? 'Original' : note ? vault?.name : 'Markdown'}</span><WorkspaceIcon name="chevron" /><strong>{readingDocument ? activeName : note?.path ?? activeName}</strong></div>
          <div className="view-controls" role="group" aria-label="Document view">
            <button className="icon-button" type="button" title="Edit Markdown" aria-label="Edit Markdown" aria-pressed={view === 'edit'} onClick={() => { workspace.setShowOriginal(false); setView('edit'); }}><WorkspaceIcon name="edit" /></button>
            <button className="icon-button" type="button" title="Reading view" aria-label="Reading view" aria-pressed={view === 'read'} onClick={() => setView('read')}><WorkspaceIcon name="read" /></button>
            <button className="icon-button" type="button" title="Split editor and preview" aria-label="Split editor and preview" aria-pressed={view === 'split'} onClick={() => setView('split')}><WorkspaceIcon name="split" /></button>
            <span className="toolbar-divider" />
            <button className="icon-button" type="button" title="Save Markdown (Ctrl+S / ⌘S)" aria-label="Save Markdown" disabled={disabled || (!!note && !dirty) || !!buffer.conflict} onClick={workspace.save}><WorkspaceIcon name="save" /></button>
            <button className="icon-button" type="button" title="Save a recovery copy without changing either source" aria-label="Save recovery copy" disabled={disabled} onClick={workspace.saveCopy}><WorkspaceIcon name="copy" /></button>
            <button className="icon-button" type="button" title={activePath ? `Open original externally: ${activeName}` : 'No original file for this buffer'} aria-label="Open original externally" disabled={disabled || !activePath} onClick={workspace.openOriginal}><WorkspaceIcon name="external" /></button>
          </div>
        </div>
        {note?.metadataError ? <div className="workbench-notice metadata-notice" role="status"><span><strong>Metadata issue.</strong> {note.metadataError} Raw Markdown remains editable; Save never adopts or repairs it.</span>{!note.id ? <button type="button" disabled={disabled} onClick={workspace.adoptNote}>Adopt as Note</button> : null}</div> : null}
        {buffer.conflict ? <div className="workbench-notice conflict-notice" role="alert"><span>{buffer.conflict.message} {buffer.conflict.current ? 'Reload the disk version or keep your edits in a separate recovery file.' : 'Save a recovery copy to preserve your changes at a new path.'}</span><div><button type="button" disabled={disabled || !buffer.conflict.current} onClick={workspace.reloadDisk}>Reload disk</button><button type="button" disabled={disabled} onClick={workspace.saveCopy}>Save recovery copy</button></div></div> : null}
        {selected && view !== 'edit' ? <div className="preview-switch" role="group" aria-label="Preview selection"><button type="button" aria-pressed={!showOriginal} onClick={() => workspace.setShowOriginal(false)}>Markdown buffer</button><button type="button" aria-pressed={showOriginal} onClick={() => workspace.setShowOriginal(true)}>{selected.kind.toUpperCase()} original</button></div> : null}
        <div className="document-panes" data-view={view}>
          <section className="editor-pane" hidden={view === 'read'} aria-label="Markdown editor" inert={busy === 'navigate'}>
            {view === 'split' ? <div className="pane-heading"><span>{bufferName}</span><span className={dirty ? 'unsaved-label' : ''}>{saveStatus}</span></div> : null}
            <div className="editor-canvas"><ViewerBoundary key={buffer.editorKey}><Suspense fallback={<div className="viewer-message" role="status">Loading Monaco editor…</div>}><MarkdownEditor initialValue={buffer.text} onChange={workspace.changeText} readOnly={busy === 'navigate'} /></Suspense></ViewerBoundary></div>
            {!buffer.text ? <div className="empty-editor-hint"><h1>A place to think.</h1><p>Start typing Markdown above, or open a document from the explorer.{native ? ' Save it as a Note in a Vault.' : ' Desktop mode is required to open or save local files.'}</p></div> : null}
          </section>
          <section className="reading-pane" hidden={view === 'edit'} aria-label="Document reading surface">
            {view === 'split' ? <div className="pane-heading"><span>{activeName}</span><span>{readingDocument ? 'Original preview' : 'Reading view'}</span></div> : null}
            <div className="reading-content" hidden={showOriginal}><ViewerBoundary><Suspense fallback={<div className="viewer-message" role="status">Loading Markdown preview…</div>}><MarkdownPreview value={buffer.text} validatedSource={note && !note.metadataError ? buffer.savedText : undefined} /></Suspense></ViewerBoundary></div>
            {selected ? <div className="reading-content" hidden={!showOriginal}><ViewerBoundary key={selected.revision}><Suspense fallback={<div className="viewer-message" role="status">Loading {selected.kind.toUpperCase()} viewer…</div>}>{selected.kind === 'pdf' ? <PdfViewer bytes={selected.bytes} /> : <DocxViewer bytes={selected.bytes} />}</Suspense></ViewerBoundary></div> : null}
            <div className="pane-footer">{previewNote}</div>
          </section>
        </div>
      </section>
      {section === 'connections' ? <Connections native={native} /> : null}
      <footer className="status-bar">
        {!native ? <span className="runtime-notice" title="Launch the Tauri desktop application to open local documents, save Notes, check accounts, and use the OS credential store."><WorkspaceIcon name="warning" />Browser preview: desktop features unavailable</span> : <span className="runtime-status" title={vault?.root}>{vault?.name ?? 'No Vault open'}</span>}
        {indexing?.state === 'indexing' ? <span className="background-indexing" role="status">Indexing in background…</span> : null}
        {!sidebarOpen && indexing && indexing.state !== 'ready' && indexing.state !== 'indexing' ? <button type="button" className="status-index-warning" onClick={revealIndexDetails}>{indexLabels[indexing.state]} — view details</button> : null}
        <span className={dirty || buffer.conflict ? 'buffer-status unsaved-label' : 'buffer-status'} role="status">{saveStatus}</span>
        <span className="status-format">{readingDocument ? `${readingDocument.kind.toUpperCase()} · Original unchanged` : note ? 'Markdown · Raw source' : 'Markdown'}</span>
      </footer>
    </main>
    {workspace.prompt ? <WorkspaceDialog key={workspace.prompt.kind} prompt={workspace.prompt} answer={workspace.answer} /> : null}
  </div>;
}
