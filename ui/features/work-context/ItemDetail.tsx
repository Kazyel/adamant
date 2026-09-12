import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { kindLabels } from './state';
import { DetailLocalEditor, DetailOrganization } from './DetailLocal';
import {
  DetailDescription,
  DetailDiscussion,
  DetailProviderConnection,
  DetailPullRequestContext,
} from './DetailProviderContext';
import {
  DetailActionFeedback,
  DetailConfirmationDialog,
  DetailEditFields,
  DetailProviderActions,
  DetailReview,
} from './DetailRemoteActions';
import useDetailRemote from './DetailRemoteState';
import type { DetailRemoteState } from './DetailRemoteState';
import {
  detailAccounts,
  detailConnectionId,
  detailTarget,
  openDetailExternal,
  saveDetailDraft,
  updateDetailItem,
} from './DetailShared';
import type { DetailOpenExternal, DetailProps, DetailSaveDraft } from './DetailShared';
import type { WorkItem, WorkState } from './types';
import './detail.css';

function DetailRemoteContent({
  item,
  state,
  sendingAs,
  remoteState,
  saveDraft,
  openExternal,
}: {
  item: WorkItem;
  state: WorkState;
  sendingAs: string;
  remoteState: DetailRemoteState;
  saveDraft: DetailSaveDraft;
  openExternal: DetailOpenExternal;
}) {
  const { detail, connectionId, supports, actionsReady, execute, pending, confirm } = remoteState;
  const comment =
    state.drafts.find((draft) => draft.itemId === item.id && draft.kind === 'comment')?.body ?? '';
  const review =
    state.drafts.find((draft) => draft.itemId === item.id && draft.kind === 'review')?.body ?? '';
  return (
    <>
      <DetailDescription item={item} />
      {item.kind === 'github-pr' ? (
        <DetailPullRequestContext detail={detail} openExternal={openExternal} />
      ) : null}
      {detail && supports('edit') && detail.editableFields.length > 0 ? (
        <DetailEditFields
          key={connectionId}
          item={item}
          detail={detail}
          sendingAs={sendingAs}
          actionsReady={actionsReady}
          execute={execute}
        />
      ) : null}
      <DetailDiscussion
        detail={detail}
        comment={comment}
        sendingAs={sendingAs}
        canComment={actionsReady && supports('comment')}
        saveDraft={saveDraft}
        execute={execute}
      />
      {item.kind === 'github-pr' ? (
        <DetailReview
          review={review}
          sendingAs={sendingAs}
          headSha={detail?.headSha ?? null}
          pending={pending}
          canReview={actionsReady && supports('review')}
          saveDraft={saveDraft}
          execute={execute}
          confirm={confirm}
        />
      ) : null}
      <DetailProviderActions key={connectionId} item={item} remoteState={remoteState} />
      <DetailWriteAvailability detail={detail} />
    </>
  );
}

function DetailWriteAvailability({ detail }: Pick<DetailRemoteState, 'detail'>) {
  return detail && !detail.actions.length ? (
    <p className="work-detail-muted">This account has no supported write actions for this item.</p>
  ) : null;
}

export default function ItemDetail({
  item,
  space,
  state,
  connections,
  onChange,
  onClose,
  onOpenNote,
  onError,
  onBusyChange,
}: DetailProps) {
  const headingId = useId();
  const bodyId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState('');
  const accounts = detailAccounts(item, connections);
  const connectionId = detailConnectionId(item, space, accounts, selectedConnection);
  const account = accounts.find((connection) => connection.id === connectionId);
  const target = detailTarget(item);
  const sendingAs = `${account?.account ?? 'No connected account'} · ${target}`;
  const remoteState = useDetailRemote(item, connectionId, onChange, onBusyChange);
  const { pending, confirmation } = remoteState;
  const handlePanelKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape' || confirmation || pending || event.defaultPrevented) {
      return;
    }
    event.stopPropagation();
    if (expanded) {
      setExpanded(false);
    } else {
      onClose();
    }
  });

  useEffect(() => {
    const element = panel.current;
    const trigger = document.activeElement;
    heading.current?.focus({ preventScroll: true });
    element?.addEventListener('keydown', handlePanelKey);
    return () => {
      element?.removeEventListener('keydown', handlePanelKey);
      if (
        trigger instanceof HTMLElement &&
        trigger.isConnected &&
        (element?.contains(document.activeElement) || document.activeElement === document.body)
      ) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  const updateItem = (update: (current: WorkItem) => WorkItem) =>
    updateDetailItem(onChange, item.id, update);
  const saveDraft: DetailSaveDraft = (kind, body) => saveDetailDraft(onChange, item.id, kind, body);
  const openExternal: DetailOpenExternal = (url) => openDetailExternal(url, onError);

  return (
    <aside
      ref={panel}
      className={`work-item-detail${expanded ? ' is-expanded' : ''}`}
      aria-labelledby={headingId}
    >
      <header className="work-detail-header">
        <div>
          <p className="work-detail-kind">{kindLabels[item.kind]}</p>
          <h2 id={headingId} ref={heading} tabIndex={-1}>
            {item.title}
          </h2>
          {item.remote ? <p className="work-detail-target">{target}</p> : null}
        </div>
        <div className="work-detail-header-actions">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
          <button
            type="button"
            aria-label="Close item details"
            disabled={pending}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </header>
      <div id={bodyId} className="work-detail-body">
        {item.remote ? (
          <DetailProviderConnection
            item={item}
            accounts={accounts}
            connectionId={connectionId}
            onSelect={setSelectedConnection}
            openExternal={openExternal}
            remoteState={remoteState}
          />
        ) : (
          <DetailLocalEditor item={item} updateItem={updateItem} />
        )}
        <DetailOrganization
          item={item}
          updateItem={updateItem}
          pending={pending}
          onOpenNote={onOpenNote}
          onError={onError}
          openExternal={openExternal}
        />
        {item.remote ? (
          <DetailRemoteContent
            item={item}
            state={state}
            sendingAs={sendingAs}
            remoteState={remoteState}
            saveDraft={saveDraft}
            openExternal={openExternal}
          />
        ) : null}
        <DetailActionFeedback {...remoteState} />
      </div>
      {confirmation ? (
        <DetailConfirmationDialog
          confirmation={confirmation}
          target={target}
          title={item.title}
          account={account}
          pending={pending}
          actionsReady={remoteState.actionsReady}
          onClose={remoteState.dismissConfirmation}
          execute={remoteState.execute}
        />
      ) : null}
    </aside>
  );
}
