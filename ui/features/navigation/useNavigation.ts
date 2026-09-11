import { useCallback, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { errorMessage } from '../../shared/errors';
import type {
  NavigationDocument,
  NavigationState,
  SearchHit,
  SearchMode,
  SearchPage,
} from './navigationTypes';

const MAX_RECENT = 100;
const MAX_HISTORY = 100;
const MAX_RESULTS = 500;
const initial: NavigationState = {
  recent: [],
  favorites: [],
  history: [],
  historyIndex: -1,
  expanded: [],
  identities: {},
  favoriteIdentities: {},
};

type SearchRequest = {
  id: string;
  mode: SearchMode;
  query: string;
  offset: number;
  controller: AbortController;
};
export interface NavigationController {
  state: NavigationState;
  stateRef: RefObject<NavigationState>;
  setState: Dispatch<SetStateAction<NavigationState>>;
  results: SearchHit[];
  searchPage: SearchPage | null;
  searchStatus: SearchPage['indexing'] | null;
  currentDocument: NavigationDocument | null;
  canBack: boolean;
  canForward: boolean;
  search: (query: string, mode: SearchMode) => Promise<void>;
  continueSearch: () => Promise<void>;
  loadMoreSearch: () => Promise<void>;
  cancelSearch: () => void;
  resetScope: () => void;
  navigate: (document: NavigationDocument, identity?: string | null) => void;
  rememberTarget: (path: string, identity: string) => void;
  toggleFavorite: (path: string, identity?: string | null) => void;
  remapPaths: (mappings: ReadonlyArray<{ from: string; to: string; id?: string | null }>) => void;
  missing: ReadonlySet<string>;
  markMissing: (path: string, value?: boolean) => void;
  back: () => void;
  forward: () => void;
}

function sameDocument(left: NavigationDocument, right: NavigationDocument) {
  return (
    left.path === right.path &&
    left.line === right.line &&
    left.column === right.column &&
    left.identity === right.identity
  );
}
function boundedIdentities(
  identities: Record<string, string>,
  recent: readonly string[],
  favorites: readonly string[],
  history: readonly NavigationDocument[],
): Record<string, string> {
  const referenced = new Set([
    ...recent,
    ...favorites,
    ...history.map((document) => document.path),
  ]);
  return Object.fromEntries(
    Object.entries(identities)
      .filter(([path]) => referenced.has(path))
      .slice(-400),
  );
}

function sortHits(hits: SearchHit[], mode: SearchMode): SearchHit[] {
  return [...hits].sort(
    (a, b) =>
      a.path.localeCompare(b.path, undefined, {
        numeric: true,
        sensitivity: mode === 'path' ? 'base' : 'variant',
      }) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0),
  );
}
export function useNavigation(initialState: Partial<NavigationState> = {}): NavigationController {
  const [state, setReactState] = useState<NavigationState>({
    ...initial,
    ...initialState,
    identities: initialState.identities ?? {},
    favoriteIdentities: initialState.favoriteIdentities ?? {},
  });
  const stateRef = useRef(state);
  const setState = useCallback<Dispatch<SetStateAction<NavigationState>>>((value) => {
    const next = typeof value === 'function' ? value(stateRef.current) : value;
    stateRef.current = next;
    setReactState(next);
  }, []);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchPage['indexing'] | null>(null);
  const [searchPage, setSearchPage] = useState<SearchPage | null>(null);
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const request = useRef<SearchRequest | null>(null);
  const resultsRef = useRef<SearchHit[]>([]);

  const navigate = useCallback(
    (doc: NavigationDocument, identity?: string | null) =>
      setState((current) => {
        const branch =
          current.historyIndex >= 0
            ? current.history.slice(0, current.historyIndex + 1)
            : current.history;
        const identities = { ...current.identities };
        const location = { ...doc, identity: identity ?? doc.identity ?? null };
        if (identity) {
          identities[doc.path] = identity;
        }
        const recent = [doc.path, ...current.recent.filter((path) => path !== doc.path)].slice(
          0,
          MAX_RECENT,
        );
        if (branch.length && sameDocument(branch[branch.length - 1], location)) {
          return {
            ...current,
            identities: boundedIdentities(identities, recent, current.favorites, branch),
            recent,
          };
        }
        const history = [...branch, location].slice(-MAX_HISTORY);
        return {
          ...current,
          identities: boundedIdentities(identities, recent, current.favorites, history),
          history,
          historyIndex: history.length - 1,
          recent,
        };
      }),
    [setState],
  );

  const rememberTarget = useCallback(
    (path: string, identity: string) => {
      if (!identity) {
        return;
      }
      setState((current) => {
        const identities = { ...current.identities, [path]: identity };
        return {
          ...current,
          identities: Object.fromEntries(Object.entries(identities).slice(-400)),
        };
      });
    },
    [setState],
  );

  const toggleFavorite = useCallback(
    (path: string, identity?: string | null) =>
      setState((current) => {
        const exists = current.favorites.includes(path);
        const identities = { ...current.identities };
        const favoriteIdentities = { ...current.favoriteIdentities };
        if (exists) {
          delete favoriteIdentities[path];
          if (
            !current.recent.includes(path) &&
            !current.history.some((document) => document.path === path)
          ) {
            delete identities[path];
          }
        } else if (identity) {
          identities[path] = identity;
          favoriteIdentities[path] = identity;
        }
        return {
          ...current,
          identities,
          favoriteIdentities,
          favorites: exists
            ? current.favorites.filter((candidate) => candidate !== path)
            : [...current.favorites, path].slice(-MAX_RECENT),
        };
      }),
    [setState],
  );

  const remapPaths = useCallback(
    (mappings: ReadonlyArray<{ from: string; to: string; id?: string | null }>) => {
      if (!mappings.length) {
        return;
      }
      const remap = (path: string, identity?: string | null) => {
        const mapping = mappings.find(({ from }) => path === from || path.startsWith(`${from}/`));
        if (mapping?.id && identity && identity !== `uuid:${mapping.id}`) {
          return path;
        }
        return mapping ? mapping.to + path.slice(mapping.from.length) : path;
      };
      setState((current) => {
        const identities: Record<string, string> = {};
        for (const [path, identity] of Object.entries(current.identities)) {
          identities[remap(path)] = identity;
        }
        const history = current.history.map((document) => ({
          ...document,
          path: remap(document.path, document.identity),
        }));
        const recent = [
          ...new Set(current.recent.map((path) => remap(path, current.identities[path]))),
        ].slice(0, MAX_RECENT);
        const favorites = [
          ...new Set(
            current.favorites.map((path) => remap(path, current.favoriteIdentities[path])),
          ),
        ].slice(0, MAX_RECENT);
        const favoriteIdentities = Object.fromEntries(
          Object.entries(current.favoriteIdentities).map(([path, identity]) => [
            remap(path, identity),
            identity,
          ]),
        );
        return {
          ...current,
          identities: boundedIdentities(identities, recent, favorites, history),
          favoriteIdentities,
          recent,
          favorites,
          history,
          historyIndex: Math.min(current.historyIndex, history.length - 1),
        };
      });
      setMissing((current) => new Set([...current].map((path) => remap(path))));
    },
    [setState],
  );

  const markMissing = useCallback(
    (path: string, value = true) =>
      setMissing((current) => {
        const next = new Set(current);
        if (value) {
          next.add(path);
        } else {
          next.delete(path);
        }
        return next;
      }),
    [],
  );

  const fetchPage = useCallback(
    async (current: SearchRequest, offset: number, expectedGeneration: number | null) => {
      if (!isTauri() || current.controller.signal.aborted) {
        return null;
      }
      const page = await invoke<SearchPage>('vault_search', {
        query: current.query,
        mode: current.mode,
        requestId: current.id,
        offset,
        limit: 50,
        expectedGeneration,
      });
      if (request.current?.id !== current.id || current.controller.signal.aborted) {
        return null;
      }
      current.offset = offset + page.hits.length;
      const nextResults = sortHits(
        (offset === 0 ? page.hits : [...resultsRef.current, ...page.hits]).slice(0, MAX_RESULTS),
        current.mode,
      );
      resultsRef.current = nextResults;
      const reachedLimit = nextResults.length >= MAX_RESULTS;
      const nextPage = {
        ...page,
        hits: page.hits,
        hasMore: page.hasMore && !reachedLimit,
        truncated: page.truncated || (page.hasMore && reachedLimit),
      };
      setSearchPage(nextPage);
      setSearchStatus(page.indexing);
      setResults(nextResults);
      return nextPage;
    },
    [],
  );

  const search = useCallback(
    async (query: string, mode: SearchMode) => {
      const previous = request.current;
      previous?.controller.abort();
      if (previous) {
        void invoke('vault_cancel_search', { requestId: previous.id }).catch(() => undefined);
      }
      const current: SearchRequest = {
        id: crypto.randomUUID(),
        mode,
        query,
        offset: 0,
        controller: new AbortController(),
      };
      request.current = current;
      resultsRef.current = [];
      setResults([]);
      setSearchPage(null);
      setSearchStatus(null);
      if (!isTauri() || !query.trim()) {
        request.current = null;
        setSearchStatus(null);
        return;
      }
      try {
        await fetchPage(current, 0, null);
      } catch (error) {
        if (!current.controller.signal.aborted && request.current?.id === current.id) {
          setSearchStatus({
            state: 'stale',
            scannedEntries: 0,
            indexedDocuments: 0,
            message: errorMessage(error),
          });
        }
      }
    },
    [fetchPage],
  );

  const continueSearch = useCallback(async () => {
    const current = request.current;
    const page = searchPage;
    if (!current || !page?.canContinue) {
      if (current && page && current.offset >= MAX_RESULTS) {
        setSearchStatus({
          ...page.indexing,
          message: 'Search results are capped at 500 occurrences; coverage remains incomplete.',
        });
      }
      return;
    }
    try {
      // Content indexing advances only when the query restarts at offset zero.
      await fetchPage(current, current.mode === 'content' ? 0 : current.offset, page.generation);
    } catch (error) {
      if (!current.controller.signal.aborted && request.current?.id === current.id) {
        setSearchStatus({ ...page.indexing, state: 'stale', message: errorMessage(error) });
      }
    }
  }, [fetchPage, searchPage]);

  const loadMoreSearch = useCallback(async () => {
    const current = request.current;
    const page = searchPage;
    if (!current || !page?.hasMore || current.offset >= MAX_RESULTS) {
      return;
    }
    try {
      await fetchPage(current, page.canContinue ? 0 : current.offset, page.generation);
    } catch (error) {
      if (!current.controller.signal.aborted && request.current?.id === current.id) {
        setSearchStatus({ ...page.indexing, state: 'stale', message: errorMessage(error) });
      }
    }
  }, [fetchPage, searchPage]);

  const cancelSearch = useCallback(() => {
    const current = request.current;
    if (current) {
      current.controller.abort();
      void invoke('vault_cancel_search', { requestId: current.id }).catch(() => undefined);
      request.current = null;
    }
    setSearchStatus((status) =>
      status
        ? {
            ...status,
            state: 'cancelled',
            message: 'Search cancelled; displayed results are retained.',
          }
        : {
            state: 'cancelled',
            scannedEntries: 0,
            indexedDocuments: 0,
            message: 'Search cancelled.',
          },
    );
  }, []);

  const resetScope = useCallback(() => {
    cancelSearch();
    resultsRef.current = [];
    setResults([]);
    setSearchPage(null);
    setSearchStatus(null);
    setMissing(new Set());
  }, [cancelSearch]);

  const back = useCallback(
    () =>
      setState((current) => ({
        ...current,
        historyIndex: Math.max(-1, current.historyIndex - 1),
      })),
    [setState],
  );

  const forward = useCallback(
    () =>
      setState((current) => ({
        ...current,
        historyIndex: Math.min(current.history.length - 1, current.historyIndex + 1),
      })),
    [setState],
  );

  const currentDocument = state.history[state.historyIndex] ?? null;
  const canBack = state.historyIndex > 0;
  const canForward = state.historyIndex >= 0 && state.historyIndex < state.history.length - 1;

  return {
    state,
    stateRef,
    setState,
    results,
    searchPage,
    searchStatus,
    currentDocument,
    canBack,
    canForward,
    search,
    continueSearch,
    loadMoreSearch,
    cancelSearch,
    resetScope,
    navigate,
    rememberTarget,
    toggleFavorite,
    remapPaths,
    missing,
    markMissing,
    back,
    forward,
  };
}
