export type DocumentKind = 'markdown' | 'pdf' | 'docx';

export interface SelectedDocument {
  path: string;
  name: string;
  kind: DocumentKind;
  bytes: number[];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
