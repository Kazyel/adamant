export type IconName =
  | 'document'
  | 'folder'
  | 'connections'
  | 'sidebar'
  | 'menu'
  | 'edit'
  | 'read'
  | 'split'
  | 'external'
  | 'chevron'
  | 'warning'
  | 'minimize'
  | 'maximize'
  | 'close'
  | 'new'
  | 'save'
  | 'refresh'
  | 'copy'
  | 'import'
  | 'search'
  | 'sort'
  | 'more'
  | 'trash'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'move'
  | 'star'
  | 'back'
  | 'forward'
  | 'check'
  | 'restore'
  | 'filter'
  | 'keyboard'
  | 'settings';

const paths: Record<IconName, string> = {
  document: 'M13 3H5v18h14V9l-6-6Zm0 0v6h6M8 13h8M8 17h6',
  folder: 'M3 7V5h6l2 2h10v13H3V7Zm0 4h18',
  connections:
    'M8 8 5 5m11 3 3-3M8 16l-3 3m11-3 3 3M8 8h8v8H8V8ZM3 3h4v4H3V3Zm14 0h4v4h-4V3ZM3 17h4v4H3v-4Zm14 0h4v4h-4v-4Z',
  sidebar: 'M3 4h18v16H3V4Zm6 0v16',
  menu: 'M4 6h16M4 12h16M4 18h16',
  edit: 'm14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z',
  read: 'M12 5v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Z',
  split: 'M3 4h18v16H3V4Zm9 0v16',
  external: 'M14 3h7v7m0-7L10 14M10 5H3v16h16v-7',
  chevron: 'm9 6 6 6-6 6',
  warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v1',
  minimize: 'M5 12h14',
  maximize: 'M5 5h14v14H5V5Z',
  close: 'm6 6 12 12M18 6 6 18',
  new: 'M13 3H5v18h14V9l-6-6Zm0 0v6h6M12 12v6m-3-3h6',
  save: 'M4 3h13l4 4v14H3V3h1Zm3 0v6h10V3M7 21v-8h10v8',
  refresh: 'M20 7V3l-3 3a8 8 0 1 0 3 11M20 7h-5',
  copy: 'M8 8h13v13H8V8ZM16 8V3H3v13h5',
  import: 'M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6',
  search: 'M17 17l4 4M19 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  sort: 'M8 4v16m-4-4 4 4 4-4M14 5h7M14 10h5M14 15h3',
  more: 'M5 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm7 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm7 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  cut: 'm8 8 12 12M8 16 20 4M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm0 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  paste: 'M9 5H5v16h14V5h-4M9 3h6v4H9V3ZM8 12h8M8 16h6',
  duplicate: 'M8 8h13v13H8V8ZM16 8V3H3v13h5M14 11v7m-3-3h6',
  move: 'M4 8V4h12v4M4 12v8h12v-4M10 12h11m-4-4 4 4-4 4',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z',
  back: 'm10 5-7 7 7 7M3 12h18',
  forward: 'm14 5 7 7-7 7M3 12h18',
  check: 'm5 12 4 4L19 6',
  restore: 'M4 4v6h6M4 10a8 8 0 1 1 1 9M12 7v6l4 2',
  filter: 'M3 5h18l-7 8v7l-4-2v-5L3 5Z',
  keyboard: 'M3 5h18v14H3V5ZM6 9h1m4 0h1m4 0h1M6 12h1m4 0h1m4 0h1M7 16h10',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',
};

export default function WorkspaceIcon({ name }: { name: IconName }) {
  return (
    <svg
      className="workspace-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
