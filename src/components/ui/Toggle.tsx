interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, disabled }: ToggleProps) {
  return (
    <label className={`ui-toggle ${disabled ? "ui-toggle-disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="ui-toggle-track">
        <span className="ui-toggle-thumb" />
      </span>
    </label>
  );
}
