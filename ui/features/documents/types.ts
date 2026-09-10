type DocumentKind = 'markdown' | 'pdf' | 'docx';

export interface SelectedDocument {
  path: string;
  name: string;
  kind: DocumentKind;
  bytes: number[];
}
