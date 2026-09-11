import assert from 'node:assert/strict';
import test from 'node:test';
import { saveDirtyTabs, type DirtyTab } from './useDocumentSession.ts';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { history, undo } from '@codemirror/commands';
import { EditorState, type Transaction } from '@codemirror/state';
import { useDocumentSession, type DocumentSession } from './useDocumentSession.ts';

class SessionCapture extends Error {
  readonly session: DocumentSession;

  constructor(session: DocumentSession) {
    super('Captured the server-rendered session');
    this.session = session;
  }
}

function documentSession(defaultView?: Parameters<typeof useDocumentSession>[0]): DocumentSession {
  function Capture(): never {
    throw new SessionCapture(useDocumentSession(defaultView));
  }
  try {
    renderToString(createElement(Capture));
  } catch (error) {
    if (error instanceof SessionCapture) {
      return error.session;
    }
    throw error;
  }
  throw new Error('The session harness did not render.');
}

const dirtyTabs: DirtyTab[] = [
  { id: 'first', kind: 'markdown', source: null, dirty: true, conflict: null },
  { id: 'second', kind: 'markdown', source: null, dirty: true, conflict: null },
];

await test('saveDirtyTabs reports each document without hiding an independent failure', async () => {
  const results = await saveDirtyTabs(dirtyTabs, async (tab) => {
    if (tab.id === 'second') {
      throw new Error('conflict');
    }
  });
  assert.deepEqual(
    results.map((result) => ({ id: result.id, ok: result.ok })),
    [
      { id: 'first', ok: true },
      { id: 'second', ok: false },
    ],
  );
  assert.match(String(results[1].error), /conflict/);
});

await test('switching and reopening saved text keeps real editor undo; external reads keep dirty source', () => {
  const session = documentSession();
  const note = { path: 'a.md', text: 'a', revision: 'initial', id: 'a', metadataError: null };
  const id = session.openNote(note);
  const editor = {
    state: EditorState.create({ doc: 'a', extensions: [history()] }),
    dispatch(transaction: Transaction) {
      editor.state = transaction.state;
    },
  };
  editor.dispatch(
    editor.state.update({ changes: { from: 1, insert: '!' }, selection: { anchor: 0, head: 2 } }),
  );
  session.updateBuffer({
    ...session.bufferRef.current,
    text: 'a!',
    savedText: 'a!',
    source: { kind: 'vault', note: { ...note, text: 'a!', revision: 'saved' } },
  });
  session.setEditorState(id, editor.state);
  const editorKey = session.bufferRef.current.editorKey;
  session.openNote({ ...note, path: 'b.md', id: 'b' });
  assert.equal(session.openNote({ ...note, text: 'a!', revision: 'saved' }), id);
  const restored = session.tabsRef.current.find((tab) => tab.id === id)!;
  assert.equal(restored.editorKey, editorKey);
  assert.deepEqual(restored.editorState!.selection.main.toJSON(), { anchor: 0, head: 2 });
  editor.state = restored.editorState!;
  assert.equal(undo(editor), true);
  assert.equal(editor.state.doc.toString(), 'a');
  session.updateBuffer({ ...session.bufferRef.current, text: 'unsaved' });
  session.openNote({ ...note, text: 'external', revision: 'external' });
  assert.equal(session.bufferRef.current.text, 'unsaved');
  assert.equal(session.bufferRef.current.savedText, 'a!');
  assert.equal(session.bufferRef.current.conflict?.current?.text, 'external');
});

await test('new Markdown tabs use the current default view without changing retained tab views', () => {
  let defaultView: 'edit' | 'read' | 'split' = 'read';
  const session = documentSession(() => defaultView);
  const note = { path: 'a.md', text: 'a', revision: 'one', id: 'a', metadataError: null };
  const id = session.openNote(note);
  assert.equal(session.tabsRef.current.find((tab) => tab.id === id)!.view, 'read');
  session.updateTab(id, { view: 'edit' });
  defaultView = 'split';
  session.openNote(note);
  assert.equal(session.tabsRef.current.find((tab) => tab.id === id)!.view, 'edit');
  const nextId = session.openNote({ ...note, path: 'b.md', id: 'b' });
  assert.equal(session.tabsRef.current.find((tab) => tab.id === nextId)!.view, 'split');
  const standalone = {
    path: '/selected/readme.md',
    name: 'readme.md',
    kind: 'markdown' as const,
    bytes: new TextEncoder().encode('standalone'),
    revision: 1,
    vaultPath: null,
    identity: 'file:1:2',
  };
  const standaloneId = session.openDocument(standalone);
  assert.equal(session.tabsRef.current.find((tab) => tab.id === standaloneId)!.view, 'split');
  const state = session.persist('/vault', 'vault-id');
  defaultView = 'read';
  session.restore(state, '/vault', 'vault-id');
  session.openNote(note);
  session.openDocument(standalone);
  assert.equal(session.tabsRef.current.find((tab) => tab.id === id)!.view, 'edit');
  assert.equal(session.tabsRef.current.find((tab) => tab.id === standaloneId)!.view, 'split');
});

await test('all source kinds hydrate their existing lazy tab and reject replaced identities', () => {
  const session = documentSession();
  const note = {
    path: 'note.md',
    text: 'saved source',
    revision: 'one',
    id: 'note',
    metadataError: null,
  };
  const noteId = session.openNote(note);
  const markdown = {
    path: '/selected/readme.md',
    name: 'readme.md',
    kind: 'markdown' as const,
    bytes: new TextEncoder().encode('standalone'),
    revision: 1,
    vaultPath: null,
    identity: 'file:1:2',
  };
  const standaloneId = session.openDocument(markdown);
  const pdf = {
    ...markdown,
    path: '/vault/report.pdf',
    name: 'report.pdf',
    kind: 'pdf' as const,
    vaultPath: 'report.pdf',
    identity: 'file:1:3',
  };
  const pdfId = session.openDocument(pdf);
  session.updateTab(pdfId, { viewerState: { page: 8, zoom: 1.5 } });
  const docx = {
    ...pdf,
    path: '/selected/report.docx',
    name: 'report.docx',
    kind: 'docx' as const,
    vaultPath: null,
    identity: 'file:1:4',
  };
  const docxId = session.openDocument(docx);
  const state = session.persist('/vault', 'vault-id');
  assert.equal(session.restore(state, '/vault', 'vault-id'), true);
  assert.equal(session.tabsRef.current.find((tab) => tab.id === pdfId)!.document, null);
  assert.throws(() => session.openDocument({ ...pdf, identity: 'file:1:99' }), /same document/);
  assert.equal(session.tabsRef.current.find((tab) => tab.id === pdfId)!.restored, true);
  assert.equal(session.openNote(note), noteId);
  assert.equal(session.openDocument(markdown), standaloneId);
  assert.equal(session.bufferRef.current.text, 'standalone');
  assert.equal(session.openDocument(pdf), pdfId);
  const restoredPdf = session.tabsRef.current.find((tab) => tab.id === pdfId)!.viewerState!;
  assert.equal(restoredPdf.page, 8);
  assert.equal(restoredPdf.zoom, 1.5);
  assert.equal(session.openDocument(docx), docxId);
  assert.equal(session.tabsRef.current.length, state.tabs.length);
});

await test('standalone Markdown keeps its BOM and mixed line endings across lazy restoration', () => {
  const session = documentSession();
  const text = '\uFEFF# Preserved\r\n\r\nOlá\nLast line\r\n';
  const document = {
    path: '/selected/source.md',
    name: 'source.md',
    kind: 'markdown' as const,
    bytes: new TextEncoder().encode(text),
    revision: 1,
    vaultPath: null,
    identity: 'file:1:2',
  };
  const id = session.openDocument(document);
  assert.equal(session.bufferRef.current.text, text);
  const state = session.persist('/vault', 'vault-id');
  session.restore(state, '/vault', 'vault-id');
  session.hydrateTab(id, document);
  assert.equal(session.bufferRef.current.text, text);
});

await test('closing empty editors never creates reopen entries or evicts closed files', () => {
  const session = documentSession();
  const initial = session.activeIdRef.current;
  for (let index = 0; index < 20; index++) {
    session.close(session.activeIdRef.current!);
  }
  assert.equal(session.reopenClosed(), null);
  assert.equal(session.activeIdRef.current, initial);
  assert.equal(session.tabsRef.current.length, 1);

  const file = session.openNote({
    path: 'New document.md',
    text: '',
    revision: 'empty-file',
    id: 'saved-file',
    metadataError: null,
  });
  assert.deepEqual(
    session.tabsRef.current.map((tab) => tab.id),
    [file],
  );
  session.close(file);
  for (let index = 0; index < 20; index++) {
    session.close(session.newDraft());
    session.close(session.activeIdRef.current!);
  }
  assert.equal(session.reopenClosed(), file);
  assert.deepEqual(
    session.tabsRef.current.map((tab) => tab.id),
    [file],
  );
  assert.equal(session.bufferRef.current.source?.kind, 'vault');
  assert.equal(session.reopenClosed(), null);
});

await test('closing a nonempty draft still retains its text for reopening', () => {
  const session = documentSession();
  const draft = session.activeIdRef.current;
  session.updateBuffer({ ...session.bufferRef.current, text: 'Keep this draft' });
  session.close(draft!);
  session.close(session.activeIdRef.current!);
  assert.equal(session.reopenClosed(), draft);
  assert.equal(session.bufferRef.current.text, 'Keep this draft');
  assert.equal(session.reopenClosed(), null);
});

await test('opening documents replaces only the empty editor and failed opens preserve it', () => {
  const session = documentSession();
  const initial = session.activeIdRef.current;
  assert.equal(session.newDraft(), initial);
  const document = {
    path: '/selected/readme.md',
    name: 'readme.md',
    kind: 'markdown' as const,
    bytes: new Uint8Array([0xff]),
    revision: 1,
    vaultPath: null,
  };
  assert.throws(() => session.openDocument(document), TypeError);
  assert.deepEqual(
    session.tabsRef.current.map((tab) => tab.id),
    [initial],
  );
  const file = session.openDocument({ ...document, bytes: new TextEncoder().encode('File') });
  assert.deepEqual(
    session.tabsRef.current.map((tab) => tab.id),
    [file],
  );
  session.close(file);
  const draft = session.activeIdRef.current!;
  session.updateBuffer({ ...session.bufferRef.current, text: 'Unsaved draft' });
  const reopened = session.reopenClosed();
  assert.deepEqual(
    session.tabsRef.current.map((tab) => tab.id),
    [draft, reopened],
  );
  session.activate(draft);
  assert.equal(session.bufferRef.current.text, 'Unsaved draft');
});

await test('restoring older workspaces drops empty placeholders beside real documents', () => {
  const session = documentSession();
  const empty = session.persist('/vault', 'vault-id');
  const file = session.openNote({
    path: 'note.md',
    text: 'saved',
    revision: 'one',
    id: 'note',
    metadataError: null,
  });
  const saved = session.persist('/vault', 'vault-id');
  const legacy = { ...saved, tabs: [...empty.tabs, ...saved.tabs], activeId: empty.activeId };
  session.restore(legacy, '/vault', 'vault-id');
  assert.deepEqual(
    session.tabsRef.current.map((tab) => tab.id),
    [file],
  );
  assert.equal(session.activeIdRef.current, file);
  assert.equal(session.reopenClosed(), null);
  session.close(file);
  assert.equal(session.tabsRef.current.length, 1);
  session.updateBuffer({ ...session.bufferRef.current, text: 'Next document' });
  assert.equal(session.bufferRef.current.text, 'Next document');
});

await test('tab and retained-source limits reject only the new retention and preserve closed viewers for reopen', () => {
  const session = documentSession();
  const note = {
    path: 'overflow.md',
    text: 'saved',
    revision: 'one',
    id: 'note',
    metadataError: null,
  };
  for (let index = 0; index < 64; index++) {
    session.openNote({ ...note, path: `${index}.md`, id: `${index}` });
  }
  const before = session.tabsRef.current;
  assert.throws(() => session.openNote(note), /64 open tabs/);
  assert.equal(session.tabsRef.current, before);
  const closed = before[0].id;
  session.close(closed);
  assert.equal(session.reopenClosed(), closed);
  session.reset();
  const bytes = new Uint8Array(64 * 1024 * 1024);
  const ids = Array.from({ length: 4 }, (_, index) =>
    session.openDocument({
      path: `/selected/${index}.pdf`,
      name: `${index}.pdf`,
      kind: 'pdf',
      bytes,
      revision: index,
      vaultPath: null,
    }),
  );
  assert.deepEqual(
    session.tabsRef.current.map((tab) => tab.id),
    ids,
  );
  session.close(ids[0]);
  const retained = session.tabsRef.current;
  assert.throws(
    () =>
      session.openDocument({
        path: '/selected/overflow.pdf',
        name: 'overflow.pdf',
        kind: 'pdf',
        bytes: new Uint8Array(1),
        revision: 5,
        vaultPath: null,
      }),
    /256 MiB/,
  );
  assert.equal(session.tabsRef.current, retained);
  assert.equal(session.reopenClosed(), ids[0]);
  session.reset();
  session.close(session.activeIdRef.current!);
  assert.equal(session.tabsRef.current.length, 1);
  assert.equal(session.tabsRef.current[0].kind, 'markdown');
  session.updateBuffer({ ...session.bufferRef.current, text: 'still usable' });
  assert.equal(session.bufferRef.current.text, 'still usable');
});

await test('draft writes serialize by retained draft id and cannot attach to a replaced session', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const pending: Array<{ text: string; finish: () => void }> = [];
  let retained = '';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: (_command: string, args: { draft: { text: string } }) =>
          new Promise<void>((resolve) => {
            pending.push({
              text: args.draft.text,
              finish: () => {
                retained = args.draft.text;
                resolve();
              },
            });
          }),
      },
    },
  });
  try {
    const session = documentSession();
    const first = session.activeIdRef.current!;
    session.updateBuffer({ ...session.bufferRef.current, text: 'older draft' });
    session.updateTab(first, { draftId: 'recovery-id' });
    const firstWrite = session.retainDraft(session.tabsRef.current[0], '/vault', 'vault-id');
    await new Promise((resolve) => setImmediate(resolve));
    const second = session.newDraft();
    session.updateBuffer({ ...session.bufferRef.current, text: 'newer draft' });
    session.updateTab(second, { draftId: 'recovery-id' });
    const secondWrite = session.retainDraft(
      session.tabsRef.current.find((tab) => tab.id === second)!,
      '/vault',
      'vault-id',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      pending.length,
      1,
      'the same retained draft must have only one writer even across tab ids',
    );
    pending[0].finish();
    await firstWrite;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending[1].text, 'newer draft');
    const otherWorkspace = session.persist('/other-vault', 'other-vault-id');
    session.restore(otherWorkspace, '/other-vault', 'other-vault-id');
    pending[1].finish();
    await secondWrite;
    assert.equal(retained, 'newer draft');
    assert.equal(session.tabsRef.current.find((tab) => tab.id === second)!.draftId, null);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});
