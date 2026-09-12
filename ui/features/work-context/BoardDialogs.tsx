import { useEffect, useRef, useState } from 'react';
import DialogFrame from '../workspace/DialogFrame';
import { errorMessage } from '../../shared/errors';
import { createTask, kindLabels, priorities } from './state';
import type { Connection, Priority, RemoteDetail, WorkItem, WorkSpace, WorkState } from './types';

function textField(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

export function NameDialog({
  title,
  initial,
  onSave,
  onClose,
}: {
  title: string;
  initial: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <DialogFrame title={title} cancel={onClose} className="work-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) {
            onSave(name.trim());
          }
        }}
      >
        <label className="work-field">
          Name
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!name.trim()}>
            Save space
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

export function TaskDialog({
  onSave,
  onClose,
}: {
  onSave: (item: WorkItem) => void;
  onClose: () => void;
}) {
  return (
    <DialogFrame title="New local task" cancel={onClose} className="work-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const title = textField(data, 'title').trim();
          if (!title) {
            return;
          }
          onSave({
            ...createTask(title),
            description: textField(data, 'description'),
            priority: textField(data, 'priority') as Priority,
            dueDate: textField(data, 'dueDate'),
          });
        }}
      >
        <p>This task stays in your Vault. It does not create an issue in GitHub or Jira.</p>
        <label className="work-field">
          Title
          <input name="title" required maxLength={4096} />
        </label>
        <label className="work-field">
          Description
          <textarea name="description" rows={5} maxLength={524288} />
        </label>
        <div className="work-field-pair">
          <label className="work-field">
            Priority
            <select name="priority" defaultValue="none">
              {priorities.map((priority) => (
                <option key={priority} value={priority}>
                  {priority === 'none'
                    ? 'No priority'
                    : priority[0].toUpperCase() + priority.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="work-field">
            Due date
            <input name="dueDate" type="date" />
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Create task</button>
        </div>
      </form>
    </DialogFrame>
  );
}
export function FlowDialog({
  space,
  onSave,
  onClose,
}: {
  space: WorkSpace;
  onSave: (columns: WorkSpace['columns']) => void;
  onClose: () => void;
}) {
  const [columns, setColumns] = useState(space.columns);
  return (
    <DialogFrame title="Configure columns" cancel={onClose} className="work-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (columns.every((column) => column.name.trim())) {
            onSave(columns.map((column) => ({ ...column, name: column.name.trim() })));
          }
        }}
      >
        <p>
          Columns are local to {space.name}. Changing this flow does not change remote issue
          statuses.
        </p>
        <ol className="work-flow-editor">
          {columns.map((column, index) => (
            <li key={column.id}>
              <label className="visually-hidden" htmlFor={`column-${column.id}`}>
                Column {index + 1} name
              </label>
              <input
                id={`column-${column.id}`}
                value={column.name}
                maxLength={120}
                required
                onChange={(event) =>
                  setColumns(
                    columns.map((entry) =>
                      entry.id === column.id ? { ...entry, name: event.target.value } : entry,
                    ),
                  )
                }
              />
              <button
                type="button"
                aria-label={`Move ${column.name || 'column'} left`}
                disabled={index === 0}
                onClick={() =>
                  setColumns((current) => {
                    const next = [...current];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    return next;
                  })
                }
              >
                Left
              </button>
              <button
                type="button"
                aria-label={`Move ${column.name || 'column'} right`}
                disabled={index === columns.length - 1}
                onClick={() =>
                  setColumns((current) => {
                    const next = [...current];
                    [next[index + 1], next[index]] = [next[index], next[index + 1]];
                    return next;
                  })
                }
              >
                Right
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          disabled={columns.length >= 64}
          onClick={() => setColumns([...columns, { id: crypto.randomUUID(), name: 'New column' }])}
        >
          Add column
        </button>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={columns.some((column) => !column.name.trim())}>
            Save flow
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

export function FollowDialog({
  connections,
  follow,
  onDone,
  onClose,
}: {
  connections: Connection[];
  follow: (url: string, connectionId: string, signal?: AbortSignal) => Promise<RemoteDetail | null>;
  onDone: (id: string, warning: string | null) => void;
  onClose: () => void;
}) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  async function submit() {
    setPending(true);
    setError(null);
    request.current = new AbortController();
    try {
      const result = await follow(url, connectionId, request.current.signal);
      if (mounted.current && result) {
        onDone(
          result.item.id,
          [
            ...result.warnings,
            ...(result.stale
              ? ['Showing a cached item. Remote information may be out of date.']
              : []),
          ].join(' ') || null,
        );
      }
    } catch (error) {
      if (mounted.current) {
        setError(errorMessage(error));
      }
    } finally {
      if (mounted.current) {
        setPending(false);
      }
    }
  }
  return (
    <DialogFrame
      title="Follow an issue or pull request"
      cancel={onClose}
      pending={pending}
      className="work-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p>
          Follow a GitHub issue, pull request or Jira issue in this space. The item’s identity is
          shared across spaces; its column is not.
        </p>
        <label className="work-field">
          Connection
          <select
            disabled={pending}
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
            required
          >
            <option value="" disabled>
              Select a connection
            </option>
            {connections.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.account} / {entry.host}
              </option>
            ))}
          </select>
        </label>
        <label className="work-field">
          Issue or pull request URL
          <input
            disabled={pending}
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
            placeholder="https://github.com/owner/repo/issues/123"
          />
        </label>
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={pending || !connectionId || !url.trim()}>
            {pending ? 'Loading item…' : 'Follow item'}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

export function ExistingDialog({
  state,
  space,
  onAdd,
  onClose,
}: {
  state: WorkState;
  space: WorkSpace;
  onAdd: (item: WorkItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const members = new Set(space.members.map((member) => member.itemId));
  const available = state.items.filter(
    (item) =>
      !members.has(item.id) && item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <DialogFrame title="Add an existing item" cancel={onClose} className="work-dialog">
      <label className="work-field">
        Find an item in this Vault
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <p>The same item can have a different column in each space.</p>
      <ul className="work-existing-list">
        {available.slice(0, 100).map((item) => (
          <li key={item.id}>
            <button onClick={() => onAdd(item)}>
              <span>{item.title}</span>
              <small>{kindLabels[item.kind]}</small>
            </button>
          </li>
        ))}
      </ul>
      {
        <>
          {!available.length ? (
            <p>
              No matching items outside this space. Create a local task or follow a URL instead.
            </p>
          ) : null}
          {available.length > 100 ? (
            <p>Showing the first 100 items. Refine your search to find more.</p>
          ) : null}
        </>
      }
      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
      </div>
    </DialogFrame>
  );
}

export function ConflictDialog({
  state,
  readSaved,
  resolve,
  onClose,
}: {
  state: WorkState;
  readSaved: () => Promise<WorkState>;
  resolve: (saved: WorkState, keepMine: boolean) => void;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState<WorkState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void readSaved()
      .then((value) => {
        if (current) {
          setSaved(value);
        }
      })
      .catch((error) => {
        if (current) {
          setError(errorMessage(error));
        }
      });
    return () => {
      current = false;
    };
  }, [readSaved]);
  return (
    <DialogFrame
      title="Review unsaved workspace"
      cancel={onClose}
      className="work-dialog work-conflict-dialog"
    >
      <p>
        Your edits are still in memory. Nothing will be replaced unless you choose a version below.
        A newer file change during this review will stop the save again.
      </p>
      {error ? (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      ) : null}
      {!saved && !error ? <p role="status">Reading the saved workspace…</p> : null}
      {saved ? (
        <>
          <div className="work-conflict-versions">
            <section>
              <h3>Your unsaved version</h3>
              <p>
                {state.spaces.length} spaces, {state.items.length} items, {state.drafts.length}{' '}
                drafts
              </p>
              <details>
                <summary>Inspect current content</summary>
                <pre>{JSON.stringify(state, null, 2)}</pre>
              </details>
            </section>
            <section>
              <h3>Saved version (revision {saved.revision})</h3>
              <p>
                {saved.spaces.length} spaces, {saved.items.length} items, {saved.drafts.length}{' '}
                drafts
              </p>
              <details>
                <summary>Inspect saved content</summary>
                <pre>{JSON.stringify(saved, null, 2)}</pre>
              </details>
            </section>
          </div>
          <p className="work-warning">
            Saving your version replaces the saved workspace shown here, including its spaces and
            drafts. Using the saved version discards your current unsaved workspace edits.
          </p>
          <div className="dialog-actions">
            <button onClick={onClose}>Keep editing</button>
            <button
              className="danger"
              onClick={() => {
                resolve(saved, false);
                onClose();
              }}
            >
              Discard my edits and use saved
            </button>
            <button
              className="primary"
              onClick={() => {
                resolve(saved, true);
                onClose();
              }}
            >
              Save my version instead
            </button>
          </div>
        </>
      ) : (
        <div className="dialog-actions">
          <button onClick={onClose}>Keep editing</button>
        </div>
      )}
    </DialogFrame>
  );
}
