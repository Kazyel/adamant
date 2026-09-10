import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { EditorPane, ReadingPane } from './DocumentPanes';
import { DocumentNotices } from './WorkspaceStatus';
import { native } from './workspaceView';
import type { DocumentProps, View, WorkspaceProps } from './workspaceView';

function DocumentToolbar({ workspace, navigation, documentInfo }: DocumentProps) {
  const { buffer, dirty, busy, vault } = workspace;
  const { view, setView } = navigation;
  const { note, readingDocument, activePath, activeName } = documentInfo;
  const disabled = !native || !!busy;
  const saveDisabled = disabled || (!!note && !dirty) || !!buffer.conflict;
  let breadcrumb: string | undefined = 'Markdown';
  if (note) {
    breadcrumb = vault?.name;
  }
  if (readingDocument) {
    breadcrumb = 'Original';
  }

  return (
    <div className="document-toolbar">
      <div className="breadcrumb" title={activePath ?? 'In-memory Markdown buffer'}>
        <span>{breadcrumb}</span>
        <WorkspaceIcon name="chevron" />
        <strong>{readingDocument ? activeName : (note?.path ?? activeName)}</strong>
      </div>
      <div className="view-controls" role="group" aria-label="Document view">
        <button
          className="icon-button"
          type="button"
          title="Edit Markdown"
          aria-label="Edit Markdown"
          aria-pressed={view === 'edit'}
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
          onClick={() => setView('split')}
        >
          <WorkspaceIcon name="split" />
        </button>
        <span className="toolbar-divider" />
        <button
          className="icon-button"
          type="button"
          title="Save Markdown (Ctrl+S / ⌘S)"
          aria-label="Save Markdown"
          disabled={saveDisabled}
          onClick={workspace.save}
        >
          <WorkspaceIcon name="save" />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Save a recovery copy without changing either source"
          aria-label="Save recovery copy"
          disabled={disabled}
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
  );
}

function PreviewSelection({ workspace, view }: WorkspaceProps & { view: View }) {
  const { selected, showOriginal, setShowOriginal } = workspace;
  if (!selected || view === 'edit') {
    return null;
  }

  return (
    <div className="preview-switch" role="group" aria-label="Preview selection">
      <button type="button" aria-pressed={!showOriginal} onClick={() => setShowOriginal(false)}>
        Markdown buffer
      </button>
      <button type="button" aria-pressed={showOriginal} onClick={() => setShowOriginal(true)}>
        {selected.kind.toUpperCase()} original
      </button>
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
      <PreviewSelection workspace={workspace} view={navigation.view} />

      <div className="document-panes" data-view={navigation.view}>
        <EditorPane workspace={workspace} navigation={navigation} documentInfo={documentInfo} />
        <ReadingPane workspace={workspace} navigation={navigation} documentInfo={documentInfo} />
      </div>
    </section>
  );
}
