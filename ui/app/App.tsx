import { useRef, useState } from 'react';
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
import type { DocumentInfo, Section, View, Workspace } from './workspaceView';

function useDocumentView(showOriginal: boolean, revision: number | undefined) {
  const [selection, setSelection] = useState({
    showOriginal,
    revision,
    view: (showOriginal ? 'read' : 'edit') as View,
  });
  let view = selection.view;

  if (selection.showOriginal !== showOriginal || selection.revision !== revision) {
    // A newly selected original starts in reading view; explicit view choices persist otherwise.
    view = showOriginal ? 'read' : selection.view;
    setSelection({ showOriginal, revision, view });
  }

  function setView(next: View) {
    setSelection({ showOriginal, revision, view: next });
  }

  return { view, setView };
}

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

  const activeName = readingDocument?.name ?? bufferName;
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
  const workspace = useWorkspace();
  const [section, setSection] = useState<Section>('workbench');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const { view, setView } = useDocumentView(workspace.showOriginal, workspace.selected?.revision);
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

  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen}>
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <WorkspaceRibbon workspace={workspace} navigation={navigation} />
      <ExplorerSidebar
        workspace={workspace}
        navigation={navigation}
        documentInfo={documentInfo}
        detailsRef={indexDetails}
      />
      <main id="main" tabIndex={-1}>
        <WorkspaceTabs workspace={workspace} navigation={navigation} documentInfo={documentInfo} />
        <WorkspaceNotices workspace={workspace} />
        <DocumentWorkbench
          workspace={workspace}
          navigation={navigation}
          documentInfo={documentInfo}
        />
        {section === 'connections' ? <Connections native={native} /> : null}
        <StatusBar
          workspace={workspace}
          navigation={navigation}
          documentInfo={documentInfo}
          revealIndexDetails={revealIndexDetails}
        />
      </main>
      {workspace.prompt ? (
        <WorkspaceDialog
          key={workspace.prompt.kind}
          prompt={workspace.prompt}
          answer={workspace.answer}
        />
      ) : null}
    </div>
  );
}
