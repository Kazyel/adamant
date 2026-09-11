import { useEffect, useState } from 'react';
import { ContextMenu } from '../interaction/ContextMenu';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { DirectoryListingOptions } from './useDirectoryPages';

type Sort = NonNullable<DirectoryListingOptions['sort']>;

const labels: Record<Sort, string> = {
  name: 'Name',
  type: 'Type',
  modified: 'Modified',
};

export default function ExplorerSort({
  value,
  onChange,
}: {
  value: Sort;
  onChange: (value: Sort) => void;
}) {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    trigger: HTMLButtonElement;
  } | null>(null);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = () => setMenu(null);
    const scroll = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(menu.trigger)) {
        close();
      }
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [menu]);

  function open(trigger: HTMLButtonElement) {
    const bounds = trigger.getBoundingClientRect();
    setMenu({ x: bounds.left, y: bounds.bottom + 6, trigger });
  }

  return (
    <>
      <button
        id="explorer-sort"
        className="icon-button explorer-sort"
        type="button"
        title={`Sort files: ${labels[value]}`}
        aria-label={`Sort files: ${labels[value]}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(event) => (menu ? setMenu(null) : open(event.currentTarget))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            open(event.currentTarget);
          }
        }}
      >
        <WorkspaceIcon name="sort" />
      </button>
      {menu ? (
        <ContextMenu
          position={menu}
          returnFocus={menu.trigger}
          label="Sort files"
          title="Sort files"
          onClose={() => setMenu(null)}
          triggerTogglesMenu
          actions={Object.entries(labels).map(([sort, label]) => ({
            id: sort,
            label,
            selected: sort === value,
            run: () => onChange(sort as Sort),
          }))}
        />
      ) : null}
    </>
  );
}
