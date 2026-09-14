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
  theme?: 'dark' | 'light';
  fontSize: number;
  wordWrap: boolean;
  indentSize: number;
  defaultView: 'edit' | 'read' | 'split';
};

export const defaultEditorPreferences: EditorPreferences = {
  theme: 'dark',
  fontSize: 17,
  wordWrap: true,
  indentSize: 2,
  defaultView: 'edit',
};

export function validEditorPreferences(value: unknown): value is EditorPreferences {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    (data.theme === undefined || data.theme === 'dark' || data.theme === 'light') &&
    typeof data.fontSize === 'number' &&
    data.fontSize >= 10 &&
    data.fontSize <= 32 &&
    typeof data.wordWrap === 'boolean' &&
    Number.isInteger(data.indentSize) &&
    [2, 4, 8].includes(data.indentSize as number) &&
    ['edit', 'read', 'split'].includes(data.defaultView as string)
  );
}
