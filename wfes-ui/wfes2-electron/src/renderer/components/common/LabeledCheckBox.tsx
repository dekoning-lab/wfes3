import React from 'react';

interface LabeledCheckBoxProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  tooltip?: string;
  disabled?: boolean;
}

export const LabeledCheckBox: React.FC<LabeledCheckBoxProps> = ({
  label,
  checked,
  onChange,
  tooltip,
  disabled = false
}) => {
  return (
    <div className="flex items-center space-x-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="native-checkbox"
        id={`checkbox-${label.replace(/\s+/g, '-').toLowerCase()}`}
      />
      <label
        htmlFor={`checkbox-${label.replace(/\s+/g, '-').toLowerCase()}`}
        className={`native-label ${disabled ? 'opacity-50' : ''} ${tooltip ? 'cursor-help' : ''} cursor-default`}
        title={tooltip}
      >
        {label}
      </label>
    </div>
  );
};