import { useEffect, useRef } from 'react';
import WorkspaceIcon from '../../../shared/ui/WorkspaceIcon';
import type { DraftRecord } from './persistence';
import DialogFrame from '../DialogFrame';

export interface RecoveryDialogProps {
  draft: DraftRecord;
  sourceText: string | null;
  sourceChanged: boolean;
  onRecover: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export default function RecoveryDialog({
  draft,
  sourceText,
  sourceChanged,
  onRecover,
  onDiscard,
  onCancel,
}: RecoveryDialogProps) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelButton.current?.focus({ preventScroll: true });
  }, []);
  const title = sourceChanged ? 'Review recovered changes' : 'Recover unsaved changes?';
  return (
    <DialogFrame
      title={title}
      className="replace-dialog session-dialog recovery-dialog"
      cancel={onCancel}
    >
      <div className="recovery-document">
        <WorkspaceIcon name="document" />
        <div>
          <strong className="session-dialog-path">{draft.path || 'New document'}</strong>
          <span>Draft saved {new Date(draft.savedAt).toLocaleString()}</span>
        </div>
      </div>
      <p>
        {sourceChanged
          ? 'The source changed after this draft was saved. Recover the draft separately to keep both versions.'
          : 'Review the retained draft before recovering it. The saved source is not overwritten.'}
      </p>
      {sourceChanged ? (
        <div className="session-alert" role="alert">
          <WorkspaceIcon name="warning" />
          <p>
            {sourceText === null
              ? 'The saved source is unavailable.'
              : 'The source changed on disk.'}{' '}
            Neither version will be discarded automatically.
          </p>
        </div>
      ) : null}
      <div className="recovery-previews">
        <details className="recovery-preview recovery-preview-draft" open>
          <summary>
            <WorkspaceIcon name="restore" />
            Recovered draft
          </summary>
          <textarea
            className="recovery-source"
            readOnly
            rows={8}
            value={draft.text}
            placeholder="Empty draft"
            aria-label="Recovered draft source"
            spellCheck={false}
          />
        </details>
        <details className="recovery-preview" open={sourceChanged}>
          <summary>
            <WorkspaceIcon name="save" />
            Current saved source
          </summary>
          {sourceText === null ? (
            <p className="recovery-unavailable">
              The source is unavailable. Recovering keeps the draft in a separate new document tab.
            </p>
          ) : (
            <textarea
              className="recovery-source"
              readOnly
              rows={8}
              value={sourceText}
              placeholder="Empty source"
              aria-label="Current saved source"
              spellCheck={false}
            />
          )}
        </details>
      </div>
      <div className="dialog-actions">
        <button type="button" ref={cancelButton} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={onRecover}>
          <WorkspaceIcon name="restore" />
          Recover draft
        </button>
      </div>
      <section className="session-danger-zone" aria-label="Discard recovered draft">
        <p>Discard only the retained draft. The saved source stays unchanged.</p>
        <button type="button" className="session-danger-button" onClick={onDiscard}>
          <WorkspaceIcon name="trash" />
          Discard draft
        </button>
      </section>
    </DialogFrame>
  );
}
