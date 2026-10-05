import type { Workspace } from './workspaceTypes';
import { tabIdentity } from './session/useDocumentSession';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { Dialog } from '../interaction/InteractionDialogs';
import TagInput from '../navigation/TagInput';
import { useTagCatalog } from '../navigation/useTagCatalog';
import type { TagsRequest, TagsSnapshot } from '../navigation/tagTypes';
import { errorMessage } from '../../shared/errors';
import Form from '../../shared/ui/Form';
import { tagError } from '../navigation/documentFilters';

function DocumentTags({
  path,
  identity,
  vaultKey,
  disabled,
  onSave,
  onClose,
}: {
  path: string;
  identity: string;
  vaultKey: string;
  disabled: boolean;
  onSave: (request: TagsRequest) => Promise<unknown>;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<TagsSnapshot | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const catalog = useTagCatalog(vaultKey, query);
  useEffect(() => {
    let active = true;
    void invoke<TagsSnapshot>('vault_tags', { path, expectedIdentity: identity })
      .then((value) => {
        if (active) {
          setSnapshot(value);
          setTags(value.tags);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [path, identity, retry]);
  async function save() {
    if (!snapshot || pending || disabled || snapshot.problem) {
      return;
    }
    const draft = query.trim();
    const problem = draft ? tagError(draft, tags) : null;
    if (problem) {
      setError(problem);
      return;
    }
    const savedTags = draft && !tags.includes(draft) ? [...tags, draft] : tags;
    setPending(true);
    setError(null);
    try {
      await onSave({
        path,
        expectedIdentity: identity,
        expectedRevision: snapshot.revision,
        tags: savedTags,
      });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  const blocked = disabled || pending;
  return (
    <Dialog
      open
      title="Document tags"
      description={path}
      className="document-tags-dialog"
      initialFocus="heading"
      onClose={() => {
        if (!blocked) {
          onClose();
        }
      }}
    >
      <Form
        className="document-tags-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p>Tags stay with this document in your Vault.</p>
        {snapshot ? (
          <TagInput
            focusWhenReady
            tags={tags}
            suggestions={tagSuggestions(catalog, snapshot)}
            onQuery={setQuery}
            onChange={setTags}
            disabled={blocked || !!snapshot.problem}
          />
        ) : (
          <p role="status">{error ? 'Tags are unavailable.' : 'Reading document tags…'}</p>
        )}
        {snapshot?.problem ? <p role="alert">{snapshot.problem}</p> : null}
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                setQuery('');
                setSnapshot(null);
                setRetry((value) => value + 1);
              }}
            >
              Reload saved tags
            </button>
          </div>
        ) : null}
        {catalog?.error ? (
          <p role="status">Tag suggestions could not be refreshed. You can still enter a tag.</p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" disabled={blocked} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={blocked || !snapshot || !!snapshot.problem}
          >
            {pending ? 'Saving…' : 'Save tags'}
          </button>
        </div>
      </Form>
    </Dialog>
  );
}

function tagSuggestions(catalog: ReturnType<typeof useTagCatalog>, snapshot: TagsSnapshot) {
  return catalog?.snapshot?.suggestions ?? snapshot.suggestions;
}

export function DocumentTagAction({
  workspace,
  path,
  disabled,
}: {
  workspace: Workspace;
  path: string | null;
  disabled: boolean;
}) {
  const owner = workspace.documents.activeTab;
  const identity = owner ? tabIdentity(owner) : null;
  if (
    !workspace.vault ||
    !path ||
    !identity ||
    !owner ||
    owner.restored ||
    owner.conflict?.removed
  ) {
    return null;
  }
  return (
    <DocumentTagSession
      key={`${workspace.vault.root}:${workspace.vault.id}:${owner.id}`}
      workspace={workspace}
      path={path}
      identity={identity}
      vaultKey={`${workspace.vault.root}:${workspace.vault.id}`}
      disabled={disabled}
    />
  );
}

function DocumentTagSession({
  workspace,
  path,
  identity,
  vaultKey,
  disabled,
}: {
  workspace: Workspace;
  path: string;
  identity: string;
  vaultKey: string;
  disabled: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const unsaved = workspace.dirty || !!workspace.buffer.conflict;
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label="Document tags"
        data-tooltip={unsaved ? 'Save or resolve the note before editing tags' : 'Document tags'}
        disabled={disabled || unsaved}
        data-unavailable={unsaved}
        onClick={() => setVisible(true)}
      >
        <WorkspaceIcon name="tag" />
      </button>
      {visible ? (
        <DocumentTags
          path={path}
          identity={identity}
          vaultKey={vaultKey}
          disabled={disabled}
          onSave={workspace.changeTags}
          onClose={() => setVisible(false)}
        />
      ) : null}
    </>
  );
}
