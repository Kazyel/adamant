import { useState } from 'react';
import { errorMessage } from '../../shared/errors';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import DialogFrame from './DialogFrame';
import type { FileActions } from './useFileActions';
import type { RecoveryRecord } from './usabilityTypes';

function RecoveryReview({
  record,
  actions,
  close,
  reveal,
}: {
  record: RecoveryRecord;
  actions: FileActions;
  close: () => void;
  reveal: (path: string) => void;
}) {
  const [destination, setDestination] = useState(`Recovered-${record.id}`);
  const [acknowledging, setAcknowledging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function execute(action: () => Promise<unknown>) {
    setError(null);
    setStatus(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <DialogFrame
      title="Review interrupted file operation"
      className="replace-dialog session-dialog mutation-recovery-dialog"
      pending={actions.busy}
      cancel={() => {
        if (!actions.busy) {
          close();
        }
      }}
    >
      <div className="session-alert">
        <WorkspaceIcon name="warning" />
        <p>{record.message}</p>
      </div>
      <p>
        Source writes stay blocked until this operation is safely recovered, or you export the
        retained versions and explicitly choose to keep the current files.
      </p>
      <div className="recovery-operation">
        <span>Operation</span>
        <code className="session-dialog-path">{record.id}</code>
      </div>
      {record.versions.length ? (
        <details className="recovery-paths">
          <summary>
            {record.versions.length} affected {record.versions.length === 1 ? 'path' : 'paths'}
          </summary>
          <ul className="session-path-list">
            {record.versions.slice(0, 200).map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          {record.versions.length > 200 ? (
            <p>
              Showing 200 paths. The export contains the complete manifest and retained versions.
            </p>
          ) : null}
        </details>
      ) : null}
      {error ? (
        <p className="session-message error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="session-message" role="status">
          {status}
        </p>
      ) : null}
      {actions.busy ? (
        <p className="session-message" role="status">
          Working on recovery…
        </p>
      ) : null}
      <section className="session-dialog-section" aria-label="Safe recovery">
        <h3>Resume safely</h3>
        <p>Retry the interrupted operation using its retained versions and safety checks.</p>
        <div className="recovery-section-actions">
          <button
            type="button"
            className="primary"
            disabled={actions.busy}
            onClick={() =>
              void execute(async () => {
                const result = await actions.recoverMutation(record.id);
                setStatus(result.message);
              })
            }
          >
            <WorkspaceIcon name="refresh" />
            Retry safe recovery
          </button>
        </div>
      </section>
      <section className="session-dialog-section" aria-label="Export retained versions">
        <h3>Preserve a copy for review</h3>
        <p>Export the complete manifest and retained versions without replacing current files.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void execute(async () => {
              await actions.exportRecovery(record.id, destination.trim());
              setStatus(
                'Retained versions exported. Review them before keeping the current files.',
              );
            });
          }}
        >
          <label className="path-label" htmlFor="recovery-export">
            New export folder
          </label>
          <input
            id="recovery-export"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            disabled={actions.busy}
            aria-describedby="recovery-export-help"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <p className="session-field-help" id="recovery-export-help">
            Relative to this Vault.
          </p>
          <div className="recovery-section-actions">
            <button type="submit" disabled={actions.busy || !destination.trim()}>
              <WorkspaceIcon name="copy" />
              Export retained versions
            </button>
          </div>
        </form>
        {record.exportedTo ? (
          <div className="recovery-verified-export">
            <div>
              <WorkspaceIcon name="check" />
              <span>Verified export</span>
            </div>
            <strong className="session-dialog-path">{record.exportedTo}</strong>
            <div className="recovery-section-actions">
              <button
                type="button"
                disabled={actions.busy}
                onClick={() => {
                  close();
                  reveal(record.exportedTo!);
                }}
              >
                <WorkspaceIcon name="folder" />
                Show exported versions
              </button>
            </div>
          </div>
        ) : null}
      </section>
      <div className="dialog-actions">
        <button type="button" disabled={actions.busy} onClick={close}>
          Close
        </button>
      </div>
      {record.exportedTo ? (
        <section className="session-danger-zone" aria-label="Keep current files">
          <h3>Resolve without retrying</h3>
          <p>
            Review the verified export first. Keeping current files stops automatic recovery; links
            or source differences may still need manual merging.
          </p>
          {acknowledging ? (
            <div
              className="recovery-confirmation"
              role="group"
              aria-label="Confirm recovery resolution"
            >
              <p>
                Keep the current files for operation{' '}
                <strong className="session-dialog-path">{record.id}</strong>? All retained versions
                will remain in the export and private archive.
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  disabled={actions.busy}
                  onClick={() => setAcknowledging(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="session-danger-button"
                  disabled={actions.busy}
                  onClick={() => void execute(() => actions.acknowledgeRecovery(record.id))}
                >
                  Keep current files and archive recovery
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="session-danger-button"
              disabled={actions.busy}
              onClick={() => setAcknowledging(true)}
            >
              Keep current files…
            </button>
          )}
        </section>
      ) : null}
    </DialogFrame>
  );
}

export default function MutationRecovery({
  actions,
  reveal,
}: {
  actions: FileActions;
  reveal: (path: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const record = actions.recoveries.find((item) => item.id === selected);
  if (!actions.recoveries.length) {
    return null;
  }
  return (
    <>
      <div className="workspace-notice recovery-notice" role="status">
        <WorkspaceIcon name="warning" />
        <div className="recovery-notice-content">
          <span>
            {actions.recoveries.length} interrupted file operation
            {actions.recoveries.length === 1 ? '' : 's'} need review. Retained versions have not
            been discarded.
          </span>
          <div className="recovery-notice-actions">
            {actions.recoveries.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={actions.busy}
                onClick={() => setSelected(item.id)}
              >
                Review operation {item.id.slice(0, 8)}
              </button>
            ))}
          </div>
        </div>
      </div>
      {record ? (
        <RecoveryReview
          key={record.id}
          record={record}
          actions={actions}
          close={() => setSelected(null)}
          reveal={reveal}
        />
      ) : null}
    </>
  );
}
