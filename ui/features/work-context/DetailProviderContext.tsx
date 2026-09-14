import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import SelectField from '../interaction/SelectField';
import type { Connection, RemoteDetail, WorkItem } from './types';
import type { DetailExecute, DetailOpenExternal, DetailSaveDraft } from './DetailShared';
import { timestamp } from './DetailShared';
import type { DetailRemoteState } from './DetailRemoteState';

type ConnectionProps = {
  item: WorkItem;
  connectionId: string;
  openExternal: DetailOpenExternal;
  remoteState: DetailRemoteState;
};

type AccountProps = {
  item: WorkItem;
  accounts: Connection[];
  connectionId: string;
  pending: boolean;
  onSelect: (connectionId: string) => void;
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

export function DetailProviderToolbar({
  item,
  connectionId,
  openExternal,
  remoteState,
}: ConnectionProps) {
  const { loading, pending, stale, refresh } = remoteState;
  const remote = item.remote;
  if (!remote) {
    return null;
  }
  return (
    <section className="work-detail-toolbar" aria-label="Provider controls">
      <div className="work-detail-toolbar-main">
        <span className="work-detail-muted">
          {stale ? 'Cached content' : 'Up to date'} · {timestamp(item.fetchedAt)}
        </span>
        <div className="work-detail-toolbar-actions">
          {item.url ? (
            <button type="button" onClick={() => void openExternal(item.url!)}>
              <WorkspaceIcon name="external" /> Open in{' '}
              {remote.provider === 'github' ? 'GitHub' : 'Jira'}
            </button>
          ) : null}
          <button
            type="button"
            disabled={!connectionId || loading || pending}
            onClick={() => void refresh()}
          >
            <WorkspaceIcon name="refresh" /> {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <DetailReadStatus {...remoteState} />
    </section>
  );
}

export function DetailProviderAccount({
  item,
  accounts,
  connectionId,
  pending,
  onSelect,
}: AccountProps) {
  const remote = item.remote;
  if (!remote) {
    return null;
  }
  return (
    <section className="work-detail-section" aria-label="Provider account">
      <h3>{remote.provider === 'github' ? 'GitHub account' : 'Jira account'}</h3>
      {accounts.length ? (
        <label className="work-detail-field">
          Send provider changes as
          <SelectField
            value={connectionId}
            disabled={pending}
            onChange={(event) => onSelect(event.target.value)}
          >
            {accounts.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.account} · {connection.host}
              </option>
            ))}
          </SelectField>
        </label>
      ) : (
        <p role="status" className="work-detail-muted">
          No connected account for {remote.host}. Cached content and local organization remain
          available. Connect an account in Connections to refresh or send.
        </p>
      )}
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
        <dd className="work-detail-labels">
          {item.labels.length
            ? item.labels.map((label) => <span key={label}>{label}</span>)
            : 'None'}
        </dd>
      </dl>
    </section>
  );
}

export function DetailDiscussion({ detail }: { detail: RemoteDetail | null }) {
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
            <time dateTime={entry.updatedAt}>{timestamp(entry.updatedAt)}</time>
          </header>
          <div className="work-detail-prose">{entry.body}</div>
        </article>
      ))}
    </section>
  );
}

export function DetailCommentComposer({
  comment,
  sendingAs,
  canComment,
  saveDraft,
  execute,
}: {
  comment: string;
  sendingAs: string;
  canComment: boolean;
  saveDraft: DetailSaveDraft;
  execute: DetailExecute;
}) {
  return (
    <section className="work-detail-section" aria-label="Write a comment">
      <div className="work-detail-composer">
        <label className="work-detail-field">
          Add a comment
          <textarea
            value={comment}
            maxLength={60000}
            rows={5}
            placeholder="Write a comment…"
            onChange={(event) => saveDraft('comment', event.target.value)}
          />
        </label>
        <p className="work-detail-muted">Draft saved locally. Send as {sendingAs}.</p>
        <button
          type="button"
          className="primary"
          disabled={!canComment || !comment.trim()}
          onClick={() => void execute({ kind: 'comment', body: comment })}
        >
          Send comment
        </button>
      </div>
    </section>
  );
}

function DetailCommits({ commits }: Pick<RemoteDetail, 'commits'>) {
  return (
    <details>
      <summary>Commits ({commits.length})</summary>
      <div className="work-detail-disclosure-content">
        {commits.length ? (
          <ol className="work-detail-commits">
            {commits.map((commit) => (
              <li key={commit.sha}>
                <code data-tooltip={commit.sha}>{commit.sha.slice(0, 12)}</code>
                <span className="work-detail-prose">{commit.message}</span>
                <span className="work-detail-muted">{commit.author}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="work-detail-muted">No commits available in this snapshot.</p>
        )}
      </div>
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
      <div className="work-detail-disclosure-content">
        {checks.length ? (
          <ul className="work-detail-checks">
            {checks.map((check, index) => (
              <li key={`${check.name}-${index}`}>
                <span>{check.name}</span>
                <strong data-status={check.status}>{check.status.replaceAll('_', ' ')}</strong>
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
      </div>
    </details>
  );
}

function diffLineKind(line: string) {
  if (line.startsWith('+')) {
    return 'added';
  }
  return line.startsWith('-') ? 'removed' : 'context';
}

function DetailFiles({ files }: Pick<RemoteDetail, 'files'>) {
  return (
    <details>
      <summary>Files changed ({files.length})</summary>
      <div className="work-detail-disclosure-content">
        {files.length ? (
          files.map((file) => (
            <details className="work-detail-file" key={file.path}>
              <summary>
                <span>
                  {file.path}
                  <small>
                    {file.status} · +{file.additions} −{file.deletions}
                  </small>
                </span>
              </summary>
              <div className="work-detail-disclosure-content">
                {file.patch ? (
                  // Keyboard users need focus to scroll the diff horizontally.
                  <pre
                    className="work-detail-diff"
                    role="region"
                    tabIndex={0}
                    aria-label={`Diff for ${file.path}`}
                  >
                    <code>
                      {file.patch.split('\n').map((line, index) => (
                        <span key={index} data-line={diffLineKind(line)}>
                          {line}
                          {'\n'}
                        </span>
                      ))}
                    </code>
                  </pre>
                ) : (
                  <p className="work-detail-muted">
                    Diff unavailable (binary, truncated, or not supplied). Open the pull request for
                    the full file.
                  </p>
                )}
              </div>
            </details>
          ))
        ) : (
          <p className="work-detail-muted">No files available in this snapshot.</p>
        )}
      </div>
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
      <h3>Code and checks</h3>
      {!detail ? (
        <p className="work-detail-muted">
          Refresh with a connected account to load commits, checks and changed files.
        </p>
      ) : null}
      {detail ? <DetailCommits commits={detail.commits} /> : null}
      {detail ? <DetailChecks checks={detail.checks} openExternal={openExternal} /> : null}
      {detail ? <DetailFiles files={detail.files} /> : null}
    </section>
  );
}
