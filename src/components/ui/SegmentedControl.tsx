interface Option {
  label: string;
  value: string;
}

interface SegmentedControlProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}

export function SegmentedControl({
  options,
  value,
  onChange,
  disabled,
  size = "md",
}: SegmentedControlProps) {
  return (
    <div className={`ui-segmented ui-segmented-${size} ${disabled ? "ui-segmented-disabled" : ""}`}>
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          className={`ui-segmented-btn ${value === opt.value ? "active" : ""}`}
          onClick={() => !disabled && onChange(opt.value)}
          disabled={disabled}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
