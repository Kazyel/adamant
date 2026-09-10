import { useState } from 'react';
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
    <DialogFrame title={prompt.title} cancel={() => answer(null)}>
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
  if (prompt.kind === 'guard') {
    return (
      <DialogFrame title={prompt.title} cancel={() => answer(null)}>
        <p id="workspace-dialog-description">
          Your Markdown has unsaved changes or an unresolved disk conflict. Save it before
          continuing, discard it for this action, or cancel to keep working. A failed save will keep
          your buffer here.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="button" onClick={() => answer('discard')}>
            Discard
          </button>
          <button type="button" className="primary" onClick={() => answer('save')}>
            Save
          </button>
        </div>
      </DialogFrame>
    );
  }

  return (
    <DialogFrame title={prompt.title} cancel={() => answer(null)}>
      <p id="workspace-dialog-description">
        Notes are saved inside a Vault. Choose its folder first; your editor buffer stays intact.
        Standalone originals are never overwritten.
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={() => answer(null)}>
          Cancel
        </button>
        <button type="button" onClick={() => answer('open')}>
          Open Vault
        </button>
        <button type="button" onClick={() => answer('create')}>
          Create Vault
        </button>
      </div>
    </DialogFrame>
  );
}
