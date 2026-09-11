export type NavigationDocument = {
  path: string;
  line?: number | null;
  column?: number | null;
  identity?: string | null;
};
export type SearchMode = 'path' | 'content';
export type SearchHit = {
  path: string;
  kind: 'markdown' | 'pdf' | 'docx';
  id: string | null;
  identity: string;
  line: number | null;
  column: number | null;
  snippet: string;
  revision: string | null;
};
type IndexState = {
  state: 'indexing' | 'ready' | 'partial' | 'stale' | 'cancelled';
  scannedEntries: number;
  indexedDocuments: number;
  message: string | null;
};
export type SearchPage = {
  requestId: string;
  generation: number;
  hits: SearchHit[];
  hasMore: boolean;
  truncated: boolean;
  indexing: IndexState;
  canContinue: boolean;
};
export type NavigationState = {
  recent: string[];
  favorites: string[];
  history: NavigationDocument[];
  historyIndex: number;
  expanded: string[];
  identities: Record<string, string>;
  favoriteIdentities: Record<string, string>;
};

function encodePath(path: string) {
  return path
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** Link from a saved Markdown document to a path relative to its directory. */
export function relativeMarkdownLink(from: string, to: string, fragment?: string | null): string {
  const base = from.split('/').filter(Boolean).slice(0, -1);
  const target = to.split('/').filter(Boolean);
  while (base.length && target.length && base[0] === target[0]) {
    base.shift();
    target.shift();
  }
  const path = [...base.map(() => '..'), ...target].join('/');
  const encoded = encodePath(path) || '.';
  return encoded + (fragment ? `#${encodeURIComponent(fragment.replace(/^#/, ''))}` : '');
}

/** Explicit root-relative form used when the source document has no path. */
function rootRelativeMarkdownLink(to: string, fragment?: string | null): string {
  const encoded = encodePath(to) || '.';
  return '/' + encoded + (fragment ? `#${encodeURIComponent(fragment.replace(/^#/, ''))}` : '');
}
export function markdownLink(from: string | null, to: string, fragment?: string | null): string {
  const label = (to.split('/').filter(Boolean).at(-1) ?? to) || 'Vault';
  const escapedLabel = label.replace(/[\\[\]]/g, '\\$&');
  const target = from
    ? relativeMarkdownLink(from, to, fragment)
    : rootRelativeMarkdownLink(to, fragment);
  return `[${escapedLabel}](${target})`;
}

/** Resolve a document link inside its Vault, not against the webview or filesystem URL. */
export function resolveMarkdownLink(from: string | null, href: string) {
  const origin = 'https://vault.invalid';
  const target = new URL(href, `${origin}/${from ? encodePath(from) : ''}`);
  if (target.origin !== origin || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    throw new Error('Expected a relative document link.');
  }
  return {
    path: decodeURIComponent(target.pathname.slice(1)).replace(/\/$/, ''),
    anchor: target.hash,
  };
}

export function unicodeLocation(source: string, offset: number): { line: number; column: number } {
  let safe = Math.max(0, Math.min(offset, source.length));
  // Editor offsets are UTF-16. Never split a surrogate pair when calculating
  // the source prefix, otherwise a supplementary character counts twice.
  if (
    safe > 0 &&
    safe < source.length &&
    source.charCodeAt(safe - 1) >= 0xd800 &&
    source.charCodeAt(safe - 1) <= 0xdbff
  ) {
    safe -= 1;
  }
  const before = source.slice(0, safe);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  const last = before.lastIndexOf('\n');
  return { line, column: Array.from(before.slice(last + 1)).length + 1 };
}
