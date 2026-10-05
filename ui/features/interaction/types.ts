import type { IconName } from '../../shared/ui/WorkspaceIcon';
import { validFontFamily, type FontFamily } from '../../shared/styles/fontFamilies.ts';

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
  showDocumentTabs?: boolean;
  interfaceFont?: FontFamily;
  fontSize: number;
  editorFont?: FontFamily;
  readingFont?: FontFamily;
  readingFontSize?: number;
  wordWrap: boolean;
  indentSize: number;
  defaultView: 'edit' | 'read' | 'split';
};

export const defaultEditorPreferences: EditorPreferences = {
  theme: 'dark',
  showDocumentTabs: true,
  fontSize: 17,
  editorFont: 'inter',
  readingFont: 'libron',
  readingFontSize: 17,
  wordWrap: true,
  indentSize: 2,
  defaultView: 'edit',
};

function supportedFont(value: unknown) {
  return value === undefined || validFontFamily(value);
}

function validFontPreferences(data: Record<string, unknown>) {
  return (
    supportedFont(data.interfaceFont) &&
    supportedFont(data.editorFont) &&
    supportedFont(data.readingFont) &&
    (data.readingFontSize === undefined ||
      (typeof data.readingFontSize === 'number' &&
        data.readingFontSize >= 12 &&
        data.readingFontSize <= 32))
  );
}

export function validEditorPreferences(value: unknown): value is EditorPreferences {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    (data.theme === undefined || data.theme === 'dark' || data.theme === 'light') &&
    (data.showDocumentTabs === undefined || typeof data.showDocumentTabs === 'boolean') &&
    validFontPreferences(data) &&
    typeof data.fontSize === 'number' &&
    data.fontSize >= 8 &&
    data.fontSize <= 48 &&
    typeof data.wordWrap === 'boolean' &&
    Number.isInteger(data.indentSize) &&
    [2, 4, 8].includes(data.indentSize as number) &&
    ['edit', 'read', 'split'].includes(data.defaultView as string)
  );
}
