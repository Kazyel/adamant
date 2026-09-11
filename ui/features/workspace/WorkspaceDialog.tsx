import { useState } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import CreateVaultDialog from './CreateVaultDialog';
import DialogFrame from './DialogFrame';
import type { WorkspacePrompt } from './types';

type AnswerPrompt = (value: string | null) => void;

function NotePathDialog({
  prompt,
  answer,
}: {
  prompt: Extract<WorkspacePrompt, { kind: 'path' }>;
  answer: AnswerPrompt;
}) {
  const [path, setPath] = useState(prompt.initial);
  let submitLabel = 'Create Note';

  if (prompt.recovery) {
    submitLabel = 'Save recovery copy';
  } else if (prompt.title.startsWith('Import')) {
    submitLabel = 'Choose source file';
  }

  return (
    <DialogFrame
      title={prompt.title}
      className="replace-dialog session-dialog"
      cancel={() => answer(null)}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (path) {
            answer(path);
          }
        }}
      >
        <p id="workspace-dialog-description">
          {prompt.recovery
            ? 'Save an exact copy of your editor source without replacing either version. Metadata, including its identity, is kept unchanged; duplicate identities will appear in Vault issues.'
            : 'Choose a Markdown path relative to this Vault. Parent folders are created if needed. New and imported Notes receive an identity explicitly; existing files are never overwritten.'}
        </p>
        <label className="path-label" htmlFor="note-destination">
          Note path
        </label>
        <input
          id="note-destination"
          required
          aria-describedby="workspace-dialog-description"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="dialog-actions">
          <button type="button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!path}>
            {submitLabel}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

export default function WorkspaceDialog({
  prompt,
  answer,
}: {
  prompt: WorkspacePrompt;
  answer: AnswerPrompt;
}) {
  if (prompt.kind === 'create') {
    return <CreateVaultDialog prompt={prompt} answer={answer} />;
  }
  if (prompt.kind === 'path') {
    return <NotePathDialog prompt={prompt} answer={answer} />;
  }
  if (prompt.kind === 'confirm') {
    return (
      <DialogFrame
        title={prompt.title}
        className="replace-dialog session-dialog"
        cancel={() => answer(null)}
      >
        <p>{prompt.description}</p>
        <div className="dialog-actions">
          <button type="button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => answer('confirm')}>
            {prompt.confirmLabel}
          </button>
        </div>
      </DialogFrame>
    );
  }
  if (prompt.kind === 'guard') {
    const count = prompt.documents?.length ?? 0;
    return (
      <DialogFrame
        title={prompt.title}
        className="replace-dialog session-dialog session-guard-dialog"
        cancel={() => answer(null)}
      >
        <p id="workspace-dialog-description">
          These documents have unsaved changes or a disk conflict. Save before continuing, or cancel
          to leave every document intact. If a save fails, that document is retained.
        </p>
        {count ? (
          <section className="session-dialog-section" aria-label="Affected documents">
            <h3>
              {count} {count === 1 ? 'document needs' : 'documents need'} attention
            </h3>
            <ul className="session-document-list">
              {prompt.documents!.map((path, index) => {
                const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
                return (
                  <li key={`${index}:${path}`}>
                    <WorkspaceIcon name="document" />
                    <div>
                      <strong>{path.slice(separator + 1) || path}</strong>
                      {separator >= 0 ? (
                        <span className="session-dialog-path">
                          {path.slice(0, separator) || '/'}
                        </span>
                      ) : null}
                    </div>
                    <span className="buffer-dot" aria-hidden="true" />
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => answer('save')}>
            <WorkspaceIcon name="save" />
            {count > 1 ? 'Save all' : 'Save changes'}
          </button>
        </div>
        <section className="session-danger-zone" aria-label="Discard unsaved changes">
          <p>Discarding removes unsaved changes from the affected documents.</p>
          <button type="button" className="session-danger-button" onClick={() => answer('discard')}>
            <WorkspaceIcon name="trash" />
            {count > 1 ? 'Discard all changes' : 'Discard changes'}
          </button>
        </section>
      </DialogFrame>
    );
  }

  return (
    <DialogFrame
      title={prompt.title}
      className="replace-dialog session-dialog"
      cancel={() => answer(null)}
    >
      <p id="workspace-dialog-description">
        Notes are saved inside a Vault. Choose its folder first; your editor buffer stays intact.
        Standalone originals are never overwritten.
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={() => answer(null)}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => answer('open')}>
          Open Vault
        </button>
        <button type="button" onClick={() => answer('create')}>
          Create Vault
        </button>
      </div>
    </DialogFrame>
  );
}
