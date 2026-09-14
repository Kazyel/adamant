import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { GraphSize } from './graphDrawing';

export default function GraphNodePopover({
  anchor,
  size,
  children,
  onClose,
}: {
  anchor: { x: number; y: number };
  size: GraphSize;
  children: ReactNode;
  onClose: () => void;
}) {
  const close = useEffectEvent(onClose);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(280);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    element.addEventListener('keydown', key);
    return () => {
      observer.disconnect();
      element.removeEventListener('keydown', key);
    };
  }, []);
  const width = Math.min(252, size.width - 32);
  const left = anchor.x + width + 40 <= size.width ? anchor.x + 24 : anchor.x - width - 24;
  const top = anchor.y + height + 84 <= size.height ? anchor.y + 20 : anchor.y - height - 20;
  const outside = anchor.x < 0 || anchor.y < 0 || anchor.x > size.width || anchor.y > size.height;
  return (
    <div
      ref={ref}
      className="graph-node-popover"
      role="dialog"
      aria-label="Selected file details"
      aria-modal="false"
      hidden={outside}
      style={{
        width,
        left: Math.max(16, Math.min(left, size.width - width - 16)),
        top: Math.max(16, Math.min(top, size.height - height - 64)),
        maxHeight: Math.max(120, size.height - 96),
      }}
    >
      <button
        type="button"
        className="icon-button graph-popover-close"
        aria-label="Close file details"
        onClick={onClose}
      >
        <WorkspaceIcon name="close" />
      </button>
      {children}
    </div>
  );
}
