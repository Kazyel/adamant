import SearchField from '../../shared/ui/SearchField';
import Form from '../../shared/ui/Form';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '../interaction/InteractionDialogs';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { Workspace } from '../workspace/workspaceTypes';
import type { AnnotationLink, AnnotationRequest, AnnotationSnapshot } from './annotationTypes';
import type { AnnotationPanelController } from './useAnnotationPanel';

type ChangeAction = (action: AnnotationRequest['action']) => Promise<void>;

export function AnnotationToolbar({
  controller,
  disabled,
}: {
  controller: AnnotationPanelController;
  disabled: boolean;
}) {
  if (!controller.available) {
    return null;
  }
  const markdown = controller.owner?.kind === 'markdown';
  return (
    <div className="annotation-tools" role="group" aria-label="Annotation tools">
      {!markdown ? (
        <>
          <button
            type="button"
            className="annotation-tool"
            disabled={disabled}
            onClick={() => controller.show('create')}
            data-tooltip="Create a note alongside this document"
          >
            <WorkspaceIcon name="new" />
            <span>New note</span>
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={disabled}
            onClick={() => controller.show('link')}
            aria-label="Link existing note"
            data-tooltip="Link existing note"
          >
            <WorkspaceIcon name="link" />
          </button>
        </>
      ) : null}
      <button
        type="button"
        className="annotation-tool"
        disabled={disabled}
        aria-expanded={controller.visible && controller.mode === 'notes'}
        aria-controls="annotation-panel"
        onClick={() =>
          controller.visible && controller.mode === 'notes'
            ? controller.close()
            : controller.show('notes')
        }
        data-tooltip={markdown ? 'Source documents' : 'Show annotations'}
      >
        <WorkspaceIcon name={markdown ? 'document' : 'edit'} />
        <span>{markdown ? 'Sources' : 'Notes'}</span>
      </button>
    </div>
  );
}

function MaterialList({
  links,
  disabled,
  linking = false,
  onOpen,
  onUnlink,
}: {
  links: AnnotationLink[];
  disabled: boolean;
  linking?: boolean;
  onOpen: (link: AnnotationLink) => void;
  onUnlink?: (id: string) => void;
}) {
  return (
    <ul className="annotation-list" aria-label={linking ? 'Available notes' : 'Linked materials'}>
      {links.map((link) => {
        const filename = link.path?.split('/').pop()?.replace(/\.md$/i, '');
        const folder = link.path?.split('/').slice(0, -1).join('/');
        return (
          <li key={link.id}>
            <button
              type="button"
              className="annotation-target"
              disabled={disabled || !link.path}
              onClick={() => onOpen(link)}
              data-tooltip={link.path ?? link.problem ?? 'Note unavailable'}
            >
              <WorkspaceIcon name={link.path ? 'document' : 'warning'} />
              <span>
                <strong>{filename ?? 'Note unavailable'}</strong>
                {folder ? <small>{folder}</small> : null}
                {!link.path ? <small>The linked file could not be resolved.</small> : null}
              </span>
              {linking ? <WorkspaceIcon name="plus" /> : <WorkspaceIcon name="chevron" />}
            </button>
            {onUnlink ? (
              <button
                type="button"
                className="icon-button annotation-unlink"
                disabled={disabled}
                onClick={() => onUnlink(link.id)}
                data-tooltip="Unlink note; keep the file"
                aria-label={`Unlink ${filename ?? 'unavailable note'}`}
              >
                <WorkspaceIcon name="close" />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function NewAnnotation({
  documentPath,
  disabled,
  change,
}: {
  documentPath: string;
  disabled: boolean;
  change: ChangeAction;
}) {
  const [title, setTitle] = useState('');
  const name =
    documentPath
      .split('/')
      .pop()
      ?.replace(/\.(pdf|docx)$/i, '') ?? 'Document';
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!disabled) {
      input.current?.focus();
    }
  }, [disabled]);
  return (
    <Form
      className="annotation-create"
      onSubmit={(event) => {
        event.preventDefault();
        const folder = documentPath.slice(0, documentPath.lastIndexOf('/') + 1);
        const filename = title.trim().replace(/\.md$/i, '');
        if (filename) {
          void change({ kind: 'create', path: `${folder}${filename}.md` });
        }
      }}
    >
      <label htmlFor="annotation-title">Note title</label>
      <input
        ref={input}
        id="annotation-title"
        value={title}
        disabled={disabled}
        required
        maxLength={180}
        pattern={'[^/\\\\]+'}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={`Notes on ${name}`}
        autoComplete="off"
      />
      <p>Create a Markdown note linked to this document.</p>
      <button
        type="submit"
        className="annotation-create-submit"
        disabled={disabled || !title.trim()}
      >
        <WorkspaceIcon name="edit" />
        Create note
      </button>
    </Form>
  );
}

function AnnotationResults({
  snapshot,
  query,
  linking,
  markdown,
  disabled,
  change,
  onOpen,
}: {
  snapshot: AnnotationSnapshot;
  query: string;
  linking: boolean;
  markdown: boolean;
  disabled: boolean;
  change: ChangeAction;
  onOpen: (path: string, id: string) => void;
}) {
  const links = linking ? snapshot.candidates : snapshot.links;
  let empty = markdown ? 'No source documents linked.' : 'No linked notes yet.';
  if (linking) {
    empty = 'No available notes. Try another title or create a new note.';
  }
  if (query.trim()) {
    empty = 'No matching notes.';
  }
  return (
    <>
      {!links.length ? (
        <div className="annotation-empty">
          <WorkspaceIcon name="edit" />
          <p>{empty}</p>
        </div>
      ) : null}
      <MaterialList
        links={links}
        linking={linking}
        disabled={disabled || (linking && snapshot.indexing.state !== 'ready')}
        onOpen={(link) => {
          if (linking) {
            void change({ kind: 'link', id: link.id });
          } else if (link.path) {
            onOpen(link.path, link.id);
          }
        }}
        onUnlink={markdown || linking ? undefined : (id) => void change({ kind: 'unlink', id })}
      />
      {snapshot.moreLinks || (linking && snapshot.moreCandidates) ? (
        <p className="annotation-status">More results available. Narrow your search.</p>
      ) : null}
      {linking && snapshot.indexing.state !== 'ready' ? (
        <p className="annotation-status">
          Finding notes… Linking will be available when the Vault finishes indexing.
        </p>
      ) : null}
    </>
  );
}

function useAnnotations(workspace: Workspace, controller: AnnotationPanelController) {
  const [snapshot, setSnapshot] = useState<AnnotationSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ kind: 'read' | 'write'; text: string } | null>(null);
  const mutation = useRef(false);
  const request = useRef(0);
  const { path, identity, mode } = controller;
  const loadKey = JSON.stringify([path, identity, query, refresh, mode]);
  const loading = loadedKey !== loadKey;

  useEffect(() => {
    const generation = ++request.current;
    const timer = window.setTimeout(
      () => {
        void invoke<AnnotationSnapshot>('vault_annotations', {
          path,
          expectedIdentity: identity,
          query,
        })
          .then((next) => {
            if (request.current === generation) {
              setSnapshot(next);
              setLoadedKey(loadKey);
              setError((current) => (current?.kind === 'read' ? null : current));
            }
          })
          .catch((cause: unknown) => {
            if (request.current === generation) {
              setSnapshot(null);
              setLoadedKey(loadKey);
              setError({ kind: 'read', text: errorMessage(cause) });
            }
          });
      },
      query ? 150 : 0,
    );
    return () => {
      request.current = generation + 1;
      window.clearTimeout(timer);
    };
  }, [path, identity, query, loadKey, workspace.vault]);

  const disabled = pending || !!workspace.busy || loading;

  async function change(action: AnnotationRequest['action']) {
    if (disabled || !snapshot || !path || mutation.current) {
      return;
    }
    mutation.current = true;
    request.current++;
    setPending(true);
    setError(null);
    try {
      const result = await workspace.changeAnnotation({
        path,
        expectedIdentity: snapshot.identity,
        expectedRevision: snapshot.revision,
        action,
      });
      if (result.created?.id) {
        controller.openNote(result.created.path, result.created.id);
      } else if (action.kind === 'link') {
        controller.close();
      }
    } catch (cause) {
      setError({ kind: 'write', text: errorMessage(cause) });
    } finally {
      mutation.current = false;
      setPending(false);
      setRefresh((value) => value + 1);
    }
  }

  return {
    snapshot,
    query,
    setQuery,
    pending,
    error,
    loading,
    disabled,
    change,
    retry: () => {
      setError(null);
      setRefresh((value) => value + 1);
    },
  };
}

export default function DocumentAnnotations({
  workspace,
  controller,
}: {
  workspace: Workspace;
  controller: AnnotationPanelController;
}) {
  const data = useAnnotations(workspace, controller);
  if (controller.mode !== 'notes') {
    return (
      <Dialog
        open
        title={controller.mode === 'create' ? 'New note' : 'Link note'}
        className="annotation-modal"
        onClose={() => {
          if (!data.pending) {
            controller.close();
          }
        }}
      >
        <AnnotationBody data={data} controller={controller} />
      </Dialog>
    );
  }
  return <AnnotationDrawer workspace={workspace} controller={controller} data={data} />;
}

function AnnotationDrawer({
  workspace,
  controller,
  data,
}: {
  workspace: Workspace;
  controller: AnnotationPanelController;
  data: ReturnType<typeof useAnnotations>;
}) {
  const panel = useRef<HTMLElement>(null);
  const onEscape = useEffectEvent(() => {
    if (!data.pending) {
      controller.close();
    }
  });
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const element = panel.current;
    element?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.stopPropagation();
        onEscape();
      }
    };
    element?.addEventListener('keydown', escape);
    return () => {
      element?.removeEventListener('keydown', escape);
      if (
        element?.contains(document.activeElement) &&
        trigger instanceof HTMLElement &&
        trigger.isConnected
      ) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);
  const heading = controller.owner?.kind === 'markdown' ? 'Source documents' : 'Linked notes';
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      id="annotation-panel"
      className="annotation-panel"
      aria-label={heading}
    >
      <header className="annotation-heading">
        <div>
          <WorkspaceIcon name="edit" />
          <h2>{heading}</h2>
          {data.snapshot ? (
            <span className="annotation-count">{data.snapshot.links.length}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-button"
          disabled={data.pending || !!workspace.busy}
          onClick={controller.close}
          aria-label="Close notes panel"
        >
          <WorkspaceIcon name="close" />
        </button>
      </header>
      <AnnotationBody data={data} controller={controller} />
    </aside>
  );
}

function AnnotationBody({
  data,
  controller,
}: {
  data: ReturnType<typeof useAnnotations>;
  controller: AnnotationPanelController;
}) {
  const { snapshot, query, setQuery, pending, error, loading, disabled, change, retry } = data;
  const { mode, path } = controller;
  const markdown = controller.owner?.kind === 'markdown';
  return (
    <div className="annotation-body">
      {mode !== 'create' ? (
        <SearchField
          className="navigation-search-field annotation-search"
          aria-label={markdown ? 'Find source documents' : 'Find notes'}
          value={query}
          disabled={pending}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={mode === 'link' ? 'Find a note in your Vault…' : 'Search notes…'}
        />
      ) : null}
      {error ? (
        <div className="annotation-error" role="alert">
          <p>{error.text}</p>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              retry();
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {loading ? (
        <p className="annotation-status" role="status">
          Loading…
        </p>
      ) : null}
      {mode === 'create' && path ? (
        <NewAnnotation documentPath={path} disabled={disabled || !snapshot} change={change} />
      ) : null}
      {mode !== 'create' && snapshot ? (
        <AnnotationResults
          snapshot={snapshot}
          query={query}
          linking={mode === 'link'}
          markdown={markdown}
          disabled={disabled}
          change={change}
          onOpen={controller.openNote}
        />
      ) : null}
    </div>
  );
}
