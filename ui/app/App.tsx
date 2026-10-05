import type { GraphNode } from '../features/graph/graphTypes';
import { ThemeContext } from '../shared/styles/ThemeContext';
import { resolveFontFamily } from '../shared/styles/fontFamilies';
import { useEffect, useCallback, useLayoutEffect, useRef, useState } from 'react';
import Connections from '../features/connections/Connections';
import WorkspaceDialog from '../features/workspace/WorkspaceDialog';
import { sourceName } from '../features/workspace/buffer';
import { vaultTabPath } from '../features/workspace/session/useDocumentSession';
import useWorkspace from '../features/workspace/useWorkspace';
import DocumentWorkbench from './DocumentWorkbench';
import ExplorerSidebar from './ExplorerSidebar';
import WorkspaceRibbon from './WorkspaceRibbon';
import { StatusBar, WorkspaceNotices } from './WorkspaceStatus';
import WorkspaceTabs from './WorkspaceTabs';
import WindowControls from './WindowControls';
import { native } from './workspaceView';
import type { DocumentInfo, Section, View } from './workspaceView';
import type { Workspace } from '../features/workspace/workspaceTypes';
import { useWorkspaceActions } from './WorkspaceActions';
import RecoveryDialog from '../features/workspace/session/RecoveryDialog';
import MutationRecovery from '../features/workspace/MutationRecovery';
import WorkContext from '../features/work-context/WorkContext';
import { OverlayPresence } from '../features/interaction/OverlayPresence';

import GraphView from '../features/graph/GraphView';

function GraphSection({
  active,
  workspace,
  registerGuard,
  onOpen,
}: {
  active: boolean;
  workspace: Workspace;
  registerGuard: (guard: (() => Promise<void>) | null) => void;
  onOpen: (node: GraphNode) => void;
}) {
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    if (visited || !workspace.vault || workspace.busy || workspace.documents.activeTab?.restored) {
      return;
    }
    // Let the active document open first, then prepare the graph before it is requested.
    const timer = window.setTimeout(() => setVisited(true), 200);
    return () => window.clearTimeout(timer);
  }, [visited, workspace.vault, workspace.busy, workspace.documents.activeTab?.restored]);
  if (active && !visited) {
    setVisited(true);
  }
  if (!active && !visited) {
    return null;
  }
  return (
    <div className="graph-section-host" hidden={!active}>
      <GraphView
        active={active}
        activePath={vaultTabPath(workspace.documents.activeTab)}
        workspace={workspace}
        onRegisterPersistenceGuard={registerGuard}
        onOpen={onOpen}
      />
    </div>
  );
}

function getBufferPath({ vault, buffer }: Workspace) {
  if (buffer.conflict?.removed) {
    return null;
  }
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

  const activeVaultPath = vaultTabPath(workspace.documents.activeTab);

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
  const graphPersistenceGuard = useRef<(() => Promise<void>) | null>(null);
  const registerGraphGuard = useCallback((guard: (() => Promise<void>) | null) => {
    graphPersistenceGuard.current = guard;
  }, []);
  const workPersistenceGuard = useRef<(() => Promise<void>) | null>(null);
  const registerWorkGuard = useCallback((guard: (() => Promise<void>) | null) => {
    workPersistenceGuard.current = guard;
  }, []);
  const workRemovalHandler = useRef<((paths: readonly string[]) => Promise<void>) | null>(null);
  const registerWorkRemoval = useCallback(
    (handler: ((paths: readonly string[]) => Promise<void>) | null) => {
      workRemovalHandler.current = handler;
    },
    [],
  );
  const workspace = useWorkspace(
    async () => {
      await workPersistenceGuard.current?.();
      await graphPersistenceGuard.current?.();
    },
    (paths) => workRemovalHandler.current?.(paths),
  );
  const theme = workspace.preferences.theme ?? 'dark';
  const interfaceFont = workspace.preferences.interfaceFont;
  useLayoutEffect(() => {
    const interfaceFamily = resolveFontFamily(interfaceFont ?? 'inter');
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--interface-font', interfaceFamily);
    if (interfaceFont === undefined) {
      document.documentElement.style.removeProperty('--interface-heading-font');
    } else {
      document.documentElement.style.setProperty('--interface-heading-font', interfaceFamily);
    }
  }, [theme, interfaceFont]);
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
    <ThemeContext value={theme}>
      <div
        className="app-shell"
        data-operation={workspace.busy}
        data-sidebar-open={sidebarOpen}
        data-tabs-visible={workspace.preferences.showDocumentTabs ?? true}
      >
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
          <WorkspaceTabs
            workspace={workspace}
            navigation={navigation}
            documentInfo={documentInfo}
          />
          <div className="workspace-surface" data-tauri-drag-region>
            {workspace.preferences.showDocumentTabs === false ? (
              <div className="workspace-window-controls">
                <WindowControls workspace={workspace} />
              </div>
            ) : null}
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
                      data-tooltip={draft.path || 'New document'}
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
                onRegisterRemovalHandler={registerWorkRemoval}
                onOpenNote={(target) => {
                  setSection('workbench');
                  workspace.openPath(target);
                }}
                onConnections={() => setSection('connections')}
              />
            </div>
            <GraphSection
              key={`${workspace.vault?.root}:${workspace.vault?.id}`}
              active={section === 'graph'}
              workspace={workspace}
              registerGuard={registerGraphGuard}
              onOpen={(node) => {
                setSection('workbench');
                workspace.openPath(node.path, node.identity);
              }}
            />
            {section === 'connections' ? (
              <Connections native={native} onWorkspace={() => setSection('work')} />
            ) : null}
            {section === 'workbench' ? (
              <StatusBar
                workspace={workspace}
                navigation={navigation}
                documentInfo={documentInfo}
                revealIndexDetails={revealIndexDetails}
              />
            ) : null}
          </div>
        </main>
        <OverlayPresence>
          {workspace.prompt ? (
            <WorkspaceDialog
              key={workspace.prompt.kind}
              prompt={workspace.prompt}
              answer={workspace.answer}
            />
          ) : null}
        </OverlayPresence>
        {actionUI.overlays}
        <OverlayPresence>
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
        </OverlayPresence>
      </div>
    </ThemeContext>
  );
}
