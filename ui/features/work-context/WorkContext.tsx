import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import { ContextMenu } from '../interaction/ContextMenu';
import type { UserAction } from '../interaction/types';
import type { VaultSnapshot } from '../workspace/types';
import ItemDetail from './ItemDetail';
import useWorkContext from './useWorkContext';
import { moveItem, updateSpace, visibleItems } from './state';
import type { WorkItem, WorkSpace, WorkView } from './types';
import type { BoardDialog, BoardWork } from './BoardModel';
import {
  BoardHeader,
  BoardSpaceBar,
  BoardToolbar,
  BoardFilters,
  BoardSources,
} from './BoardControls';
import { BoardColumns, BoardList } from './BoardItems';
import BoardDialogHost from './BoardDialogHost';
import './work-context.css';

type Selection = { vaultId: string; spaceId: string; itemId: string };

function selectedItem(selection: Selection | null, work: BoardWork, space: WorkSpace | null) {
  if (
    !selection ||
    !space ||
    selection.vaultId !== work.vaultKey ||
    selection.spaceId !== space.id
  ) {
    return null;
  }
  if (!space.members.some((member) => member.itemId === selection.itemId)) {
    return null;
  }
  return work.state?.items.find((item) => item.id === selection.itemId) ?? null;
}

function useBoardItems(work: BoardWork, space: WorkSpace | null) {
  const state = work.state;
  const itemMap = useMemo(
    () => new Map(state?.items.map((item) => [item.id, item]) ?? []),
    [state?.items],
  );
  const items = useMemo(() => (space ? visibleItems(space, itemMap) : []), [space, itemMap]);
  const columnByItem = useMemo(() => {
    const columns = new Map(space?.columns.map((column) => [column.id, column]) ?? []);
    return new Map(
      space?.members.map((member) => [member.itemId, columns.get(member.columnId)!]) ?? [],
    );
  }, [space?.members, space?.columns]);
  const visibleByColumn = useMemo(() => {
    const columns = new Map<string, WorkItem[]>();
    const membership = new Map(
      space?.members.map((member) => [member.itemId, member.columnId]) ?? [],
    );
    for (const item of items) {
      const columnId = membership.get(item.id)!;
      const column = columns.get(columnId) ?? [];
      column.push(item);
      columns.set(columnId, column);
    }
    return columns;
  }, [items, space?.members]);
  return { itemMap, items, columnByItem, visibleByColumn };
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  }, []);
  return online;
}

export default function WorkContext({
  vault,
  onOpenNote,
  onConnections,
  active = true,
  onRegisterPersistenceGuard,
}: {
  vault: VaultSnapshot | null;
  onOpenNote: (target: string) => void;
  onConnections: () => void;
  active?: boolean;
  onRegisterPersistenceGuard?: (guard: (() => Promise<void>) | null) => void;
}) {
  const work = useWorkContext(vault, active);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const remoteBusy = useRef(false);
  const { flush } = work;
  useEffect(() => {
    if (!onRegisterPersistenceGuard) {
      return;
    }
    const guard = async () => {
      if (remoteBusy.current) {
        throw new Error(
          'A remote work action is still in progress. Wait for its result before leaving this Vault.',
        );
      }
      await flush();
    };
    onRegisterPersistenceGuard(guard);
    return () => onRegisterPersistenceGuard(null);
  }, [flush, onRegisterPersistenceGuard]);
  const space = work.state?.spaces.find((entry) => entry.id === work.state?.activeSpaceId) ?? null;
  if (!work.native) {
    return (
      <section className="work-context work-unavailable">
        <h1>Work context</h1>
        <p>Open Adamant’s desktop app to keep project spaces and work items in your Vault.</p>
        <p>No work data is stored in this browser preview.</p>
      </section>
    );
  }
  if (!vault) {
    return (
      <section className="work-context work-unavailable">
        <h1>Work context</h1>
        <p>Open or create a Vault to organize project work alongside your notes.</p>
      </section>
    );
  }
  return (
    <BoardWorkspace
      key={JSON.stringify([work.vaultKey, space?.id, active])}
      work={work}
      vault={vault}
      space={space}
      active={active}
      busy={busy}
      selected={selectedItem(selection, work, space)}
      selectItem={(id) => {
        if (!space || !work.vaultKey || remoteBusy.current) {
          return;
        }
        setSelection({ vaultId: work.vaultKey, spaceId: space.id, itemId: id });
      }}
      clearSelection={() => setSelection(null)}
      isRemoteBusy={() => remoteBusy.current}
      onBusyChange={(value) => {
        remoteBusy.current = value;
        setBusy(value);
      }}
      onOpenNote={onOpenNote}
      onConnections={onConnections}
    />
  );
}

function BoardWorkspace({
  work,
  vault,
  space,
  active,
  busy,
  selected,
  selectItem,
  clearSelection,
  isRemoteBusy,
  onBusyChange,
  onOpenNote,
  onConnections,
}: {
  work: BoardWork;
  vault: VaultSnapshot;
  space: WorkSpace | null;
  active: boolean;
  busy: boolean;
  selected: WorkItem | null;
  selectItem: (id: string) => void;
  clearSelection: () => void;
  isRemoteBusy: () => boolean;
  onBusyChange: (busy: boolean) => void;
  onOpenNote: (target: string) => void;
  onConnections: () => void;
}) {
  const [dialog, setDialog] = useState<BoardDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [menu, setMenu] = useState<{
    actions: UserAction[];
    position: { x: number; y: number };
    trigger: HTMLElement;
  } | null>(null);
  const online = useOnline();
  const drag = useRef<Selection | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const state = work.state;
  const { itemMap, items, columnByItem, visibleByColumn } = useBoardItems(work, space);
  function showDialog(value: BoardDialog) {
    if (!isRemoteBusy()) {
      setDialog(value);
    }
  }
  function changeSpace(update: (space: WorkSpace) => WorkSpace) {
    if (space) {
      work.change((state) => updateSpace(state, space.id, update));
    }
  }
  function changeView(view: Partial<WorkView>) {
    changeSpace((space) => ({ ...space, view: { ...space.view, ...view } }));
  }
  function openItem(item: WorkItem, trigger?: HTMLElement) {
    if (!space || isRemoteBusy()) {
      return;
    }
    detailTrigger.current = trigger ?? null;
    selectItem(item.id);
  }
  function closeItem() {
    if (isRemoteBusy()) {
      return;
    }
    clearSelection();
    requestAnimationFrame(() => {
      if (detailTrigger.current?.isConnected) {
        detailTrigger.current.focus({ preventScroll: true });
      } else {
        content.current?.focus({ preventScroll: true });
      }
    });
  }
  function move(item: WorkItem, columnId: string, beforeId?: string) {
    if (!space) {
      return;
    }
    changeSpace((current) => moveItem(current, item.id, columnId, beforeId));
    setAnnouncement(
      `${item.title} moved to ${space.columns.find((column) => column.id === columnId)?.name}. This changes only this space.`,
    );
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {
        content.current
          ?.querySelector<HTMLButtonElement>(`[data-work-item="${CSS.escape(item.id)}"]`)
          ?.focus({ preventScroll: true });
      }
    });
  }
  function keyboardMove(event: KeyboardEvent, item: WorkItem, columnId: string) {
    if (
      !event.altKey ||
      !space ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const columnIndex = space.columns.findIndex((column) => column.id === columnId);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const target = space.columns[columnIndex + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (target) {
        move(item, target.id);
      }
    } else if (space.view.sort === 'manual') {
      const members = space.members.filter((member) => member.columnId === columnId);
      const index = members.findIndex((member) => member.itemId === item.id);
      if (event.key === 'ArrowUp' && index > 0) {
        move(item, columnId, members[index - 1].itemId);
      }
      if (event.key === 'ArrowDown' && index < members.length - 1) {
        move(item, columnId, members[index + 2]?.itemId);
      }
    }
  }
  function itemActions(item: WorkItem, columnId: string, event: MouseEvent<HTMLElement>) {
    if (!space || isRemoteBusy()) {
      return;
    }
    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();
    const members = space.members.filter((member) => member.columnId === columnId);
    const orderDisabled = space.view.sort !== 'manual' ? 'Choose manual order first' : undefined;
    const index = members.findIndex((member) => member.itemId === item.id);
    setMenu({
      trigger,
      position: { x: rect.left, y: rect.bottom },
      actions: [
        { id: 'open', label: 'Open details', run: () => openItem(item, trigger) },
        ...space.columns.map((column): UserAction => ({
          id: `move-${column.id}`,
          label: `Move to ${column.name}`,
          selected: column.id === columnId,
          disabled: column.id === columnId ? 'Already in this column' : undefined,
          run: () => move(item, column.id),
        })),
        {
          id: 'up',
          label: 'Move up',
          shortcut: 'Alt+↑',
          disabled: orderDisabled ?? (index === 0 ? 'Already first' : undefined),
          run: () => move(item, columnId, members[index - 1]?.itemId),
        },
        {
          id: 'down',
          label: 'Move down',
          shortcut: 'Alt+↓',
          disabled: orderDisabled ?? (index === members.length - 1 ? 'Already last' : undefined),
          run: () => move(item, columnId, members[index + 2]?.itemId),
        },
        {
          id: 'remove',
          label: 'Remove from this space',
          run: () => {
            changeSpace((space) => ({
              ...space,
              members: space.members.filter((member) => member.itemId !== item.id),
            }));
            setAnnouncement(`${item.title} removed from this space. It remains in the Vault.`);
          },
        },
      ],
    });
  }
  function drop(event: DragEvent, columnId: string, beforeId?: string) {
    event.preventDefault();
    event.stopPropagation();
    const source = drag.current;
    if (source?.vaultId !== work.vaultKey || source?.spaceId !== space?.id) {
      return;
    }
    const item = source ? itemMap.get(source.itemId) : null;
    if (item) {
      move(item, columnId, space?.view.sort === 'manual' ? beforeId : undefined);
    }
    drag.current = null;
  }
  const closeDialog = () => setDialog(null);
  const interactions = { selected, openItem, keyboardMove, itemActions, move };
  const dragInteractions = {
    onDragStart: (event: DragEvent, item: WorkItem) => {
      if (!space || !work.vaultKey) {
        return;
      }
      drag.current = { vaultId: work.vaultKey, spaceId: space.id, itemId: item.id };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', item.id);
    },
    onDragEnd: () => {
      drag.current = null;
    },
    onDragOver: (event: DragEvent) => {
      if (drag.current?.vaultId === work.vaultKey && drag.current?.spaceId === space?.id) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    drop,
  };
  return (
    <section className="work-context" aria-label="Work context">
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      <BoardHeader
        vaultName={vault.name}
        work={work}
        online={online}
        notice={notice}
        onDismiss={() => setNotice(null)}
        showDialog={showDialog}
      />
      {!state ? (
        <div className="work-empty" role="status">
          {work.status === 'loading'
            ? 'Loading project spaces from your Vault…'
            : 'The workspace is unavailable. Retry loading above; existing Vault data will not be replaced.'}
        </div>
      ) : (
        <>
          <BoardSpaceBar
            state={state}
            space={space}
            busy={busy}
            showDialog={showDialog}
            onSelect={(id) => {
              clearSelection();
              closeDialog();
              work.change((current) => ({ ...current, activeSpaceId: id }));
            }}
          />
          {!space ? (
            <div className="work-empty">
              <h2>A space for each project</h2>
              <p>
                Bring local tasks, GitHub issues, pull requests and Jira work into one adjustable
                flow. Your board stays independent of remote statuses.
              </p>
              <button className="primary" onClick={() => showDialog({ kind: 'space' })}>
                Create your first space
              </button>
            </div>
          ) : (
            <>
              <BoardToolbar
                space={space}
                work={work}
                changeView={changeView}
                showDialog={showDialog}
              />
              <BoardFilters space={space} changeView={changeView} />
              <BoardSources
                space={space}
                work={work}
                showDialog={showDialog}
                onConnections={onConnections}
              />
              <div className="work-content" ref={content} tabIndex={-1}>
                <div className="work-items-pane">
                  <div className="work-items-caption">
                    <span>
                      {items.length} of {space.members.length} items
                    </span>
                    <span>Columns are local. Alt + arrows moves a focused card.</span>
                  </div>
                  <BoardItemView
                    space={space}
                    items={items}
                    changeView={changeView}
                    board={
                      <BoardColumns
                        space={space}
                        visibleByColumn={visibleByColumn}
                        showDialog={showDialog}
                        {...interactions}
                        {...dragInteractions}
                      />
                    }
                    list={
                      <BoardList
                        space={space}
                        items={items}
                        columnByItem={columnByItem}
                        showDialog={showDialog}
                        {...interactions}
                      />
                    }
                  />
                </div>
                {selected && active ? (
                  <ItemDetail
                    key={`${work.vaultKey}:${space.id}:${selected.id}`}
                    item={selected}
                    space={space}
                    state={state}
                    connections={work.connections}
                    onChange={work.change}
                    onClose={closeItem}
                    onOpenNote={onOpenNote}
                    onError={setNotice}
                    onBusyChange={onBusyChange}
                  />
                ) : null}
              </div>
            </>
          )}
          {active ? (
            <BoardDialogHost
              dialog={dialog}
              work={work}
              state={state}
              space={space}
              closeDialog={closeDialog}
              onConnections={onConnections}
              changeSpace={changeSpace}
              openItem={openItem}
              selectItem={selectItem}
              setNotice={setNotice}
            />
          ) : null}
        </>
      )}
      {menu && active ? (
        <ContextMenu
          actions={menu.actions}
          position={menu.position}
          label="Work item actions"
          onClose={() => setMenu(null)}
          returnFocus={menu.trigger}
        />
      ) : null}
    </section>
  );
}

function BoardItemView({
  space,
  items,
  changeView,
  board,
  list,
}: {
  space: WorkSpace;
  items: WorkItem[];
  changeView: (view: Partial<WorkView>) => void;
  board: React.ReactNode;
  list: React.ReactNode;
}) {
  if (space.members.length > 0 && !items.length) {
    return (
      <div className="work-empty">
        <h2>No matching work</h2>
        <p>Adjust your filters to see the other items in this space.</p>
        <button onClick={() => changeView({ query: '', kind: 'all', priority: 'all' })}>
          Clear filters
        </button>
      </div>
    );
  }
  return space.view.mode === 'board' ? board : list;
}
