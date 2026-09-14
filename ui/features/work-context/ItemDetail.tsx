import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { OverlayPresence, useOverlayPresence } from '../interaction/OverlayPresence';
import useBackdropDismiss from '../interaction/useBackdropDismiss';
import DetailHeader, { DetailNavigation } from './DetailHeader';
import type { DetailView } from './DetailHeader';
import { DetailLocalEditor, DetailOrganization } from './DetailLocal';
import {
  DetailCommentComposer,
  DetailDescription,
  DetailDiscussion,
  DetailProviderAccount,
  DetailProviderToolbar,
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
import type { Connection, WorkItem, WorkState } from './types';

function detailViewHidden(view: DetailView | null, section: DetailView) {
  return view !== null && view !== section;
}

function DetailTabPanel({
  bodyId,
  view,
  name,
  children,
}: {
  bodyId: string;
  view: DetailView | null;
  name: DetailView;
  children: ReactNode;
}) {
  const tabbed = view !== null;
  return (
    <div
      id={`${bodyId}-${name}`}
      role={tabbed ? 'tabpanel' : undefined}
      aria-labelledby={tabbed ? `${bodyId}-tab-${name}` : undefined}
      hidden={detailViewHidden(view, name)}
    >
      {children}
    </div>
  );
}

function DetailRemoteContent({
  item,
  state,
  sendingAs,
  remoteState,
  saveDraft,
  openExternal,
  view,
  bodyId,
  accounts,
  onSelectAccount,
}: {
  view: DetailView | null;
  bodyId: string;
  item: WorkItem;
  state: WorkState;
  sendingAs: string;
  remoteState: DetailRemoteState;
  saveDraft: DetailSaveDraft;
  openExternal: DetailOpenExternal;
  accounts: Connection[];
  onSelectAccount: (connectionId: string) => void;
}) {
  const { detail, connectionId, supports, actionsReady, execute, pending, confirm } = remoteState;
  const comment =
    state.drafts.find((draft) => draft.itemId === item.id && draft.kind === 'comment')?.body ?? '';
  const review =
    state.drafts.find((draft) => draft.itemId === item.id && draft.kind === 'review')?.body ?? '';
  return (
    <>
      <DetailTabPanel bodyId={bodyId} view={view} name="overview">
        <DetailDescription item={item} />
        <DetailCommentComposer
          comment={comment}
          sendingAs={sendingAs}
          canComment={actionsReady && supports('comment')}
          saveDraft={saveDraft}
          execute={execute}
        />
      </DetailTabPanel>
      <DetailTabPanel bodyId={bodyId} view={view} name="changes">
        {item.kind === 'github-pr' ? (
          <DetailPullRequestContext detail={detail} openExternal={openExternal} />
        ) : null}
      </DetailTabPanel>
      <DetailTabPanel bodyId={bodyId} view={view} name="activity">
        <DetailDiscussion detail={detail} />
      </DetailTabPanel>
      <DetailTabPanel bodyId={bodyId} view={view} name="actions">
        <DetailProviderAccount
          item={item}
          accounts={accounts}
          connectionId={connectionId}
          pending={pending}
          onSelect={onSelectAccount}
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
        {detail && supports('edit') && detail.editableFields.length > 0 ? (
          <DetailEditFields
            key={`fields-${connectionId}`}
            item={item}
            detail={detail}
            sendingAs={sendingAs}
            actionsReady={actionsReady}
            execute={execute}
          />
        ) : null}
        <DetailProviderActions
          key={`actions-${connectionId}`}
          item={item}
          remoteState={remoteState}
        />
        <DetailWriteAvailability detail={detail} />
      </DetailTabPanel>
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
  const panel = useRef<HTMLDialogElement>(null);
  const presence = useOverlayPresence();
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<DetailView>('overview');
  const github = item.remote?.provider === 'github';
  const remoteView = github ? view : null;
  const [selectedConnection, setSelectedConnection] = useState('');
  const accounts = detailAccounts(item, connections);
  const connectionId = detailConnectionId(item, space, accounts, selectedConnection);
  const account = accounts.find((connection) => connection.id === connectionId);
  const target = detailTarget(item);
  const sendingAs = `${account?.account ?? 'No connected account'} · ${target}`;
  const remoteState = useDetailRemote(item, connectionId, onChange, onBusyChange);
  const { pending, confirmation } = remoteState;
  useBackdropDismiss(panel, onClose, !pending && !confirmation && presence === 'present');

  useEffect(() => {
    const element = panel.current!;
    const trigger = document.activeElement;
    element.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      const ownedFocus =
        element.contains(document.activeElement) || document.activeElement === document.body;
      element.close();
      if (
        ownedFocus &&
        trigger instanceof HTMLElement &&
        trigger.isConnected &&
        (document.activeElement === document.body || document.activeElement === trigger)
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
    <dialog
      ref={panel}
      className={`work-item-detail${expanded ? ' is-expanded' : ''}`}
      data-overlay-presence={presence}
      inert={presence === 'exiting' ? true : undefined}
      aria-hidden={presence === 'exiting' ? true : undefined}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (confirmation || pending) {
          return;
        }
        if (expanded) {
          setExpanded(false);
        } else {
          onClose();
        }
      }}
    >
      <DetailHeader
        item={item}
        target={target}
        headingId={headingId}
        heading={heading}
        bodyId={bodyId}
        expanded={expanded}
        pending={pending}
        onExpand={() => setExpanded(!expanded)}
        onClose={onClose}
      />
      <DetailProviderToolbar
        item={item}
        connectionId={connectionId}
        openExternal={openExternal}
        remoteState={remoteState}
      />
      <DetailNavigation
        show={github}
        view={view}
        pullRequest={item.kind === 'github-pr'}
        bodyId={bodyId}
        activityCount={remoteState.detail?.comments.length}
        changeCount={remoteState.detail?.files.length}
        onChange={(next) => {
          setView(next);
          panel.current?.querySelector('.work-detail-body')?.scrollTo(0, 0);
        }}
      />
      <div id={bodyId} className="work-detail-body">
        {item.remote ? null : <DetailLocalEditor item={item} updateItem={updateItem} />}
        <DetailTabPanel bodyId={bodyId} view={remoteView} name="local">
          <DetailOrganization
            item={item}
            expanded={github}
            updateItem={updateItem}
            pending={pending}
            onOpenNote={onOpenNote}
            onError={onError}
            openExternal={openExternal}
          />
        </DetailTabPanel>
        {item.remote ? (
          <DetailRemoteContent
            view={remoteView}
            bodyId={bodyId}
            item={item}
            state={state}
            sendingAs={sendingAs}
            remoteState={remoteState}
            saveDraft={saveDraft}
            openExternal={openExternal}
            accounts={accounts}
            onSelectAccount={setSelectedConnection}
          />
        ) : null}
      </div>
      <DetailActionFeedback {...remoteState} />
      <OverlayPresence>
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
      </OverlayPresence>
    </dialog>
  );
}
