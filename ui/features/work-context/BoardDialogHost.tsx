import {
  NameDialog,
  TaskDialog,
  FlowDialog,
  FollowDialog,
  ExistingDialog,
  ConflictDialog,
} from './BoardDialogs';
import BoardSourceDialog from './BoardSourceDialog';
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
  if (!dialog) {
    return null;
  }
  if (dialog.kind === 'space') {
    return <SpaceDialog {...props} dialog={dialog} />;
  }
  if (dialog.kind === 'conflict') {
    return (
      <ConflictDialog
        state={state}
        readSaved={work.readSaved}
        resolve={work.resolve}
        onClose={closeDialog}
      />
    );
  }
  if (!space) {
    return null;
  }
  switch (dialog.kind) {
    case 'task':
      return <NewTaskDialog {...props} dialog={dialog} space={space} />;
    case 'source':
      return <EditSourceDialog {...props} dialog={dialog} />;
    case 'columns':
      return (
        <FlowDialog
          space={space}
          onClose={closeDialog}
          onSave={(columns) => {
            changeSpace((space) => ({ ...space, columns }));
            closeDialog();
          }}
        />
      );
    case 'follow':
      return (
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
    case 'existing':
      return (
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
  }
}
