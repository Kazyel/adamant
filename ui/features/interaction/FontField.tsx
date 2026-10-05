import { fontFamilies, validFontFamily, type FontFamily } from '../../shared/styles/fontFamilies';
import SelectField from './SelectField';

export default function FontField({
  id,
  label,
  describedBy,
  value,
  disabled,
  allowDefault = false,
  onChange,
}: {
  id: string;
  label: string;
  describedBy: string;
  value?: FontFamily;
  disabled: boolean;
  allowDefault?: boolean;
  onChange: (font: FontFamily | undefined) => void;
}) {
  const selectedFont = typeof value === 'string' ? value : 'local';
  return (
    <div className="interaction-font-field">
      <SelectField
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        value={value === undefined ? 'default' : selectedFont}
        disabled={disabled}
        onChange={(event) => {
          const selected = event.target.value;
          if (selected === 'default') {
            onChange(undefined);
          } else {
            onChange(validFontFamily(selected) ? selected : { local: '' });
          }
        }}
      >
        {allowDefault ? <option value="default">Adamant default</option> : null}
        {Object.entries(fontFamilies).map(([key, font]) => (
          <option key={key} value={key}>
            {font.label}
          </option>
        ))}
        <option value="local">Installed font…</option>
      </SelectField>
      {value && typeof value !== 'string' ? (
        <>
          <label htmlFor={`${id}-local`}>Installed family name</label>
          <input
            id={`${id}-local`}
            aria-label={`${label} installed family name`}
            aria-describedby={`${id}-local-help`}
            type="text"
            required
            pattern=".*\S.*"
            placeholder="e.g. Noto Sans"
            value={value.local}
            disabled={disabled}
            onChange={(event) => onChange({ local: event.target.value })}
          />
          <p id={`${id}-local-help`}>
            Use the family name shown by your system's font manager. If unavailable, Inter is used.
          </p>
        </>
      ) : null}
    </div>
  );
}
