import { useState } from 'react';
import DialogFrame from '../workspace/DialogFrame';
import type { Connection, WorkSource } from './types';

function sourceDefaults(source: WorkSource | undefined, connections: Connection[]) {
  return {
    connectionId: source?.connectionId ?? connections[0]?.id ?? '',
    scope: source?.scope ?? '',
    filter: source?.filter ?? '',
  };
}

function scopeError(connection: Connection, scope: string): string | null {
  if (connection.provider === 'github') {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope)
      ? null
      : 'Enter a repository as owner/repository.';
  }
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(scope) ? null : 'Enter a Jira project key, such as TEAM.';
}

function SourceConnection({
  source,
  connections,
  connectionId,
  onChange,
  onConnections,
}: {
  source?: WorkSource;
  connections: Connection[];
  connectionId: string;
  onChange: (id: string) => void;
  onConnections: () => void;
}) {
  return (
    <>
      <label className="work-field">
        Connection
        <select value={connectionId} onChange={(event) => onChange(event.target.value)} required>
          <option value="" disabled>
            Select a connection
          </option>
          {source && !connections.some((entry) => entry.id === source.connectionId) ? (
            <option value={source.connectionId} disabled>
              Connection unavailable
            </option>
          ) : null}
          {connections.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.provider === 'github' ? 'GitHub' : 'Jira'} / {entry.account} / {entry.host}
            </option>
          ))}
        </select>
      </label>
      {!connections.length ? (
        <button type="button" onClick={onConnections}>
          Set up a connection
        </button>
      ) : null}
    </>
  );
}

function SourceQuery({
  jira,
  scope,
  filter,
  onScope,
  onFilter,
}: {
  jira: boolean;
  scope: string;
  filter: string;
  onScope: (scope: string) => void;
  onFilter: (filter: string) => void;
}) {
  return (
    <>
      <label className="work-field">
        {jira ? 'Project key' : 'Repository'}
        <input
          value={scope}
          onChange={(event) => onScope(event.target.value)}
          placeholder={jira ? 'TEAM' : 'owner/repository'}
          required
          maxLength={256}
        />
      </label>
      <label className="work-field">
        {jira ? 'Additional JQL filter' : 'Search qualifiers'}
        <textarea
          rows={3}
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          placeholder={jira ? 'statusCategory != Done' : 'is:open assignee:@me'}
          maxLength={4096}
        />
      </label>
      <p className="field-help">
        {jira
          ? 'The query stays restricted to this project.'
          : 'The search stays restricted to this repository. Use is:issue or is:pr to choose a type.'}{' '}
        Results are paginated. Cards you already follow remain available offline.
      </p>
    </>
  );
}

export default function BoardSourceDialog({
  source,
  connections,
  onSave,
  onRemove,
  onClose,
  onConnections,
}: {
  source?: WorkSource;
  connections: Connection[];
  onSave: (source: WorkSource) => void;
  onRemove: () => void;
  onClose: () => void;
  onConnections: () => void;
}) {
  const [fields, setFields] = useState(() => sourceDefaults(source, connections));
  const [error, setError] = useState<string | null>(null);
  const { connectionId, scope, filter } = fields;
  const connection = connections.find((entry) => entry.id === connectionId);
  function submit() {
    if (!connection) {
      return;
    }
    const cleanScope = scope.trim();
    const invalid = scopeError(connection, cleanScope);
    if (invalid) {
      setError(invalid);
      return;
    }
    onSave({
      id: source?.id ?? crypto.randomUUID(),
      connectionId,
      provider: connection.provider,
      host: connection.host,
      scope: connection.provider === 'jira' ? cleanScope.toUpperCase() : cleanScope,
      filter: filter.trim(),
    });
  }
  return (
    <DialogFrame
      title={source ? 'Edit source' : 'Add source'}
      cancel={onClose}
      className="work-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p>
          A source follows matching work into this space. Refresh never moves or removes your cards.
        </p>
        <SourceConnection
          source={source}
          connections={connections}
          connectionId={connectionId}
          onChange={(id) => {
            setFields({ ...fields, connectionId: id });
            setError(null);
          }}
          onConnections={onConnections}
        />
        <SourceQuery
          jira={connection?.provider === 'jira'}
          scope={scope}
          filter={filter}
          onScope={(value) => setFields({ ...fields, scope: value })}
          onFilter={(value) => setFields({ ...fields, filter: value })}
        />
        {error ? (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          {source ? (
            <button className="danger work-action-start" type="button" onClick={onRemove}>
              Remove source
            </button>
          ) : null}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!connection || !scope.trim()}>
            Save source
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
