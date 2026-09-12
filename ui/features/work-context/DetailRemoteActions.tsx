import { useId, useState } from 'react';
import { Dialog } from '../interaction/InteractionDialogs';
import type { Connection, RemoteAction, RemoteDetail, WorkItem } from './types';
import type {
  DetailConfirm,
  DetailConfirmation,
  DetailExecute,
  DetailSaveDraft,
} from './DetailShared';
import type { DetailRemoteState } from './DetailRemoteState';

const reviewDecisions = {
  COMMENT: {
    title: 'Send general review',
    effect: 'Publish a general review comment on this pull request.',
  },
  APPROVE: { title: 'Approve pull request', effect: 'Record your approval on this pull request.' },
  REQUEST_CHANGES: {
    title: 'Request changes',
    effect: 'Publish a changes-requested review on this pull request.',
  },
} satisfies Record<NonNullable<RemoteAction['reviewEvent']>, { title: string; effect: string }>;

export function DetailEditFields({
  item,
  detail,
  sendingAs,
  actionsReady,
  execute,
}: {
  item: WorkItem;
  detail: RemoteDetail;
  sendingAs: string;
  actionsReady: boolean;
  execute: DetailExecute;
}) {
  const [edit, setEdit] = useState<Pick<RemoteAction, 'assignee' | 'labels' | 'priority'>>({});
  return (
    <section className="work-detail-section" aria-label="Edit provider fields">
      <h3>Edit in {item.remote?.provider === 'github' ? 'GitHub' : 'Jira'}</h3>
      <p className="work-detail-muted">
        Save to {sendingAs}. These fields update the provider, not the local board. Only supported
        fields are offered.
      </p>
      <fieldset disabled={!actionsReady} className="work-detail-fieldset">
        {detail.editableFields.includes('assignee') ? (
          <label className="work-detail-field">
            {item.remote?.provider === 'jira'
              ? 'Assignee account ID (empty to unassign)'
              : 'Assignee login (empty to unassign)'}
            <input
              value={edit.assignee ?? item.assignee}
              maxLength={500}
              onChange={(event) =>
                setEdit((current) => ({ ...current, assignee: event.target.value }))
              }
            />
          </label>
        ) : null}
        {detail.editableFields.includes('labels') ? (
          <label className="work-detail-field">
            Labels (comma-separated)
            <input
              value={(edit.labels ?? item.labels).join(',')}
              maxLength={10000}
              onChange={(event) =>
                setEdit((current) => ({ ...current, labels: event.target.value.split(',') }))
              }
            />
          </label>
        ) : null}
        {detail.editableFields.includes('priority') ? (
          <label className="work-detail-field">
            Provider priority
            <select
              value={edit.priority ?? ''}
              onChange={(event) =>
                setEdit((current) => ({ ...current, priority: event.target.value }))
              }
            >
              <option value="">Keep current priority</option>
              {detail.priorities.map((priority) => (
                <option key={priority.id} value={priority.id}>
                  {priority.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          disabled={!Object.keys(edit).length}
          onClick={() => {
            void execute({
              kind: 'edit',
              ...edit,
              labels: edit.labels?.map((label) => label.trim()).filter(Boolean),
              priority: edit.priority || undefined,
            }).then((sent) => {
              if (sent) {
                setEdit({});
              }
            });
          }}
        >
          Save provider fields
        </button>
      </fieldset>
    </section>
  );
}

export function DetailReview({
  review,
  sendingAs,
  headSha,
  pending,
  canReview,
  saveDraft,
  execute,
  confirm,
}: {
  review: string;
  sendingAs: string;
  headSha: string | null;
  pending: boolean;
  canReview: boolean;
  saveDraft: DetailSaveDraft;
  execute: DetailExecute;
  confirm: DetailConfirm;
}) {
  const [reviewEvent, setReviewEvent] =
    useState<NonNullable<RemoteAction['reviewEvent']>>('COMMENT');
  return (
    <section className="work-detail-section" aria-label="General review">
      <h3>General review</h3>
      <p className="work-detail-muted">
        Applies to the whole pull request; inline reviews are not supported.
      </p>
      <label className="work-detail-field">
        Review draft
        <textarea
          value={review}
          maxLength={60000}
          rows={5}
          onChange={(event) => saveDraft('review', event.target.value)}
        />
      </label>
      <label className="work-detail-field">
        Review decision
        <select
          value={reviewEvent}
          disabled={pending}
          onChange={(event) =>
            setReviewEvent(event.target.value as NonNullable<RemoteAction['reviewEvent']>)
          }
        >
          <option value="COMMENT">Comment only</option>
          <option value="APPROVE">Approve</option>
          <option value="REQUEST_CHANGES">Request changes</option>
        </select>
      </label>
      <p className="work-detail-muted">
        Local draft · never sent automatically. Send as {sendingAs}. Approval and changes requested
        require confirmation.
      </p>
      <button
        type="button"
        disabled={!canReview || !headSha || (reviewEvent !== 'APPROVE' && !review.trim())}
        onClick={() => {
          if (!headSha) {
            return;
          }
          const action: RemoteAction = {
            kind: 'review',
            body: review,
            reviewEvent,
            expectedHeadSha: headSha,
          };
          if (reviewEvent === 'COMMENT') {
            void execute(action);
          } else {
            confirm(
              action,
              reviewDecisions[reviewEvent].title,
              reviewDecisions[reviewEvent].effect,
            );
          }
        }}
      >
        {reviewDecisions[reviewEvent].title}
      </button>
    </section>
  );
}

function DetailTransition({
  transitions,
  confirm,
}: Pick<RemoteDetail, 'transitions'> & { confirm: DetailConfirm }) {
  const id = useId();
  const [transitionId, setTransitionId] = useState('');
  return (
    <div className="work-detail-field">
      <label htmlFor={id}>Jira transition</label>
      <select
        id={id}
        value={transitionId}
        onChange={(event) => setTransitionId(event.target.value)}
      >
        <option value="">Choose an available transition</option>
        {transitions.map((transition) => (
          <option key={transition.id} value={transition.id}>
            {transition.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!transitionId}
        onClick={() =>
          confirm(
            { kind: 'transition', transitionId },
            'Transition Jira issue',
            `Apply “${transitions.find((transition) => transition.id === transitionId)?.name}” on Jira. Its local board column will not change.`,
          )
        }
      >
        Review transition…
      </button>
    </div>
  );
}

function DetailMerge({
  headSha,
  confirm,
}: Pick<RemoteDetail, 'headSha'> & { confirm: DetailConfirm }) {
  const id = useId();
  const [mergeMethod, setMergeMethod] = useState<NonNullable<RemoteAction['mergeMethod']>>('merge');
  return (
    <div className="work-detail-field">
      <label htmlFor={id}>Merge method</label>
      <select
        id={id}
        value={mergeMethod}
        onChange={(event) =>
          setMergeMethod(event.target.value as NonNullable<RemoteAction['mergeMethod']>)
        }
      >
        <option value="merge">Merge commit</option>
        <option value="squash">Squash</option>
        <option value="rebase">Rebase</option>
      </select>
      <p className="work-detail-muted">
        GitHub rechecks permissions, branch rules and the exact head commit. No bypass is requested.
      </p>
      <button
        type="button"
        className="danger"
        disabled={!headSha}
        onClick={() => {
          if (!headSha) {
            return;
          }
          confirm(
            { kind: 'merge', mergeMethod, expectedHeadSha: headSha },
            'Merge pull request',
            `Merge this pull request using ${mergeMethod}. This changes the target branch and cannot be undone here. A changed head commit must fail, not merge newer code.`,
          );
        }}
      >
        Review merge…
      </button>
    </div>
  );
}

export function DetailProviderActions({
  item,
  remoteState,
}: {
  item: WorkItem;
  remoteState: DetailRemoteState;
}) {
  const { detail, supports, actionsReady, confirm } = remoteState;
  if (
    !detail ||
    !detail.actions.some((action) => ['close', 'reopen', 'transition', 'merge'].includes(action))
  ) {
    return null;
  }
  return (
    <section className="work-detail-section" aria-label="Provider state actions">
      <h3>Provider actions</h3>
      <fieldset disabled={!actionsReady} className="work-detail-fieldset">
        <div className="work-detail-row">
          {supports('close') ? (
            <button
              type="button"
              onClick={() =>
                confirm(
                  { kind: 'close' },
                  'Close on GitHub',
                  'Close this item on GitHub. Its local board column will not change.',
                )
              }
            >
              Close on GitHub…
            </button>
          ) : null}
          {supports('reopen') ? (
            <button
              type="button"
              onClick={() =>
                confirm(
                  { kind: 'reopen' },
                  'Reopen on GitHub',
                  'Reopen this item on GitHub. Its local board column will not change.',
                )
              }
            >
              Reopen on GitHub…
            </button>
          ) : null}
        </div>
        {supports('transition') ? (
          <DetailTransition transitions={detail.transitions} confirm={confirm} />
        ) : null}
        {supports('merge') && item.kind === 'github-pr' ? (
          <DetailMerge headSha={detail.headSha} confirm={confirm} />
        ) : null}
      </fieldset>
    </section>
  );
}

export function DetailActionFeedback({
  pending,
  receipt,
  actionError,
}: Pick<DetailRemoteState, 'pending' | 'receipt' | 'actionError'>) {
  return (
    <>
      {pending ? (
        <p role="status" className="work-detail-notice">
          Sending one provider request. Do not retry while it is pending.
        </p>
      ) : null}
      {receipt ? (
        <p role="status" className="work-detail-notice">
          {receipt}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="work-detail-error">
          {actionError}
        </p>
      ) : null}
    </>
  );
}

export function DetailConfirmationDialog({
  confirmation,
  target,
  title,
  account,
  pending,
  actionsReady,
  onClose,
  execute,
}: {
  confirmation: DetailConfirmation;
  target: string;
  title: string;
  account: Connection | undefined;
  pending: boolean;
  actionsReady: boolean;
  onClose: () => void;
  execute: DetailExecute;
}) {
  return (
    <Dialog
      open
      title={confirmation.title}
      description={confirmation.effect}
      initialFocus="heading"
      onClose={onClose}
    >
      <dl className="work-detail-metadata">
        <dt>Target</dt>
        <dd>
          {target}
          <br />
          {title}
        </dd>
        <dt>Account</dt>
        <dd>
          {account?.account} on {account?.host}
        </dd>
      </dl>
      {confirmation.action.expectedHeadSha ? (
        <p>
          Expected head SHA:{' '}
          <code className="work-detail-sha">{confirmation.action.expectedHeadSha}</code>
        </p>
      ) : null}
      {confirmation.action.body ? (
        <div className="work-detail-confirm-body work-detail-prose">{confirmation.action.body}</div>
      ) : null}
      <p>Only this provider action is sent. Your local board column stays unchanged.</p>
      <div className="dialog-actions">
        <button type="button" disabled={pending} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={
            ['merge', 'close'].includes(confirmation.action.kind) ||
            confirmation.action.reviewEvent === 'REQUEST_CHANGES'
              ? 'danger'
              : 'primary'
          }
          disabled={pending || !actionsReady}
          onClick={() => void execute(confirmation.action, confirmation.connectionId)}
        >
          {pending ? 'Sending…' : confirmation.title}
        </button>
      </div>
    </Dialog>
  );
}
