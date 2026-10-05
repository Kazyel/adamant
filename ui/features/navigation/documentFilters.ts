export type DocumentKind = 'markdown' | 'pdf' | 'docx';
export interface DocumentFiltersState {
  directory: string;
  tags: string[];
  kinds: DocumentKind[];
}
export const emptyDocumentFilters: DocumentFiltersState = { directory: '', tags: [], kinds: [] };

export function hasDocumentFilters(filters: DocumentFiltersState) {
  return !!filters.directory || filters.tags.length > 0 || filters.kinds.length > 0;
}

export function matchesDocumentFilters(
  document: { path: string; kind: DocumentKind; tags: readonly string[] },
  filters: DocumentFiltersState,
) {
  const directory = filters.directory.replace(/\/+$/g, '');
  return (
    (!directory || document.path.startsWith(`${directory}/`)) &&
    (!filters.kinds.length || filters.kinds.includes(document.kind)) &&
    filters.tags.every((tag) => document.tags.includes(tag))
  );
}

export function tagError(tag: string, tags: readonly string[] = []): string | null {
  if (!tag.trim()) {
    return 'Enter a tag.';
  }
  for (const character of tag) {
    const code = character.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code <= 159)) {
      return 'Tags cannot contain control characters.';
    }
  }
  if (new TextEncoder().encode(tag.trim()).length > 128) {
    return 'Tags can contain up to 128 bytes.';
  }
  if (tags.length >= 64 && !tags.includes(tag.trim())) {
    return 'Use up to 64 tags.';
  }
  return null;
}
