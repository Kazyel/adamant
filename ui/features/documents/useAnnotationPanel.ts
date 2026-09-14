import { useState } from 'react';
import type { Workspace } from '../workspace/workspaceTypes';
import { tabIdentity } from '../workspace/session/useDocumentSession';

export type AnnotationMode = 'notes' | 'create' | 'link';

interface AnnotationSession {
  root: string;
  vaultId: string;
  sourceTab: string;
  mode: AnnotationMode;
}

export function useAnnotationPanel(workspace: Workspace) {
  const [session, setSession] = useState<AnnotationSession | null>(null);
  const [focusIdentity, setFocusIdentity] = useState<string | null>(null);
  const owner = workspace.documents.activeTab;
  const path =
    owner?.document?.vaultPath ?? (owner?.source?.kind === 'vault' ? owner.source.note.path : null);
  const identity = owner ? tabIdentity(owner) : null;
  const available = !!workspace.vault && !!path && !!identity && !owner?.restored;
  const visible = matchesSession(session, workspace);

  function show(mode: AnnotationMode) {
    if (!available || !workspace.vault || !owner || workspace.busy) {
      return;
    }
    setSession({
      root: workspace.vault.root,
      vaultId: workspace.vault.id,
      sourceTab: owner.id,
      mode,
    });
  }

  function close() {
    if (!workspace.busy) {
      setSession(null);
    }
  }

  function openNote(path: string, id: string) {
    setFocusIdentity(`uuid:${id}`);
    setSession(null);
    workspace.openPath(path, `uuid:${id}`, 'edit');
  }

  return {
    available,
    owner,
    path,
    identity,
    visible,
    mode: session?.mode ?? 'notes',
    show,
    close,
    openNote,
    focusOnOpen: !!focusIdentity && identity === focusIdentity,
    finishFocus: () => setFocusIdentity(null),
  };
}

function matchesSession(session: AnnotationSession | null, workspace: Workspace) {
  return (
    !!session &&
    workspace.vault?.root === session.root &&
    workspace.vault.id === session.vaultId &&
    workspace.documents.activeId === session.sourceTab
  );
}

export type AnnotationPanelController = ReturnType<typeof useAnnotationPanel>;
