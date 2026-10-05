import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { VaultPage, VaultSnapshot } from './types.ts';
import type useDirectoryPages from './useDirectoryPages.ts';

type DirectoryPages = ReturnType<typeof useDirectoryPages>;

class PagesCapture extends Error {
  readonly pages: DirectoryPages;

  constructor(pages: DirectoryPages) {
    super('Captured directory requests');
    this.pages = pages;
  }
}

interface ListingRequest {
  directory: string;
  offset: number;
  generation: number | null;
}

await test('progressive directory refreshes coalesce, retain pagination, and retry against a fresh inventory', async () => {
  const requests: {
    args: ListingRequest;
    resolve: (page: VaultPage) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousTauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout,
      __TAURI_INTERNALS__: {
        invoke(command: string, args: ListingRequest) {
          assert.equal(command, 'vault_list_entries');
          return new Promise<VaultPage>((resolve, reject) => {
            requests.push({ args, resolve, reject });
          });
        },
      },
    },
  });
  try {
    const { default: usePages } = await import('./useDirectoryPages.ts');
    const indexing = {
      state: 'indexing',
      scannedEntries: 300,
      indexedDocuments: 300,
      message: null,
    } as const;
    const vault: VaultSnapshot = {
      id: 'vault',
      name: 'Files',
      root: '/vault',
      contentRoot: '.',
      issues: [],
      issueCount: 0,
      indexing,
    };
    function Capture(): never {
      throw new PagesCapture(usePages({ current: vault }, { current: 1 }, { current: true }));
    }
    let pages: DirectoryPages;
    try {
      renderToString(createElement(Capture));
      throw new Error('The directory harness did not render.');
    } catch (error) {
      if (!(error instanceof PagesCapture)) {
        throw error;
      }
      pages = error.pages;
    }
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    async function respond(index: number, generation: number) {
      const request = requests[index];
      const { directory, offset } = request.args;
      request.resolve({
        directory,
        offset,
        generation,
        limit: 100,
        total: 300,
        hasMore: offset + 100 < 300,
        indexing,
        entries: Array.from({ length: 100 }, (_, entry) => ({
          path: `file-${offset + entry}.md`,
          kind: 'markdown',
          id: null,
          metadataError: null,
          modifiedAt: null,
        })),
      });
      await settle();
    }

    pages.resetPages(true);
    await respond(0, 1);
    pages.loadMore('');
    assert.equal(requests[1].args.offset, 100);
    await respond(1, 1);

    pages.refreshPages(true);
    assert.equal(requests[2].args.generation, null);
    pages.refreshPages(true);
    pages.refreshPages(true);
    assert.equal(requests.length, 3, 'pending reads must not restart at each scan tick');
    await respond(2, 2);
    assert.equal(requests[3].args.offset, 100);
    requests[3].reject({ kind: 'conflict', message: 'Inventory changed' });
    await settle();
    assert.equal(requests[4].args.offset, 0);
    assert.equal(requests[4].args.generation, null);
    await respond(4, 3);
    assert.equal(requests[5].args.offset, 100, 'a retry must retain the loaded extent');
    await respond(5, 3);
    assert.equal(requests[6].args.offset, 0, 'queued scan batches get one follow-up refresh');
    await respond(6, 4);
    await respond(7, 4);
    assert.equal(requests.length, 8, 'refreshing does not create a request loop');

    pages.loadMore('');
    assert.equal(requests[8].args.offset, 200);
    assert.equal(requests[8].args.generation, 4);
    await respond(8, 4);
    pages.loadMore('');
    assert.equal(requests.length, 9);

    // Deleting a folder can settle its pending listing after the reveal was cancelled.
    const controller = new AbortController();
    pages.refreshPages();
    const revealing = pages.revealPath('removed/', controller.signal);
    const rejection = assert.rejects(revealing, { name: 'AbortError' });
    controller.abort();
    await respond(9, 5);
    await respond(10, 5);
    await respond(11, 5);
    await rejection;

    pages.refreshPages();
    pages.removePaths(['not-loaded.md']);
    const stale = requests[12];
    const deletedEntry = {
      path: 'not-loaded.md',
      kind: 'markdown' as const,
      id: null,
      metadataError: null,
      modifiedAt: null,
    };
    const stalePage: VaultPage = {
      directory: '',
      offset: 0,
      generation: 6,
      limit: 100,
      total: 1,
      hasMore: false,
      indexing,
      entries: [deletedEntry],
    };
    stale.resolve(stalePage);
    await settle();
    const retired = assert.rejects(pages.revealPath('not-loaded.md'), /Could not find not-loaded/);
    const fresh = requests[13];
    if (fresh) {
      fresh.resolve({ ...stalePage, generation: 7, total: 0, entries: [] });
    }
    await retired;

    const rootRequest = requests.length;
    pages.refreshPages();
    requests[rootRequest].resolve({
      ...stalePage,
      generation: 8,
      indexing: { ...indexing, state: 'ready' },
      entries: [{ ...deletedEntry, path: 'closing', kind: 'directory' }],
    });
    await settle();
    pages.toggleDirectory('closing', true);
    const waitingController = new AbortController();
    const waiting = pages.revealPath('closing/', waitingController.signal);
    await settle();
    const refreshedParent = requests.length;
    pages.refreshPages();
    requests[refreshedParent].resolve({
      ...stalePage,
      generation: 9,
      total: 0,
      indexing: { ...indexing, state: 'ready' },
      entries: [],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(
        Promise.race([
          waiting,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Reveal kept waiting for a removed page')),
              200,
            );
          }),
        ]),
        /Could not find closing/,
      );
    } finally {
      clearTimeout(timer);
      waitingController.abort();
      await waiting.catch(() => undefined);
    }
  } finally {
    if (previousTauri) {
      Object.defineProperty(globalThis, 'isTauri', previousTauri);
    } else {
      Reflect.deleteProperty(globalThis, 'isTauri');
    }
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});
