import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import type { ExplorerPage, VaultEntry, VaultPage, VaultSnapshot } from './types';

interface PageRequest {
  session: number;
  generation: number;
}

const native = isTauri();

function appendDirectoryListing(
  result: VaultPage,
  directory: string,
  offset: number,
  entries: VaultEntry[],
  known: Set<string>,
) {
  if (
    result.directory !== directory ||
    result.offset !== offset ||
    (result.hasMore && result.entries.length === 0)
  ) {
    throw new Error('The directory changed while loading. Retry this listing.');
  }

  for (const entry of result.entries) {
    if (known.has(entry.path)) {
      continue;
    }

    known.add(entry.path);
    entries.push(entry);
  }
}

function removeDirectoryPages(pages: Map<string, ExplorerPage>, directory: string) {
  for (const path of pages.keys()) {
    if (path === directory || path.startsWith(`${directory}/`)) {
      pages.delete(path);
    }
  }
}

function reconcileDirectoryPages(pages: ReadonlyMap<string, ExplorerPage>, page: ExplorerPage) {
  const next = new Map(pages);
  next.set(page.directory, page);

  // Only a fully enumerated, ready parent can confirm an expanded child is gone.
  if (page.hasMore || page.indexing?.state !== 'ready') {
    return next;
  }

  const directories = new Set(
    page.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path),
  );
  for (const child of next.keys()) {
    if (!child || child === page.directory) {
      continue;
    }

    const separator = child.lastIndexOf('/');
    const parent = separator < 0 ? '' : child.slice(0, separator);
    if (parent === page.directory && !directories.has(child)) {
      removeDirectoryPages(next, child);
    }
  }

  return next;
}

export default function useDirectoryPages(
  vaultRef: RefObject<VaultSnapshot | null>,
  session: RefObject<number>,
  mounted: RefObject<boolean>,
) {
  const [pages, setPagesState] = useState<ReadonlyMap<string, ExplorerPage>>(() => new Map());
  const pagesRef = useRef(pages);
  const pageGeneration = useRef(0);
  const pageRequests = useRef(new Map<string, PageRequest>());

  function setPages(next: ReadonlyMap<string, ExplorerPage>) {
    pagesRef.current = next;
    setPagesState(next);
  }

  function emptyPage(directory: string): ExplorerPage {
    return {
      directory,
      entries: [],
      total: 0,
      hasMore: false,
      indexing: null,
      nextOffset: 0,
      loaded: false,
      loading: true,
      refreshing: false,
      error: null,
      generation: ++pageGeneration.current,
    };
  }

  function resetPages(open: boolean) {
    setPages(open ? new Map([['', emptyPage('')]]) : new Map());

    if (open) {
      void fetchPage('');
    }
  }

  function isCurrentPageRequest(directory: string, request: PageRequest) {
    return (
      mounted.current &&
      session.current === request.session &&
      pagesRef.current.get(directory)?.generation === request.generation
    );
  }

  async function loadDirectoryPage(
    directory: string,
    page: ExplorerPage,
    request: PageRequest,
  ): Promise<ExplorerPage | null> {
    let offset = page.refreshing ? 0 : page.nextOffset;
    const through = page.refreshing ? Math.max(100, page.nextOffset) : offset + 100;
    const entries = page.refreshing ? [] : page.entries.slice();
    const known = new Set(entries.map((entry) => entry.path));
    let result: VaultPage;

    do {
      result = await invoke<VaultPage>('vault_list_entries', { directory, offset, limit: 100 });
      if (!isCurrentPageRequest(directory, request)) {
        return null;
      }

      appendDirectoryListing(result, directory, offset, entries, known);
      offset += result.entries.length;
    } while (result.hasMore && offset < through);

    return {
      ...page,
      entries,
      total: result.total,
      hasMore: result.hasMore,
      indexing: result.indexing,
      nextOffset: offset,
      loaded: true,
      loading: false,
      refreshing: false,
      error: null,
    };
  }

  async function fetchPage(directory: string) {
    const page = pagesRef.current.get(directory);
    if (!native || !vaultRef.current || !page?.loading || pageRequests.current.has(directory)) {
      return;
    }

    const request = { session: session.current, generation: page.generation };
    pageRequests.current.set(directory, request);

    try {
      const loaded = await loadDirectoryPage(directory, page, request);
      if (!loaded || !isCurrentPageRequest(directory, request)) {
        return;
      }

      setPages(reconcileDirectoryPages(pagesRef.current, loaded));
    } catch (error) {
      if (isCurrentPageRequest(directory, request)) {
        const next = new Map(pagesRef.current);
        next.set(directory, { ...page, loading: false, error: errorMessage(error) });
        setPages(next);
      }
    } finally {
      if (pageRequests.current.get(directory) === request) {
        pageRequests.current.delete(directory);
      }

      // Keep visible rows while the newest generation revalidates their loaded
      // extent. An obsolete response never replaces or appends to that generation.
      if (
        mounted.current &&
        session.current === request.session &&
        pagesRef.current.get(directory)?.loading
      ) {
        void fetchPage(directory);
      }
    }
  }

  function toggleDirectory(directory: string, open: boolean) {
    if (!native || !vaultRef.current) {
      return;
    }

    const next = new Map(pagesRef.current);
    if (open) {
      if (next.has(directory)) {
        return;
      }
      next.set(directory, emptyPage(directory));
    } else {
      removeDirectoryPages(next, directory);
    }
    setPages(next);

    if (open) {
      void fetchPage(directory);
    }
  }

  function loadMore(directory: string) {
    const page = pagesRef.current.get(directory);
    if (!page || page.loading || (page.loaded && !page.hasMore && !page.error)) {
      return;
    }

    const next = new Map(pagesRef.current);
    next.set(directory, {
      ...page,
      loading: true,
      error: null,
      generation: ++pageGeneration.current,
    });
    setPages(next);
    void fetchPage(directory);
  }

  function refreshPages() {
    // Only root and expanded branches exist in this map; unopened folders are
    // never enumerated, and collapsed subtrees release their pages.
    const next = new Map<string, ExplorerPage>();
    for (const [directory, page] of pagesRef.current) {
      next.set(directory, {
        ...page,
        loading: true,
        refreshing: true,
        error: null,
        generation: ++pageGeneration.current,
      });
    }
    setPages(next);

    for (const directory of next.keys()) {
      void fetchPage(directory);
    }
  }

  return {
    pages,
    resetPages,
    clearPageRequests: () => pageRequests.current.clear(),
    refreshPages,
    toggleDirectory,
    loadMore,
  };
}
