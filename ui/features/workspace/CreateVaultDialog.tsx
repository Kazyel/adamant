import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import DialogFrame from './DialogFrame';
import type { VaultSnapshot, WorkspacePrompt } from './types';

function invalidVaultName(name: string) {
  if (!name) {
    return false;
  }
  if (
    new TextEncoder().encode(name).length > 255 ||
    name.trim() !== name ||
    /[\\/:*?"<>|]/.test(name) ||
    name.endsWith('.')
  ) {
    return true;
  }

  for (const character of name) {
    const code = character.codePointAt(0)!;

    if (code < 32 || code === 127) {
      return true;
    }
  }

  return false;
}

function vaultDestination(parent: string | null, name: string) {
  if (!parent) {
    return '';
  }

  const separator = parent.startsWith('/') ? '/' : '\\';
  const prefix = parent.endsWith(separator) ? parent : parent + separator;

  return prefix + name;
}

function ParentFolderStep({
  parent,
  pending,
  error,
  chooseParent,
  next,
  cancel,
}: {
  parent: string | null;
  pending: 'choose' | 'create' | null;
  error: string;
  chooseParent: () => void;
  next: () => void;
  cancel: () => void;
}) {
  const chooseButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    chooseButton.current?.focus();
  }, []);

  let parentLabel = 'Choose parent folder…';

  if (pending === 'choose') {
    parentLabel = 'Choosing folder…';
  } else if (parent) {
    parentLabel = 'Change parent folder…';
  }

  return (
    <>
      <p id="workspace-dialog-description">
        Choose where your Vault will live. Adamant will create a new folder inside this location.
      </p>
      {parent ? (
        <div className="vault-destination">
          <span>Parent folder</span>
          <strong>{parent}</strong>
        </div>
      ) : null}
      <button
        className="choose-parent"
        ref={chooseButton}
        type="button"
        disabled={!!pending}
        onClick={chooseParent}
      >
        <WorkspaceIcon name="folder" />
        {parentLabel}
      </button>
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" disabled={!!pending} onClick={cancel}>
          Cancel
        </button>
        {parent ? (
          <button type="button" className="primary" disabled={!!pending} onClick={next}>
            Next
          </button>
        ) : null}
      </div>
    </>
  );
}

export default function CreateVaultDialog({
  prompt,
  answer,
}: {
  prompt: Extract<WorkspacePrompt, { kind: 'create' }>;
  answer: (value: string | null) => void;
}) {
  const [step, setStep] = useState<'parent' | 'name'>('parent');
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState<'choose' | 'create' | null>(null);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const invalidName = invalidVaultName(name);
  const destination = vaultDestination(parent, name);

  function cancel() {
    if (!pendingRef.current) {
      answer(null);
    }
  }

  async function chooseParent() {
    if (pendingRef.current) {
      return;
    }

    pendingRef.current = true;
    setPending('choose');
    setError('');

    try {
      const selected = await invoke<string | null>('vault_select_parent');

      if (selected) {
        setParent(selected);
        setStep('name');
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  async function create() {
    if (pendingRef.current || !name || invalidName || !parent) {
      return;
    }

    pendingRef.current = true;
    setPending('create');
    setError('');

    try {
      prompt.complete(await invoke<VaultSnapshot>('vault_create', { name }));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  useEffect(() => {
    if (step === 'name') {
      nameInput.current?.focus();
    }
  }, [step]);

  return (
    <DialogFrame title={prompt.title} creating pending={!!pending} cancel={cancel}>
      <ol className="wizard-steps" aria-label="Create Vault steps">
        <li aria-current={step === 'parent' ? 'step' : undefined}>1. Location</li>
        <li aria-current={step === 'name' ? 'step' : undefined}>2. Name</li>
      </ol>
      {step === 'parent' ? (
        <ParentFolderStep
          parent={parent}
          pending={pending}
          error={error}
          chooseParent={() => void chooseParent()}
          next={() => setStep('name')}
          cancel={cancel}
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <p id="workspace-dialog-description">
            Name the new folder. Existing folders and files will not be changed.
          </p>
          <label className="path-label" htmlFor="vault-name">
            Vault name
          </label>
          <input
            id="vault-name"
            ref={nameInput}
            required
            value={name}
            disabled={!!pending}
            aria-invalid={invalidName}
            aria-describedby={invalidName ? 'vault-name-error' : 'vault-destination'}
            onChange={(event) => {
              setName(event.target.value);
              setError('');
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="My Vault"
          />
          {invalidName ? (
            <p id="vault-name-error" className="dialog-error">
              Use a single folder name without path separators, special characters, or
              leading/trailing spaces.
            </p>
          ) : null}
          <div id="vault-destination" className="vault-destination">
            <span>Create new folder at</span>
            <strong>{destination || parent}</strong>
          </div>
          {error ? (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-back"
              disabled={!!pending}
              onClick={() => {
                setStep('parent');
                setError('');
              }}
            >
              Back
            </button>
            <button type="button" disabled={!!pending} onClick={cancel}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!!pending || !name || invalidName}>
              {pending === 'create' ? 'Creating…' : 'Create Vault'}
            </button>
          </div>
        </form>
      )}
    </DialogFrame>
  );
}
