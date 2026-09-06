import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage } from './document';
import WorkspaceIcon from './WorkspaceIcon';
import type { VaultSnapshot } from './useWorkspace';
import type { WorkspacePrompt } from './useWorkspace';

export default function WorkspaceDialog({ prompt, answer }: { prompt: WorkspacePrompt; answer: (value: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(prompt.kind === 'path' ? prompt.initial : '');
  const [step, setStep] = useState<'parent' | 'name'>('parent');
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState<'choose' | 'create' | null>(null);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const invalidName = name.length > 0 && (new TextEncoder().encode(name).length > 255 || name.trim() !== name || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name) || name.endsWith('.') || name === '..');
  const separator = parent?.startsWith('/') ? '/' : '\\';
  const destination = parent ? parent + (parent.endsWith(separator) ? '' : separator) + name : '';
  let parentLabel = 'Choose parent folder…';
  if (pending === 'choose') parentLabel = 'Choosing folder…';
  else if (parent) parentLabel = 'Change parent folder…';
  async function chooseParent() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending('choose');
    setError('');
    try {
      const selected = await invoke<string | null>('vault_select_parent');
      if (selected) {
        setParent(selected);
        setStep('name');
      }
    } catch (error) { setError(errorMessage(error)); }
    finally { pendingRef.current = false; setPending(null); }
  }
  async function create() {
    if (prompt.kind !== 'create' || pendingRef.current || !name || invalidName || !parent) return;
    pendingRef.current = true;
    setPending('create');
    setError('');
    try { prompt.complete(await invoke<VaultSnapshot>('vault_create', { name })); }
    catch (error) { setError(errorMessage(error)); }
    finally { pendingRef.current = false; setPending(null); }
  }
  useEffect(() => { if (step === 'name') nameInput.current?.focus(); }, [step]);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog className={`replace-dialog${prompt.kind === 'create' ? ' create-vault-dialog' : ''}`} ref={dialog} onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) answer(null); }} aria-labelledby="workspace-dialog-title" aria-describedby="workspace-dialog-description" aria-busy={!!pending}>
    <h2 id="workspace-dialog-title">{prompt.title}</h2>
    {prompt.kind === 'create' ? <>
      <ol className="wizard-steps" aria-label="Create Vault steps"><li aria-current={step === 'parent' ? 'step' : undefined}>1. Location</li><li aria-current={step === 'name' ? 'step' : undefined}>2. Name</li></ol>
      {step === 'parent' ? <>
        <p id="workspace-dialog-description">Choose where your Vault will live. Adamant will create a new folder inside this location.</p>
        {parent ? <div className="vault-destination"><span>Parent folder</span><strong>{parent}</strong></div> : null}
        <button className="choose-parent" type="button" autoFocus disabled={!!pending} onClick={() => void chooseParent()}><WorkspaceIcon name="folder" />{parentLabel}</button>
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" disabled={!!pending} onClick={() => answer(null)}>Cancel</button>{parent ? <button type="button" className="primary" disabled={!!pending} onClick={() => setStep('name')}>Next</button> : null}</div>
      </> : <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <p id="workspace-dialog-description">Name the new folder. Existing folders and files will not be changed.</p>
        <label className="path-label" htmlFor="vault-name">Vault name</label>
        <input id="vault-name" ref={nameInput} required value={name} disabled={!!pending} aria-invalid={invalidName} aria-describedby={invalidName ? 'vault-name-error' : 'vault-destination'} onChange={(event) => { setName(event.target.value); setError(''); }} autoComplete="off" spellCheck={false} placeholder="My Vault" />
        {invalidName ? <p id="vault-name-error" className="dialog-error">Use a single folder name without path separators, special characters, or leading/trailing spaces.</p> : null}
        <div id="vault-destination" className="vault-destination"><span>Create new folder at</span><strong>{destination || parent}</strong></div>
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="dialog-back" disabled={!!pending} onClick={() => { setStep('parent'); setError(''); }}>Back</button><button type="button" disabled={!!pending} onClick={() => answer(null)}>Cancel</button><button type="submit" className="primary" disabled={!!pending || !name || invalidName}>{pending === 'create' ? 'Creating…' : 'Create Vault'}</button></div>
      </form>}
    </> : prompt.kind === 'guard' ? <>
      <p id="workspace-dialog-description">Your Markdown has unsaved changes or an unresolved disk conflict. Save it before continuing, discard it for this action, or cancel to keep working. A failed save will keep your buffer here.</p>
      <div className="dialog-actions"><button type="button" autoFocus onClick={() => answer(null)}>Cancel</button><button type="button" onClick={() => answer('discard')}>Discard</button><button type="button" className="primary" onClick={() => answer('save')}>Save</button></div>
    </> : prompt.kind === 'vault' ? <>
      <p id="workspace-dialog-description">Notes are saved inside a Vault. Choose its folder first; your editor buffer stays intact. Standalone originals are never overwritten.</p>
      <div className="dialog-actions"><button type="button" autoFocus onClick={() => answer(null)}>Cancel</button><button type="button" onClick={() => answer('open')}>Open Vault</button><button type="button" className="primary" onClick={() => answer('create')}>Create Vault</button></div>
    </> : <form onSubmit={(event) => { event.preventDefault(); if (path) answer(path); }}>
      <p id="workspace-dialog-description">{prompt.recovery ? 'Save an exact copy of your editor source without replacing either version. Metadata, including its identity, is kept unchanged; duplicate identities will appear in Vault issues.' : 'Choose a Markdown path relative to this Vault. Parent folders are created if needed. New and imported Notes receive an identity explicitly; existing files are never overwritten.'}</p>
      <label className="path-label" htmlFor="note-destination">Note path</label>
      <input id="note-destination" autoFocus required value={path} onChange={(event) => setPath(event.target.value)} autoComplete="off" spellCheck={false} />
      <div className="dialog-actions"><button type="button" onClick={() => answer(null)}>Cancel</button><button type="submit" className="primary" disabled={!path}>{prompt.recovery ? 'Save recovery copy' : prompt.title.startsWith('Import') ? 'Choose source file' : 'Create Note'}</button></div>
    </form>}
  </dialog>;
}
