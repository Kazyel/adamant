import type { BufferState } from './buffer';
import type {
  ExplorerPage,
  IndexState,
  OpenedDocument,
  VaultEntry,
  VaultSnapshot,
  WorkspacePrompt,
} from './types';
import type { DocumentSession, SessionTab } from './session/useDocumentSession';
import type { DraftRecord } from './session/persistence';
import type { RecoverySelection } from './session/useWorkspacePersistence';
import type { NavigationController } from '../navigation/useNavigation';
import type { SearchHit } from '../navigation/navigationTypes';
import type { EditorPreferences, UserAction } from '../interaction/types';
import type { FileActions } from './useFileActions';
import type { DirectoryListingOptions } from './useDirectoryPages';

interface WorkspaceDocuments extends Omit<DocumentSession, 'reopenClosed'> {
  reopenClosed: () => void;
}

export interface Workspace {
  vault: VaultSnapshot | null;
  documents: WorkspaceDocuments;
  finder: NavigationController;
  fileActions: FileActions;
  preferences: EditorPreferences;
  savePreferences: (preferences: EditorPreferences) => Promise<void>;
  recoveries: DraftRecord[];
  recovery: RecoverySelection | null;
  inspectRecovery: (draft: DraftRecord) => Promise<void>;
  recoverDraft: () => void;
  discardRecovery: (id: string) => Promise<void>;
  cancelRecovery: () => void;
  saveAll: () => void;
  closeTab: (id: string | null) => void;
  closeActiveTab: () => void;
  reopenTab: () => void;
  newTab: () => void;
  openPath: (path: string, expectedIdentity?: string | null, view?: SessionTab['view']) => void;
  openSearchHit: (hit: SearchHit) => void;
  navigateHistory: (direction: -1 | 1) => void;
  revealActive: () => void;
  copyActiveLink: () => Promise<void>;
  copyLink: (path: string) => Promise<void>;
  favoriteActive: () => void;
  toggleFavorite: (path: string) => void;
  refreshPages: () => void;
  repairLocalStorage: () => void;
  setDirectoryOptions: (options: DirectoryListingOptions) => void;
  registerExplorerActions: (actions: UserAction[]) => void;
  getExplorerActions: () => UserAction[];
  revealPath: (path: string, options?: { focus?: boolean }) => Promise<void>;
  revealTarget: { path: string; focus: boolean } | null;
  pages: ReadonlyMap<string, ExplorerPage>;
  indexing: IndexState | null;
  indexAction: 'reconcile' | 'cancel' | null;
  toggleDirectory: (directory: string, open: boolean) => void;
  loadMore: (directory: string) => void;
  buffer: BufferState;
  selected: OpenedDocument | null;
  showOriginal: boolean;
  setShowOriginal: (show: boolean) => void;
  busy: 'save' | 'navigate' | 'background' | null;
  notice: { error: boolean; text: string } | null;
  prompt: WorkspacePrompt | null;
  answer: (value: string | null) => void;
  reconcile: () => void;
  cancelIndex: () => void;
  dirty: boolean;
  changeText: (text: string) => void;
  chooseVault: (mode: 'create' | 'open') => void;
  closeVault: () => void;
  newNote: () => void;
  importFiles: () => void;
  adoptNote: () => void;
  openEntry: (entry: VaultEntry) => void;
  openDocument: () => void;
  save: () => void;
  saveCopy: () => void;
  reloadDisk: () => void;
  openOriginal: () => void;
  fail: (error: unknown) => void;
  closeWindow: () => void;
}
