import { useId, useState } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import { OverlayPresence } from './OverlayPresence';
import CalendarPicker from './CalendarPicker';
import { dateLabel } from './calendar';
import './calendar.css';

export default function DateField({
  value,
  onChange,
  name,
  disabled,
  label = 'Due date',
}: {
  value?: string;
  onChange?: (value: string) => void;
  name?: string;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const [localValue, setLocalValue] = useState('');
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const selected = value ?? localValue;
  return (
    <span className="date-field">
      <button
        type="button"
        disabled={disabled}
        aria-label={`${label}: ${selected ? dateLabel(selected) : 'No date'}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(trigger)}
        aria-controls={trigger ? id : undefined}
        onClick={(event) => setTrigger(trigger ? null : event.currentTarget)}
      >
        <WorkspaceIcon name="calendar" />
        <span>{selected ? dateLabel(selected) : 'Set date'}</span>
      </button>
      {name ? <input type="hidden" name={name} value={selected} disabled={disabled} /> : null}
      <OverlayPresence>
        {trigger && !disabled ? (
          <CalendarPicker
            id={id}
            label={label}
            value={selected}
            trigger={trigger}
            onClose={() => setTrigger(null)}
            onSelect={(next) => {
              setLocalValue(next);
              onChange?.(next);
            }}
          />
        ) : null}
      </OverlayPresence>
    </span>
  );
}
