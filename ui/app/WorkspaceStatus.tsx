import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { getSaveStatus, indexLabels, native } from './workspaceView';
import type { DocumentInfo, DocumentProps, WorkspaceProps } from './workspaceView';

export function WorkspaceNotices({ workspace }: WorkspaceProps) {
  const { notice, busy, prompt } = workspace;

  return (
    <>
      {notice ? (
        <div
          className={`workbench-notice ${notice.error ? 'error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.text}
        </div>
      ) : null}
      {busy === 'navigate' && !prompt ? (
        <div className="workbench-notice" role="status">
          Working with local files… Your buffer is kept until the operation succeeds.
        </div>
      ) : null}
    </>
  );
}

export function DocumentNotices({
  workspace,
  note,
}: WorkspaceProps & { note: DocumentInfo['note'] }) {
  const { buffer, busy } = workspace;
  const disabled = !native || !!busy;

  return (
    <>
      {note?.metadataError ? (
        <div className="workbench-notice metadata-notice" role="status">
          <span>
            <strong>Metadata issue.</strong> {note.metadataError} Raw Markdown remains editable;
            Save never adopts or repairs it.
          </span>
          {!note.id ? (
            <button type="button" disabled={disabled} onClick={workspace.adoptNote}>
              Adopt as Note
            </button>
          ) : null}
        </div>
      ) : null}
      {buffer.conflict ? (
        <div className="workbench-notice conflict-notice" role="alert">
          <span>
            {buffer.conflict.message}{' '}
            {buffer.conflict.current
              ? 'Reload the disk version or keep your edits in a separate recovery file.'
              : 'Save a recovery copy to preserve your changes at a new path.'}
          </span>
          <div>
            <button
              type="button"
              disabled={disabled || !buffer.conflict.current}
              onClick={workspace.reloadDisk}
            >
              Reload disk
            </button>
            <button type="button" disabled={disabled} onClick={workspace.saveCopy}>
              Save recovery copy
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function IndexStatus({
  workspace,
  sidebarOpen,
  revealIndexDetails,
}: WorkspaceProps & { sidebarOpen: boolean; revealIndexDetails: () => void }) {
  const { indexing } = workspace;
  if (!indexing || indexing.state === 'ready') {
    return null;
  }
  if (indexing.state === 'indexing') {
    return (
      <span className="background-indexing" role="status">
        Indexing in background…
      </span>
    );
  }
  if (sidebarOpen) {
    return null;
  }

  return (
    <button type="button" className="status-index-warning" onClick={revealIndexDetails}>
      {indexLabels[indexing.state]} — view details
    </button>
  );
}

export function StatusBar({
  workspace,
  navigation,
  documentInfo,
  revealIndexDetails,
}: DocumentProps & { revealIndexDetails: () => void }) {
  const { vault, buffer, dirty } = workspace;
  const { readingDocument, note } = documentInfo;
  let format = note ? 'Markdown · Raw source' : 'Markdown';
  if (readingDocument) {
    format = `${readingDocument.kind.toUpperCase()} · Original unchanged`;
  }

  return (
    <footer className="status-bar">
      {!native ? (
        <span
          className="runtime-notice"
          title="Launch the Tauri desktop application to open local documents, save Notes, check accounts, and use the OS credential store."
        >
          <WorkspaceIcon name="warning" />
          Browser preview: desktop features unavailable
        </span>
      ) : (
        <span className="runtime-status" title={vault?.root}>
          {vault?.name ?? 'No Vault open'}
        </span>
      )}
      <IndexStatus
        workspace={workspace}
        sidebarOpen={navigation.sidebarOpen}
        revealIndexDetails={revealIndexDetails}
      />
      <span
        className={dirty || buffer.conflict ? 'buffer-status unsaved-label' : 'buffer-status'}
        role="status"
      >
        {getSaveStatus(workspace)}
      </span>
      <span className="status-format">{format}</span>
    </footer>
  );
}
