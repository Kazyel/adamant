type IconName =
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
  | 'import';

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
