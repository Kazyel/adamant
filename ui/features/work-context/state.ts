import type { Connection, Priority, RemoteRef, WorkItem, WorkSpace, WorkState } from './types';

export const priorities: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];
export const kindLabels = {
  local: 'Local task',
  'github-issue': 'GitHub issue',
  'github-pr': 'Pull request',
  jira: 'Jira issue',
};

export function createSpace(name: string): WorkSpace {
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    columns: ['Backlog', 'In progress', 'Done'].map((name) => ({ id: crypto.randomUUID(), name })),
    members: [],
    sources: [],
    view: { mode: 'board', query: '', kind: 'all', priority: 'all', sort: 'manual' },
  };
}

export function createTask(title: string): WorkItem {
  return {
    id: crypto.randomUUID(),
    kind: 'local',
    title: title.trim(),
    description: '',
    remote: null,
    url: null,
    remoteState: null,
    assignee: '',
    labels: [],
    priority: 'none',
    dueDate: '',
    checklist: [],
    links: [],
    updatedAt: new Date().toISOString(),
    fetchedAt: null,
  };
}

export function updateSpace(
  state: WorkState,
  spaceId: string,
  update: (space: WorkSpace) => WorkSpace,
): WorkState {
  return {
    ...state,
    spaces: state.spaces.map((space) => (space.id === spaceId ? update(space) : space)),
  };
}

/** Remote content is shared; personal organization and per-space placement are not remote state. */
export function attachItems(state: WorkState, spaceId: string, incoming: WorkItem[]): WorkState {
  const space = state.spaces.find((entry) => entry.id === spaceId);
  if (!space?.columns[0] || !incoming.length) {
    return state;
  }
  const items = new Map(state.items.map((item) => [item.id, item]));
  const members = [...space.members];
  const memberIds = new Set(members.map((member) => member.itemId));
  for (const item of incoming) {
    const previous = items.get(item.id);
    items.set(
      item.id,
      previous
        ? {
            ...item,
            priority: previous.priority,
            dueDate: previous.dueDate,
            checklist: previous.checklist,
            links: previous.links,
          }
        : item,
    );
    if (!memberIds.has(item.id)) {
      members.push({ itemId: item.id, columnId: space.columns[0].id });
      memberIds.add(item.id);
    }
  }
  return updateSpace({ ...state, items: [...items.values()] }, spaceId, (entry) => ({
    ...entry,
    members,
  }));
}

export function moveItem(
  space: WorkSpace,
  itemId: string,
  columnId: string,
  beforeId?: string,
): WorkSpace {
  if (
    !space.columns.some((column) => column.id === columnId) ||
    !space.members.some((member) => member.itemId === itemId) ||
    beforeId === itemId
  ) {
    return space;
  }
  const members = space.members.filter((member) => member.itemId !== itemId);
  const before = beforeId
    ? members.findIndex((member) => member.itemId === beforeId && member.columnId === columnId)
    : -1;
  if (before >= 0) {
    members.splice(before, 0, { itemId, columnId });
  } else {
    members.push({ itemId, columnId });
  }
  return { ...space, members };
}

export function visibleItems(space: WorkSpace, items: Map<string, WorkItem>): WorkItem[] {
  const query = space.view.query.trim().toLocaleLowerCase();
  const result = space.members.flatMap(({ itemId }) => {
    const item = items.get(itemId);
    if (
      !item ||
      (space.view.kind !== 'all' && space.view.kind !== item.kind) ||
      (space.view.priority !== 'all' && space.view.priority !== item.priority)
    ) {
      return [];
    }
    if (
      query &&
      !`${item.title} ${item.remote?.scope ?? ''} ${item.remote?.number ?? ''} ${item.url ?? ''} ${item.assignee} ${item.labels.join(' ')}`
        .toLocaleLowerCase()
        .includes(query)
    ) {
      return [];
    }
    return [item];
  });
  if (space.view.sort === 'updated') {
    result.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  if (space.view.sort === 'priority') {
    result.sort((a, b) => priorities.indexOf(b.priority) - priorities.indexOf(a.priority));
  }
  if (space.view.sort === 'due') {
    result.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  }
  return result;
}

export function connectionHost(host: string): string {
  try {
    return new URL(host.includes('://') ? host : `https://${host}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function remoteFromUrl(value: string, connection: Connection): RemoteRef {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a complete HTTPS issue or pull request URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.toLowerCase() !== connectionHost(connection.host)
  ) {
    throw new Error('The HTTPS URL must belong to the selected connection’s host.');
  }
  if (connection.provider === 'github') {
    const match = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (match && /^[A-Za-z0-9_.-]+$/.test(match[1]) && /^[A-Za-z0-9_.-]+$/.test(match[2])) {
      return {
        provider: 'github',
        host: connection.host,
        scope: `${match[1]}/${match[2]}`,
        number: match[3],
      };
    }
  } else {
    const match = /^\/browse\/([A-Za-z][A-Za-z0-9_]*)-([1-9]\d*)\/?$/.exec(url.pathname);
    if (match) {
      return {
        provider: 'jira',
        host: connection.host,
        scope: match[1].toUpperCase(),
        number: `${match[1].toUpperCase()}-${match[2]}`,
      };
    }
  }
  throw new Error(
    connection.provider === 'github'
      ? 'Use a GitHub issue or pull request URL.'
      : 'Use a Jira issue URL ending in /browse/PROJECT-123.',
  );
}
