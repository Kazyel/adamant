export type DocumentKind = 'markdown' | 'pdf' | 'docx';

export interface SelectedDocument {
  path: string;
  name: string;
  kind: DocumentKind;
  bytes: number[];
}

export function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : String(error);
}
