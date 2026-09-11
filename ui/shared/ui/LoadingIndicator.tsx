import { useEffect, useState } from 'react';

export default function LoadingIndicator({ label }: { label: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 500);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <span className="loading-indicator" role="status">
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
