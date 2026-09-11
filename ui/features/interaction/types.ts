import type { IconName } from '../../shared/ui/WorkspaceIcon';

export type UserAction = {
  id: string;
  label: string;
  group?: string;
  icon?: IconName;
  tone?: 'danger';
  shortcut?: string;
  disabled?: string;
  /** Present for mutually exclusive choices; true marks the current choice. */
  selected?: boolean;
  run: () => void | Promise<void>;
};

export type EditorPreferences = {
  fontSize: number;
  wordWrap: boolean;
  indentSize: number;
  defaultView: 'edit' | 'read' | 'split';
};

export const defaultEditorPreferences: EditorPreferences = {
  fontSize: 17,
  wordWrap: true,
  indentSize: 2,
  defaultView: 'edit',
};
