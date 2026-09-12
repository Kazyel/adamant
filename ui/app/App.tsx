import { useCallback, useRef, useState } from 'react';
import Connections from '../features/connections/Connections';
import WorkspaceDialog from '../features/workspace/WorkspaceDialog';
import { sourceName } from '../features/workspace/buffer';
import useWorkspace from '../features/workspace/useWorkspace';
import DocumentWorkbench from './DocumentWorkbench';
import ExplorerSidebar from './ExplorerSidebar';
import WorkspaceRibbon from './WorkspaceRibbon';
import { StatusBar, WorkspaceNotices } from './WorkspaceStatus';
import WorkspaceTabs from './WorkspaceTabs';
import { native } from './workspaceView';
import type { DocumentInfo, Section, View } from './workspaceView';
import type { Workspace } from '../features/workspace/workspaceTypes';
import { useWorkspaceActions } from './WorkspaceActions';
import RecoveryDialog from '../features/workspace/session/RecoveryDialog';
import MutationRecovery from '../features/workspace/MutationRecovery';
import WorkContext from '../features/work-context/WorkContext';

function getBufferPath({ vault, buffer }: Workspace) {
  if (buffer.source?.kind === 'standalone') {
    return buffer.source.path;
  }
  if (buffer.source?.kind !== 'vault') {
    return null;
  }

  let contentPath = vault?.root ?? '';
  if (vault?.contentRoot === 'content') {
    contentPath = `${vault.root}/content`;
  }

  return `${contentPath}/${buffer.source.note.path}`;
}

function getDocumentInfo(workspace: Workspace, view: View): DocumentInfo {
  const { buffer, selected, showOriginal } = workspace;

  const note = buffer.source?.kind === 'vault' ? buffer.source.note : null;
  const readingDocument = view !== 'edit' && showOriginal ? selected : null;

  const bufferName = sourceName(buffer.source);
  const bufferPath = getBufferPath(workspace);

  const activeName =
    workspace.documents.activeTab?.retained?.name ?? readingDocument?.name ?? bufferName;
  const activePath = readingDocument?.path ?? bufferPath;

  const activeVaultPath = readingDocument ? readingDocument.vaultPath : (note?.path ?? null);

  return {
    note,
    readingDocument,
    bufferName,
    bufferPath,
    activeName,
    activePath,
    activeVaultPath,
  };
}

export default function App() {
  const workPersistenceGuard = useRef<(() => Promise<void>) | null>(null);
  const registerWorkGuard = useCallback((guard: (() => Promise<void>) | null) => {
    workPersistenceGuard.current = guard;
  }, []);
  const workspace = useWorkspace(async () => {
    await workPersistenceGuard.current?.();
  });
  const [section, setSection] = useState<Section>('workbench');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const activeTab = workspace.documents.activeTab;
  const view = activeTab?.view ?? workspace.preferences.defaultView;
  function setView(next: View) {
    if (!activeTab || (activeTab.kind !== 'markdown' && next !== 'read')) {
      return;
    }
    workspace.documents.updateTab(activeTab.id, { view: next });
  }
  const indexDetails = useRef<HTMLDetailsElement>(null);
  const documentInfo = getDocumentInfo(workspace, view);

  function revealIndexDetails() {
    setSidebarOpen(true);
    requestAnimationFrame(() => {
      const details = indexDetails.current;
      if (!details) {
        return;
      }

      details.open = true;
      details.querySelector('summary')?.focus();
      details.scrollIntoView({ block: 'nearest' });
    });
  }

  function showBuffer() {
    workspace.setShowOriginal(false);
    setSection('workbench');
    setView('edit');
  }

  const navigation = {
    section,
    setSection,
    sidebarOpen,
    setSidebarOpen,
    view,
    setView,
    showBuffer,
  };
  const actionUI = useWorkspaceActions(workspace, navigation);

  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen}>
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <WorkspaceRibbon workspace={workspace} navigation={navigation} actions={actionUI.actions} />
      <ExplorerSidebar
        workspace={workspace}
        navigation={navigation}
        documentInfo={documentInfo}
        detailsRef={indexDetails}
        fileActions={workspace.fileActions}
      />
      <main id="main" tabIndex={-1}>
        <WorkspaceTabs workspace={workspace} navigation={navigation} documentInfo={documentInfo} />
        <div className="workspace-surface">
          <WorkspaceNotices workspace={workspace} />
          <MutationRecovery
            actions={workspace.fileActions}
            reveal={(path) => {
              setSidebarOpen(true);
              setSection('workbench');
              workspace.openPath(path);
            }}
          />
          {workspace.recoveries.length ? (
            <details className="workspace-notice draft-notice">
              <summary>
                <span>Retained drafts: {workspace.recoveries.length}</span>
                <small>Source files unchanged</small>
              </summary>
              <div className="draft-notice-list">
                {workspace.recoveries.map((draft) => (
                  <button
                    key={draft.id}
                    type="button"
                    onClick={() => {
                      void workspace.inspectRecovery(draft);
                    }}
                    title={draft.path || 'New document'}
                  >
                    Review {draft.path || 'New document'}
                  </button>
                ))}
              </div>
            </details>
          ) : null}
          <DocumentWorkbench
            workspace={workspace}
            navigation={navigation}
            documentInfo={documentInfo}
          />
          <div className="work-context-host" hidden={section !== 'work'}>
            <WorkContext
              vault={workspace.vault}
              active={section === 'work'}
              onRegisterPersistenceGuard={registerWorkGuard}
              onOpenNote={(target) => {
                setSection('workbench');
                workspace.openPath(target);
              }}
              onConnections={() => setSection('connections')}
            />
          </div>
          {section === 'connections' ? <Connections native={native} /> : null}
          {section !== 'work' ? (
            <StatusBar
              workspace={workspace}
              navigation={navigation}
              documentInfo={documentInfo}
              revealIndexDetails={revealIndexDetails}
            />
          ) : null}
        </div>
      </main>
      {workspace.prompt ? (
        <WorkspaceDialog
          key={workspace.prompt.kind}
          prompt={workspace.prompt}
          answer={workspace.answer}
        />
      ) : null}
      {actionUI.overlays}
      {workspace.recovery ? (
        <RecoveryDialog
          draft={workspace.recovery.draft}
          sourceText={workspace.recovery.source?.text ?? null}
          sourceChanged={workspace.recovery.sourceChanged}
          onRecover={workspace.recoverDraft}
          onDiscard={() => {
            void workspace.discardRecovery(workspace.recovery!.draft.id).catch(workspace.fail);
          }}
          onCancel={workspace.cancelRecovery}
        />
      ) : null}
    </div>
  );
}
