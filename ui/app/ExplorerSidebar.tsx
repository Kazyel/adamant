import type { RefObject } from 'react';
import VaultExplorer from '../features/workspace/VaultExplorer';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import Atmosphere from './Atmosphere';
import { indexLabels, native } from './workspaceView';
import type { DocumentProps, Workspace, WorkspaceProps } from './workspaceView';

function IndexDetails({
  workspace,
  detailsRef,
}: WorkspaceProps & { detailsRef: RefObject<HTMLDetailsElement | null> }) {
  const { indexing, indexAction, reconcile } = workspace;
  if (!indexing || indexing.state === 'ready' || indexing.state === 'indexing') {
    return null;
  }

  return (
    <details className="index-status" ref={detailsRef}>
      <summary>
        <WorkspaceIcon name="warning" />
        <span>{indexLabels[indexing.state]} — files may be missing</span>
      </summary>
      <p>
        {indexing.message ??
          'Some files have not been checked. You can keep working with available files.'}
      </p>
      <button type="button" disabled={!native || indexAction !== null} onClick={reconcile}>
        {indexAction === 'reconcile' ? 'Scheduling…' : 'Reconcile index'}
      </button>
    </details>
  );
}

function VaultIssues({ vault }: { vault: NonNullable<Workspace['vault']> }) {
  if (vault.issueCount === 0) {
    return null;
  }

  return (
    <details className="vault-issues">
      <summary>
        {vault.issueCount.toLocaleString()} Vault {vault.issueCount === 1 ? 'issue' : 'issues'}
      </summary>
      {vault.issueCount > vault.issues.length ? (
        <p>
          Showing {vault.issues.length.toLocaleString()} of {vault.issueCount.toLocaleString()}{' '}
          issues. The issue list is truncated.
        </p>
      ) : null}
      <ul>
        {vault.issues.map((issue, index) => (
          <li key={`${issue.path}:${index}`}>
            <strong>{issue.path}</strong>
            <span>{issue.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function VaultFiles({
  workspace,
  navigation,
  documentInfo,
  detailsRef,
}: DocumentProps & { detailsRef: RefObject<HTMLDetailsElement | null> }) {
  const { vault, pages, buffer, dirty, busy } = workspace;
  const { setSection, setSidebarOpen } = navigation;
  const disabled = !native || !!busy;
  const dirtyPath = dirty && buffer.source?.kind === 'vault' ? buffer.source.note.path : null;

  if (!vault) {
    return (
      <div className="explorer-empty">
        <p>No Vault open</p>
        <button type="button" disabled={disabled} onClick={() => workspace.chooseVault('open')}>
          Open Vault…
        </button>
        <p>Create a new Vault from the Adamant menu.</p>
      </div>
    );
  }

  return (
    <>
      <div className="explorer-heading vault-heading">
        <h2 title={vault.root}>{vault.name}</h2>
        <div className="explorer-tools">
          <button
            className="icon-button"
            type="button"
            title="New Note"
            aria-label="New Note"
            disabled={disabled}
            onClick={() => {
              setSection('workbench');
              workspace.newNote();
            }}
          >
            <WorkspaceIcon name="new" />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Import Markdown"
            aria-label="Import Markdown"
            disabled={disabled}
            onClick={() => {
              setSection('workbench');
              workspace.importNote();
            }}
          >
            <WorkspaceIcon name="import" />
          </button>
        </div>
      </div>
      <IndexDetails workspace={workspace} detailsRef={detailsRef} />
      <VaultExplorer
        pages={pages}
        indexing={vault.indexing}
        activePath={documentInfo.activeVaultPath}
        dirtyPath={dirtyPath}
        disabled={!!busy}
        onToggleDirectory={workspace.toggleDirectory}
        onLoadMore={workspace.loadMore}
        onOpen={(entry) => {
          setSection('workbench');
          workspace.openEntry(entry);
          if (window.innerWidth <= 760) {
            setSidebarOpen(false);
          }
        }}
      />
      <VaultIssues vault={vault} />
    </>
  );
}

function StandaloneFiles({ workspace, navigation, documentInfo }: DocumentProps) {
  const { buffer, selected, dirty } = workspace;
  const { section, setSection, setView, showBuffer } = navigation;
  const { note, readingDocument, bufferName, bufferPath } = documentInfo;
  const standaloneOriginal = selected && !selected.vaultPath ? selected : null;

  if (buffer.source?.kind !== 'standalone' && !standaloneOriginal) {
    return null;
  }

  return (
    <>
      <div className="explorer-heading standalone-heading">
        <h2>Standalone documents</h2>
      </div>
      {!note ? (
        <button
          className="explorer-file"
          type="button"
          aria-pressed={section === 'workbench' && !readingDocument}
          title={bufferPath ?? 'Unsaved Markdown buffer'}
          onClick={showBuffer}
        >
          <WorkspaceIcon name="document" />
          <span>{bufferName}</span>
          {dirty ? <span className="buffer-dot" aria-label="Unsaved changes" /> : null}
        </button>
      ) : null}
      {standaloneOriginal ? (
        <button
          className="explorer-file"
          type="button"
          aria-pressed={section === 'workbench' && !!readingDocument}
          title={standaloneOriginal.path}
          onClick={() => {
            workspace.setShowOriginal(true);
            setView('read');
            setSection('workbench');
          }}
        >
          <WorkspaceIcon name="document" />
          <span>{standaloneOriginal.name}</span>
          <small>{standaloneOriginal.kind.toUpperCase()}</small>
        </button>
      ) : null}
    </>
  );
}

export default function ExplorerSidebar({
  workspace,
  navigation,
  documentInfo,
  detailsRef,
}: DocumentProps & { detailsRef: RefObject<HTMLDetailsElement | null> }) {
  return (
    <aside
      className="sidebar"
      id="explorer"
      hidden={!navigation.sidebarOpen}
      aria-label="Document explorer"
    >
      <Atmosphere />
      <header className="explorer-header" data-tauri-drag-region>
        <span data-tauri-drag-region>Files</span>
      </header>
      <div className="explorer-section">
        <VaultFiles
          workspace={workspace}
          navigation={navigation}
          documentInfo={documentInfo}
          detailsRef={detailsRef}
        />
        <StandaloneFiles
          workspace={workspace}
          navigation={navigation}
          documentInfo={documentInfo}
        />
      </div>
    </aside>
  );
}
