import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import {
  useAnnotationPanel,
  type AnnotationPanelController,
} from '../features/documents/useAnnotationPanel';
import DocumentAnnotations, { AnnotationToolbar } from '../features/documents/DocumentAnnotations';
import { Breadcrumbs } from '../features/navigation/Navigation';
import { EditorPane, ReadingPane, OriginalPreview } from './DocumentPanes';
import { DocumentNotices } from './WorkspaceStatus';
import { native } from './workspaceView';
import type { DocumentProps } from './workspaceView';

function DocumentToolbar({
  workspace,
  navigation,
  documentInfo,
  controller,
}: DocumentProps & { controller: AnnotationPanelController }) {
  const { buffer, dirty, busy } = workspace;
  const { view, setView } = navigation;
  const { note, activePath, activeName } = documentInfo;
  const disabled = !native || !!busy;
  const markdown = controller.owner?.kind === 'markdown';
  const saveDisabled = disabled || (!!note && !dirty) || !!buffer.conflict;

  return (
    <div className="document-toolbar">
      <div className="breadcrumb" data-tooltip={activePath ?? 'In-memory Markdown buffer'}>
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
        {markdown ? (
          <>
            <div className="view-controls" role="group" aria-label="Document view">
              <button
                className="icon-button"
                type="button"
                data-tooltip="Edit Markdown"
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
                data-tooltip="Reading view"
                aria-label="Reading view"
                aria-pressed={view === 'read'}
                onClick={() => setView('read')}
              >
                <WorkspaceIcon name="read" />
              </button>
              <button
                className="icon-button"
                type="button"
                data-tooltip="Split editor and preview"
                aria-label="Split editor and preview"
                aria-pressed={view === 'split'}
                onClick={() => setView('split')}
              >
                <WorkspaceIcon name="split" />
              </button>
            </div>
            <span className="toolbar-divider" aria-hidden="true" />
          </>
        ) : null}
        <div className="document-actions" role="group" aria-label="Document actions">
          <AnnotationToolbar controller={controller} disabled={disabled} />
          {markdown ? (
            <>
              <button
                className="icon-button"
                type="button"
                data-tooltip={
                  buffer.conflict
                    ? 'Resolve the disk conflict before saving'
                    : 'Save Markdown (Ctrl+S / ⌘S)'
                }
                aria-label={busy === 'save' ? 'Saving Markdown' : 'Save Markdown'}
                aria-busy={busy === 'save'}
                disabled={saveDisabled}
                onClick={workspace.save}
              >
                <WorkspaceIcon name="save" />
              </button>
              <button
                className="icon-button"
                type="button"
                data-tooltip="Save a recovery copy without changing either source"
                aria-label="Save recovery copy"
                disabled={disabled}
                onClick={workspace.saveCopy}
              >
                <WorkspaceIcon name="copy" />
              </button>
            </>
          ) : null}
          <button
            className="icon-button"
            type="button"
            data-tooltip={
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
  const controller = useAnnotationPanel(workspace);
  const previewTab = workspace.documents.activeTab;
  const original = previewTab?.kind === 'markdown' ? null : previewTab?.document;
  return (
    <section
      className="workbench"
      hidden={navigation.section !== 'workbench'}
      aria-label="Document workbench"
    >
      <DocumentToolbar
        workspace={workspace}
        navigation={navigation}
        documentInfo={documentInfo}
        controller={controller}
      />
      <DocumentNotices workspace={workspace} note={documentInfo.note} />
      <div className="document-workspace">
        <div
          className="document-panes"
          data-view={original ? 'read' : navigation.view}
          onFocus={controller.finishFocus}
        >
          {original && !previewTab?.restored ? (
            <section className="reading-pane" aria-label="Document reading surface">
              <OriginalPreview workspace={workspace} tab={previewTab} shown />
            </section>
          ) : (
            <>
              <EditorPane
                focusOnOpen={controller.focusOnOpen}
                workspace={workspace}
                navigation={navigation}
                documentInfo={documentInfo}
              />
              <ReadingPane
                workspace={workspace}
                navigation={navigation}
                documentInfo={documentInfo}
              />
            </>
          )}
        </div>
        {controller.visible ? (
          <DocumentAnnotations
            key={`${workspace.vault?.root}:${controller.owner?.id}`}
            workspace={workspace}
            controller={controller}
          />
        ) : null}
      </div>
    </section>
  );
}
