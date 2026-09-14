import { dateLabel } from '../interaction/calendar';
import SelectField from '../interaction/SelectField';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import { kindLabels } from './state';
import { itemReference } from './BoardModel';
import type { BoardDialog } from './BoardModel';
import type { WorkItem, WorkSpace } from './types';
import useBoardMotion from './useBoardMotion';

type ItemInteractions = {
  selected: WorkItem | null | undefined;
  openItem: (item: WorkItem, trigger?: HTMLElement) => void;
  keyboardMove: (event: KeyboardEvent, item: WorkItem, columnId: string) => void;
  itemActions: (item: WorkItem, columnId: string, event: MouseEvent<HTMLElement>) => void;
  move: (item: WorkItem, columnId: string, beforeId?: string) => void;
};
type DragInteractions = {
  onDragStart: (event: DragEvent, item: WorkItem) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent) => void;
  drop: (event: DragEvent, columnId: string, beforeId?: string) => void;
};

function BoardCard({
  item,
  columnId,
  selected,
  openItem,
  keyboardMove,
  itemActions,
  onDragStart,
  onDragEnd,
  onDragOver,
  drop,
}: ItemInteractions &
  DragInteractions & {
    item: WorkItem;
    columnId: string;
  }) {
  const fetchedAt = item.fetchedAt
    ? `Last fetched ${new Date(item.fetchedAt).toLocaleString()}`
    : 'No fetch timestamp';
  return (
    <li>
      <div
        className={`work-card${selected?.id === item.id ? ' is-selected' : ''}`}
        data-tooltip={item.remote ? `Cached snapshot. ${fetchedAt}` : undefined}
        draggable
        onDragStart={(event) => onDragStart(event, item)}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={(event) => drop(event, columnId, item.id)}
      >
        <div className="work-card-top">
          <span className="work-kind">
            <WorkspaceIcon name={item.remote ? 'link' : 'task'} />
            {kindLabels[item.kind]}
          </span>
          <button
            className="icon-button"
            aria-label={`Actions for ${item.title}`}
            aria-haspopup="menu"
            onClick={(event) => itemActions(item, columnId, event)}
          >
            <WorkspaceIcon name="more" />
          </button>
        </div>
        <button
          className="work-card-open"
          data-work-item={item.id}
          aria-pressed={selected?.id === item.id}
          onClick={(event) => openItem(item, event.currentTarget)}
          onKeyDown={(event) => keyboardMove(event, item, columnId)}
        >
          {item.title}
        </button>
        {item.remote ? (
          <div className="work-remote-line">
            <span>{itemReference(item)}</span>
            <span className="work-item-state">{item.remoteState}</span>
          </div>
        ) : null}
        <div className="work-card-metadata">
          {item.priority !== 'none' ? (
            <span className={`work-priority priority-${item.priority}`}>{item.priority}</span>
          ) : null}
          {item.dueDate ? <time dateTime={item.dueDate}>Due {item.dueDate}</time> : null}
          {item.assignee ? <span>{item.assignee}</span> : null}
          {item.checklist.length ? (
            <span>
              {item.checklist.filter((entry) => entry.done).length}/{item.checklist.length} done
            </span>
          ) : null}
        </div>
        {item.labels.length ? (
          <div className="work-labels">
            {item.labels.slice(0, 3).map((label) => (
              <span key={label}>{label}</span>
            ))}
            {item.labels.length > 3 ? <span>+{item.labels.length - 3}</span> : null}
          </div>
        ) : null}
        {item.remote ? <small className="work-cache-label">Cached snapshot</small> : null}
      </div>
    </li>
  );
}

export function BoardColumns({
  space,
  visibleByColumn,
  showDialog,
  ...interactions
}: ItemInteractions &
  DragInteractions & {
    space: WorkSpace;
    visibleByColumn: Map<string, WorkItem[]>;
    showDialog: (dialog: BoardDialog) => void;
  }) {
  const { boardRef, over } = useBoardMotion(space.view.sort === 'manual');
  const onDragOver = (event: DragEvent) => {
    interactions.onDragOver(event);
    over(event);
  };
  return (
    <section ref={boardRef} className="work-board" aria-label={`${space.name} board`}>
      {space.columns.map((column) => (
        <div
          className="work-column"
          key={column.id}
          onDragOver={onDragOver}
          onDrop={(event) => interactions.drop(event, column.id)}
        >
          <header>
            <h2 id={`heading-${column.id}`}>{column.name}</h2>
            <span>{visibleByColumn.get(column.id)?.length ?? 0}</span>
            <button
              className="icon-button"
              aria-label={`Add task to ${column.name}`}
              onClick={() => showDialog({ kind: 'task', columnId: column.id })}
            >
              <WorkspaceIcon name="plus" />
            </button>
          </header>
          <ol className="work-cards">
            {(visibleByColumn.get(column.id) ?? []).map((item) => (
              <BoardCard
                key={item.id}
                item={item}
                columnId={column.id}
                {...interactions}
                onDragOver={onDragOver}
              />
            ))}
          </ol>
          {!visibleByColumn.get(column.id)?.length ? (
            <div className="work-column-empty">
              <p>No items here</p>
              <button onClick={() => showDialog({ kind: 'task', columnId: column.id })}>
                <WorkspaceIcon name="plus" />
                Add task
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function BoardListRow({
  item,
  column,
  space,
  selected,
  openItem,
  keyboardMove,
  itemActions,
  move,
}: ItemInteractions & {
  item: WorkItem;
  column: WorkSpace['columns'][number];
  space: WorkSpace;
}) {
  return (
    <tr key={item.id} className={selected?.id === item.id ? 'is-selected' : ''}>
      <td className="work-list-identity">
        <span className="work-list-kind-icon" data-tooltip={kindLabels[item.kind]}>
          <WorkspaceIcon name={item.remote ? 'link' : 'task'} />
        </span>
        <div className="work-list-title-block">
          <button
            className="work-list-open"
            data-work-item={item.id}
            aria-pressed={selected?.id === item.id}
            onClick={(event) => openItem(item, event.currentTarget)}
            onKeyDown={(event) => keyboardMove(event, item, column.id)}
          >
            {item.title}
          </button>
          <div className="work-list-reference">
            <span>{kindLabels[item.kind]}</span>
            {item.remote ? (
              <span data-tooltip="Cached remote snapshot">{itemReference(item)}</span>
            ) : null}
            {item.remoteState ? (
              <span className="work-list-remote-state">{item.remoteState}</span>
            ) : null}
            {item.assignee ? <span>{item.assignee}</span> : null}
            {item.checklist.length ? (
              <span>
                {item.checklist.filter((entry) => entry.done).length}/{item.checklist.length} done
              </span>
            ) : null}
          </div>
        </div>
      </td>
      <td>
        <SelectField
          aria-label={`Column for ${item.title}`}
          value={column.id}
          onChange={(event) => move(item, event.target.value)}
        >
          {space.columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </SelectField>
      </td>
      <td>
        {item.priority !== 'none' ? (
          <span className={`work-list-priority work-priority priority-${item.priority}`}>
            <span aria-hidden="true" />
            {item.priority}
          </span>
        ) : (
          <span className="work-list-muted">No priority</span>
        )}
      </td>
      <td className="work-list-date">
        {item.dueDate ? (
          <time dateTime={item.dueDate}>{dateLabel(item.dueDate)}</time>
        ) : (
          <span className="work-list-muted">No date</span>
        )}
      </td>
      <td>
        <button
          className="icon-button"
          aria-label={`Actions for ${item.title}`}
          aria-haspopup="menu"
          onClick={(event) => itemActions(item, column.id, event)}
        >
          <WorkspaceIcon name="more" />
        </button>
      </td>
    </tr>
  );
}

export function BoardList({
  items,
  space,
  columnByItem,
  showDialog,
  ...interactions
}: ItemInteractions & {
  items: WorkItem[];
  space: WorkSpace;
  columnByItem: Map<string, WorkSpace['columns'][number]>;
  showDialog: (dialog: BoardDialog) => void;
}) {
  return (
    <div className="work-list-scroll">
      <table className="work-list">
        <caption className="visually-hidden">{space.name} work items</caption>
        <thead>
          <tr>
            <th scope="col">Work item</th>
            <th scope="col">Personal column</th>
            <th scope="col">Priority</th>
            <th scope="col">Due date</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <BoardListRow
              key={item.id}
              item={item}
              column={columnByItem.get(item.id)!}
              space={space}
              {...interactions}
            />
          ))}
        </tbody>
      </table>
      {!items.length ? (
        <div className="work-empty">
          <h2>No work in this space yet</h2>
          <p>Create a local task, add a source or follow an issue URL to get started.</p>
          <button className="primary" onClick={() => showDialog({ kind: 'task' })}>
            New local task
          </button>
        </div>
      ) : null}
    </div>
  );
}
