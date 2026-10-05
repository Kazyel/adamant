import type { SessionTab } from '../workspace/session/useDocumentSession';

type OpenTab = Pick<SessionTab, 'id' | 'source' | 'document' | 'retained' | 'dirty'>;

export type QuickOpenItem = {
  key: string;
  name: string;
  path: string;
} & ({ kind: 'tab'; tabId: string; dirty: boolean } | { kind: 'path' });

function tabPaths(tab: OpenTab): { path: string; vaultPath?: string } {
  if (tab.source?.kind === 'vault') {
    return { path: tab.source.note.path, vaultPath: tab.source.note.path };
  }
  if (tab.source?.kind === 'standalone') {
    return { path: tab.source.path ?? '' };
  }
  if (tab.document) {
    return {
      path: tab.document.vaultPath ?? tab.document.path,
      vaultPath: tab.document.vaultPath ?? undefined,
    };
  }
  if (tab.retained) {
    return {
      path: tab.retained.sourcePath ?? tab.retained.path,
      vaultPath: tab.retained.sourceKind === 'vault' ? tab.retained.path : undefined,
    };
  }
  return { path: '' };
}

export function quickOpenItems(
  tabs: readonly OpenTab[],
  paths: readonly string[],
  query: string,
): QuickOpenItem[] {
  const openVaultPaths = new Set<string>();
  const items: QuickOpenItem[] = tabs.map((tab) => {
    const { path, vaultPath } = tabPaths(tab);
    if (vaultPath) {
      openVaultPaths.add(vaultPath);
    }
    return {
      kind: 'tab',
      key: `tab:${tab.id}`,
      tabId: tab.id,
      path,
      name: path.split(/[/\\]/).at(-1) || tab.retained?.name || 'Untitled',
      dirty: tab.dirty,
    };
  });
  for (const path of paths) {
    if (!openVaultPaths.has(path)) {
      items.push({ kind: 'path', key: `path:${path}`, name: path.split('/').at(-1)!, path });
    }
  }
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter((item) =>
    `${item.name} ${item.path}`.toLocaleLowerCase().includes(normalized),
  );
}

export function adjacentTabId(
  tabs: readonly Pick<SessionTab, 'id'>[],
  activeId: string | null,
  direction: -1 | 1,
): string | undefined {
  if (!tabs.length) {
    return undefined;
  }
  const index = tabs.findIndex((tab) => tab.id === activeId);
  return tabs[(Math.max(0, index) + direction + tabs.length) % tabs.length]?.id;
}
