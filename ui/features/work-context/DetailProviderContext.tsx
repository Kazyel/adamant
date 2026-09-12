import type { Connection, RemoteDetail, WorkItem } from './types';
import type { DetailExecute, DetailOpenExternal, DetailSaveDraft } from './DetailShared';
import { timestamp } from './DetailShared';
import type { DetailRemoteState } from './DetailRemoteState';

type ConnectionProps = {
  item: WorkItem;
  accounts: Connection[];
  connectionId: string;
  onSelect: (connectionId: string) => void;
  openExternal: DetailOpenExternal;
  remoteState: DetailRemoteState;
};

function DetailReadStatus({
  loading,
  readError,
  detail,
}: Pick<DetailRemoteState, 'loading' | 'readError' | 'detail'>) {
  return (
    <>
      {loading ? (
        <p role="status">Reading provider details. Local editing is still available.</p>
      ) : null}
      {readError ? (
        <p className="work-detail-error" role="alert">
          {readError} Cached content is shown; remote actions are disabled until a successful
          refresh.
        </p>
      ) : null}
      {detail?.stale ? (
        <p role="status" className="work-detail-warning">
          Offline or stale snapshot. Refresh successfully before sending provider changes.
        </p>
      ) : null}
      {detail?.partial ? (
        <p role="status" className="work-detail-warning">
          Partial result: some provider content is unavailable or exceeds the read limit. Open the
          original for the complete record.
        </p>
      ) : null}
      {detail?.warnings.map((warning, index) => (
        <p className="work-detail-warning" key={`${index}-${warning}`}>
          {warning}
        </p>
      ))}
    </>
  );
}

export function DetailProviderConnection({
  item,
  accounts,
  connectionId,
  onSelect,
  openExternal,
  remoteState,
}: ConnectionProps) {
  const { pending, loading, stale, refresh } = remoteState;
  const remote = item.remote;
  if (!remote) {
    return null;
  }
  return (
    <section className="work-detail-section" aria-label="Provider connection">
      <div className="work-detail-row">
        <span className="work-detail-state">{item.remoteState ?? 'State unavailable'}</span>
        {item.url ? (
          <button type="button" onClick={() => void openExternal(item.url!)}>
            Open in {remote.provider === 'github' ? 'GitHub' : 'Jira'}
          </button>
        ) : null}
      </div>
      <p className="work-detail-muted">
        Remote state is separate from this space’s column. Moving a card never changes the provider.
      </p>
      {accounts.length ? (
        <label className="work-detail-field">
          Account
          <select
            value={connectionId}
            disabled={pending}
            onChange={(event) => onSelect(event.target.value)}
          >
            {accounts.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.account} · {connection.host}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p role="status">
          No connected account for {remote.host}. Cached content and local organization remain
          available. Connect an account in Connections to refresh or send.
        </p>
      )}
      <div className="work-detail-row">
        <p className="work-detail-muted">
          {stale ? 'Cached · ' : 'Refreshed · '}
          {timestamp(item.fetchedAt)}
        </p>
        <button
          type="button"
          disabled={!connectionId || loading || pending}
          onClick={() => void refresh()}
        >
          {loading ? 'Refreshing…' : 'Refresh details'}
        </button>
      </div>
      <DetailReadStatus {...remoteState} />
    </section>
  );
}

export function DetailDescription({ item }: { item: WorkItem }) {
  return (
    <section className="work-detail-section" aria-label="Provider description">
      <h3>Description</h3>
      <div className="work-detail-prose">{item.description || 'No description.'}</div>
      <dl className="work-detail-metadata">
        <dt>Assignee</dt>
        <dd>{item.assignee || 'Unassigned'}</dd>
        <dt>Labels</dt>
        <dd>{item.labels.join(', ') || 'None'}</dd>
      </dl>
    </section>
  );
}

export function DetailDiscussion({
  detail,
  comment,
  sendingAs,
  canComment,
  saveDraft,
  execute,
}: {
  detail: RemoteDetail | null;
  comment: string;
  sendingAs: string;
  canComment: boolean;
  saveDraft: DetailSaveDraft;
  execute: DetailExecute;
}) {
  return (
    <section className="work-detail-section" aria-label="Discussion">
      <h3>Discussion{detail ? ` (${detail.comments.length})` : ''}</h3>
      {!detail ? (
        <p className="work-detail-muted">
          Discussion is not loaded. Refresh with a connected account to read the cached or current
          details.
        </p>
      ) : null}
      {detail && !detail.comments.length ? (
        <p className="work-detail-muted">No comments in this snapshot.</p>
      ) : null}
      {detail?.comments.map((entry) => (
        <article className="work-detail-comment" key={entry.id}>
          <header>
            <strong>{entry.author || 'Unknown author'}</strong>
            <time>{timestamp(entry.updatedAt)}</time>
          </header>
          <div className="work-detail-prose">{entry.body}</div>
        </article>
      ))}
      <label className="work-detail-field">
        Comment draft
        <textarea
          value={comment}
          maxLength={60000}
          rows={5}
          onChange={(event) => saveDraft('comment', event.target.value)}
        />
      </label>
      <p className="work-detail-muted">
        Local draft · never sent automatically. Send as {sendingAs}.
      </p>
      <button
        type="button"
        disabled={!canComment || !comment.trim()}
        onClick={() => void execute({ kind: 'comment', body: comment })}
      >
        Send comment
      </button>
    </section>
  );
}

function DetailCommits({ commits }: Pick<RemoteDetail, 'commits'>) {
  return (
    <details>
      <summary>Commits ({commits.length})</summary>
      {commits.length ? (
        <ol className="work-detail-commits">
          {commits.map((commit) => (
            <li key={commit.sha}>
              <code title={commit.sha}>{commit.sha.slice(0, 12)}</code>
              <span className="work-detail-prose">{commit.message}</span>
              <span className="work-detail-muted">{commit.author}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="work-detail-muted">No commits available in this snapshot.</p>
      )}
    </details>
  );
}

function DetailChecks({
  checks,
  openExternal,
}: Pick<RemoteDetail, 'checks'> & { openExternal: DetailOpenExternal }) {
  return (
    <details>
      <summary>Checks ({checks.length})</summary>
      {checks.length ? (
        <ul className="work-detail-checks">
          {checks.map((check, index) => (
            <li key={`${check.name}-${index}`}>
              <span>{check.name}</span>
              <strong>{check.status}</strong>
              {check.url ? (
                <button type="button" onClick={() => void openExternal(check.url!)}>
                  Open check
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="work-detail-muted">
          No checks available. This is not evidence that checks passed.
        </p>
      )}
    </details>
  );
}

function DetailFiles({ files }: Pick<RemoteDetail, 'files'>) {
  return (
    <details>
      <summary>Files changed ({files.length})</summary>
      {files.length ? (
        files.map((file) => (
          <details className="work-detail-file" key={file.path}>
            <summary>
              <span>{file.path}</span>
              <small>
                {file.status} · +{file.additions} −{file.deletions}
              </small>
            </summary>
            {file.patch ? (
              <textarea
                className="work-detail-diff"
                readOnly
                wrap="off"
                rows={18}
                aria-label={`Diff for ${file.path}`}
                value={file.patch}
              />
            ) : (
              <p className="work-detail-muted">
                Diff unavailable (binary, truncated, or not supplied). Open the pull request for the
                full file.
              </p>
            )}
          </details>
        ))
      ) : (
        <p className="work-detail-muted">No files available in this snapshot.</p>
      )}
    </details>
  );
}

export function DetailPullRequestContext({
  detail,
  openExternal,
}: {
  detail: RemoteDetail | null;
  openExternal: DetailOpenExternal;
}) {
  return (
    <section className="work-detail-section" aria-label="Pull request context">
      <h3>Pull request context</h3>
      <DetailCommits commits={detail?.commits ?? []} />
      <DetailChecks checks={detail?.checks ?? []} openExternal={openExternal} />
      <DetailFiles files={detail?.files ?? []} />
    </section>
  );
}
