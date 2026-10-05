import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { getSaveStatus, indexLabels, native } from './workspaceView';
import type { DocumentInfo, DocumentProps, WorkspaceProps } from './workspaceView';

export function WorkspaceNotices({ workspace }: WorkspaceProps) {
  const { notice } = workspace;

  if (!notice) {
    return null;
  }

  return (
    <div
      className={`workbench-notice workspace-notice ${notice.error ? 'error' : ''}`}
      role={notice.error ? 'alert' : 'status'}
    >
      <span>{notice.text}</span>
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss notification"
        data-tooltip="Dismiss notification"
        onClick={workspace.dismissNotice}
      >
        <WorkspaceIcon name="close" />
      </button>
    </div>
  );
}

export function DocumentNotices({
  workspace,
  note,
}: WorkspaceProps & { note: DocumentInfo['note'] }) {
  const { buffer, busy } = workspace;
  const disabled = !native || !!busy;

  let recoveryHint = '';
  if (buffer.conflict && !buffer.conflict.removed) {
    recoveryHint = buffer.conflict.current
      ? 'Reload the disk version or keep your edits in a separate recovery file.'
      : 'Save a recovery copy to preserve your changes at a new path.';
  }

  if (workspace.documents.activeTab?.kind !== 'markdown') {
    return null;
  }

  return (
    <>
      {note?.metadataError && !buffer.conflict?.removed ? (
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
            {buffer.conflict.message} {recoveryHint}
          </span>
          <div>
            {!buffer.conflict.removed ? (
              <button
                type="button"
                disabled={disabled || !buffer.conflict.current}
                onClick={workspace.reloadDisk}
              >
                Reload disk
              </button>
            ) : null}
            <button type="button" disabled={disabled} onClick={workspace.saveCopy}>
              Save recovery copy
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function BufferStatus({ workspace }: WorkspaceProps) {
  const { buffer, dirty, busy, documents } = workspace;
  const tab = documents.activeTab;
  let saveStatus = getSaveStatus(workspace);
  let saveState = 'saved';
  if (buffer.conflict || tab?.hydration?.state === 'error') {
    saveState = 'error';
  } else if (tab?.restored) {
    saveState = 'busy';
  } else if (busy === 'save') {
    saveState = 'busy';
    saveStatus = 'Saving…';
  } else if (dirty || saveStatus === 'Not saved yet') {
    saveState = 'pending';
  }

  return (
    <span className="buffer-status" data-state={saveState} role="status" aria-atomic="true">
      {saveState === 'error' ? <WorkspaceIcon name="warning" /> : null}
      {saveStatus}
    </span>
  );
}

export function StatusBar({
  workspace,
  navigation,
  revealIndexDetails,
}: DocumentProps & { revealIndexDetails: () => void }) {
  const { documents, indexing } = workspace;
  const isMarkdown = documents.activeTab?.kind === 'markdown';
  const indexWarning =
    !navigation.sidebarOpen && (indexing?.state === 'partial' || indexing?.state === 'cancelled')
      ? indexing.state
      : null;

  if (native && !isMarkdown && !indexWarning) {
    return null;
  }

  return (
    <footer className="status-bar">
      {!native ? (
        <span
          className="runtime-notice"
          data-tooltip="Launch the Tauri desktop application to open local documents, save Notes, check accounts, and use the OS credential store."
        >
          <WorkspaceIcon name="warning" />
          Browser preview
        </span>
      ) : null}
      {indexWarning ? (
        <button
          type="button"
          className="status-index-warning"
          onClick={revealIndexDetails}
          data-tooltip="Open the Explorer to view indexing details."
        >
          <WorkspaceIcon name="warning" />
          {indexLabels[indexWarning]} · View details
        </button>
      ) : null}
      {isMarkdown ? <BufferStatus workspace={workspace} /> : null}
    </footer>
  );
}
