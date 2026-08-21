import React from 'react';

interface LabeledComboBoxProps {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  tooltip?: string;
  disabled?: boolean;
  width?: string;
}

export const LabeledComboBox: React.FC<LabeledComboBoxProps> = ({
  label,
  value,
  options,
  onChange,
  tooltip,
  disabled = false,
  width = 'w-32'
}) => {
  return (
    <div className="flex items-center space-x-2">
      <label
        className={`native-label ${disabled ? 'opacity-50' : ''} ${tooltip ? 'cursor-help' : ''}`}
        title={tooltip}
      >
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`native-select ${width} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
};