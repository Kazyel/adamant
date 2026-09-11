import { useEffect, useState } from 'react';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { Breadcrumbs } from '../features/navigation/Navigation';
import { EditorPane, ReadingPane } from './DocumentPanes';
import { DocumentNotices } from './WorkspaceStatus';
import { native } from './workspaceView';
import type { DocumentProps } from './workspaceView';

function SavingLabel() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timer);
  }, []);

  return <span>{visible ? 'Saving…' : 'Save'}</span>;
}

function DocumentToolbar({ workspace, navigation, documentInfo }: DocumentProps) {
  const { buffer, dirty, busy } = workspace;
  const { view, setView } = navigation;
  const { note, activePath, activeName } = documentInfo;
  const disabled = !native || !!busy;
  const markdown = workspace.documents.activeTab?.kind === 'markdown';
  const saveDisabled = disabled || !markdown || (!!note && !dirty) || !!buffer.conflict;

  return (
    <div className="document-toolbar">
      <div className="breadcrumb" title={activePath ?? 'In-memory Markdown buffer'}>
        {workspace.vault && documentInfo.activeVaultPath ? (
          <Breadcrumbs
            path={documentInfo.activeVaultPath}
            vaultName={workspace.vault.name}
            onNavigate={(path) => {
              navigation.setSidebarOpen(true);
              if (path) {
                workspace.openPath(path);
              } else {
                void workspace.revealPath('').catch(workspace.fail);
              }
            }}
          />
        ) : (
          <strong>{activeName}</strong>
        )}
      </div>
      <div className="document-toolbar-controls">
        <div className="view-controls" role="group" aria-label="Document view">
          <button
            className="icon-button"
            type="button"
            title="Edit Markdown"
            aria-label="Edit Markdown"
            aria-pressed={view === 'edit'}
            disabled={!markdown}
            onClick={() => {
              workspace.setShowOriginal(false);
              setView('edit');
            }}
          >
            <WorkspaceIcon name="edit" />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Reading view"
            aria-label="Reading view"
            aria-pressed={view === 'read'}
            onClick={() => setView('read')}
          >
            <WorkspaceIcon name="read" />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Split editor and preview"
            aria-label="Split editor and preview"
            aria-pressed={view === 'split'}
            disabled={!markdown}
            onClick={() => setView('split')}
          >
            <WorkspaceIcon name="split" />
          </button>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="document-actions" role="group" aria-label="Document actions">
          <button
            className="document-save"
            type="button"
            title={
              buffer.conflict
                ? 'Resolve the disk conflict before saving'
                : 'Save Markdown (Ctrl+S / ⌘S)'
            }
            aria-label="Save Markdown"
            disabled={saveDisabled}
            onClick={workspace.save}
          >
            <WorkspaceIcon name="save" />
            {busy === 'save' ? <SavingLabel /> : <span>Save</span>}
          </button>
          <button
            className="icon-button"
            type="button"
            title="Save a recovery copy without changing either source"
            aria-label="Save recovery copy"
            disabled={disabled || !markdown}
            onClick={workspace.saveCopy}
          >
            <WorkspaceIcon name="copy" />
          </button>
          <button
            className="icon-button"
            type="button"
            title={
              activePath
                ? `Open original externally: ${activeName}`
                : 'No original file for this buffer'
            }
            aria-label="Open original externally"
            disabled={disabled || !activePath}
            onClick={workspace.openOriginal}
          >
            <WorkspaceIcon name="external" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DocumentWorkbench({ workspace, navigation, documentInfo }: DocumentProps) {
  return (
    <section
      className="workbench"
      hidden={navigation.section !== 'workbench'}
      aria-label="Document workbench"
    >
      <DocumentToolbar workspace={workspace} navigation={navigation} documentInfo={documentInfo} />
      <DocumentNotices workspace={workspace} note={documentInfo.note} />

      <div className="document-panes" data-view={navigation.view}>
        <EditorPane workspace={workspace} navigation={navigation} documentInfo={documentInfo} />
        <ReadingPane workspace={workspace} navigation={navigation} documentInfo={documentInfo} />
      </div>
    </section>
  );
}
