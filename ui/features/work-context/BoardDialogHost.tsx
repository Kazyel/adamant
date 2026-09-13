import type { ReactElement } from 'react';
import {
  NameDialog,
  TaskDialog,
  FlowDialog,
  FollowDialog,
  ExistingDialog,
  ConflictDialog,
} from './BoardDialogs';
import BoardSourceDialog from './BoardSourceDialog';
import { OverlayPresence } from '../interaction/OverlayPresence';
import { attachItems, createSpace, moveItem, updateSpace } from './state';
import type { BoardDialog, BoardWork } from './BoardModel';
import type { WorkItem, WorkSpace, WorkState } from './types';

type DialogProps = {
  dialog: BoardDialog | null;
  work: BoardWork;
  state: WorkState;
  space: WorkSpace | null;
  closeDialog: () => void;
  onConnections: () => void;
  changeSpace: (update: (space: WorkSpace) => WorkSpace) => void;
  openItem: (item: WorkItem) => void;
  selectItem: (id: string) => void;
  setNotice: (notice: string) => void;
};

function SpaceDialog({
  dialog,
  space,
  work,
  closeDialog,
  changeSpace,
}: DialogProps & {
  dialog: Extract<BoardDialog, { kind: 'space' }>;
}) {
  return (
    <NameDialog
      title={dialog.rename ? 'Rename space' : 'New project space'}
      initial={dialog.rename ? (space?.name ?? '') : ''}
      onClose={closeDialog}
      onSave={(name) => {
        if (dialog.rename) {
          changeSpace((space) => ({ ...space, name }));
        } else {
          const created = createSpace(name);
          work.change((state) => ({
            ...state,
            activeSpaceId: created.id,
            spaces: [...state.spaces, created],
          }));
        }
        closeDialog();
      }}
    />
  );
}

function NewTaskDialog({
  dialog,
  space,
  work,
  closeDialog,
  openItem,
}: DialogProps & {
  dialog: Extract<BoardDialog, { kind: 'task' }>;
  space: WorkSpace;
}) {
  return (
    <TaskDialog
      onClose={closeDialog}
      onSave={(item) => {
        work.change((state) => {
          const next = attachItems(state, space.id, [item]);
          return dialog.columnId
            ? updateSpace(next, space.id, (space) => moveItem(space, item.id, dialog.columnId!))
            : next;
        });
        closeDialog();
        openItem(item);
      }}
    />
  );
}

function EditSourceDialog({
  dialog,
  work,
  closeDialog,
  onConnections,
  changeSpace,
  setNotice,
}: DialogProps & {
  dialog: Extract<BoardDialog, { kind: 'source' }>;
}) {
  return (
    <BoardSourceDialog
      source={dialog.source}
      connections={work.connections}
      onClose={closeDialog}
      onConnections={() => {
        closeDialog();
        onConnections();
      }}
      onRemove={() => {
        changeSpace((space) => ({
          ...space,
          sources: space.sources.filter((source) => source.id !== dialog.source?.id),
        }));
        closeDialog();
        setNotice('Source removed. Items already followed remain in this space.');
      }}
      onSave={(source) => {
        changeSpace((space) => ({
          ...space,
          sources: dialog.source
            ? space.sources.map((entry) => (entry.id === source.id ? source : entry))
            : [...space.sources, source],
        }));
        closeDialog();
      }}
    />
  );
}

export default function BoardDialogHost(props: DialogProps) {
  const { dialog, state, space, work, closeDialog, changeSpace, openItem, selectItem, setNotice } =
    props;
  let content: ReactElement | null = null;
  if (dialog?.kind === 'space') {
    content = <SpaceDialog {...props} dialog={dialog} />;
  } else if (dialog?.kind === 'conflict') {
    content = (
      <ConflictDialog
        state={state}
        readSaved={work.readSaved}
        resolve={work.resolve}
        onClose={closeDialog}
      />
    );
  } else if (dialog && space) {
    switch (dialog.kind) {
      case 'task':
        content = <NewTaskDialog {...props} dialog={dialog} space={space} />;
        break;
      case 'source':
        content = <EditSourceDialog {...props} dialog={dialog} />;
        break;
      case 'columns':
        content = (
          <FlowDialog
            space={space}
            onClose={closeDialog}
            onSave={(columns) => {
              changeSpace((space) => ({ ...space, columns }));
              closeDialog();
            }}
          />
        );
        break;
      case 'follow':
        content = (
          <FollowDialog
            connections={work.connections}
            follow={work.follow}
            onClose={closeDialog}
            onDone={(id, warning) => {
              closeDialog();
              selectItem(id);
              if (warning) {
                setNotice(warning);
              }
            }}
          />
        );
        break;
      case 'existing':
        content = (
          <ExistingDialog
            state={state}
            space={space}
            onClose={closeDialog}
            onAdd={(item) => {
              work.change((state) => attachItems(state, space.id, [item]));
              closeDialog();
              openItem(item);
            }}
          />
        );
        break;
    }
  }
  return <OverlayPresence>{content}</OverlayPresence>;
}
