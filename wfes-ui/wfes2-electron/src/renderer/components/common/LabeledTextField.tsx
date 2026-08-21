import React from 'react'

interface LabeledTextFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  error?: boolean
  helperText?: string
  tooltip?: string
  type?: 'text' | 'number'
  placeholder?: string
  disabled?: boolean
  width?: string
  required?: boolean
}

export const LabeledTextField: React.FC<LabeledTextFieldProps> = ({
  label,
  value,
  onChange,
  error = false,
  helperText,
  tooltip,
  type = 'text',
  placeholder,
  disabled = false,
  width = 'w-32',
  required = false,
}) => {
  return (
    <div className="flex items-start gap-2">
      <label 
        className={`native-label text-right min-w-[80px] pt-1 ${error ? 'text-red-600' : ''} ${tooltip ? 'cursor-help' : ''}`}
        title={tooltip}
      >
        {label}
        {required && <span className="text-red-600"> *</span>}
      </label>
      <div className="flex-1">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={`native-input ${width} ${
            error ? 'border-red-500 focus:border-red-500' : ''
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        />
        {helperText && (
          <p className={`text-xs mt-1 ${error ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
            {helperText}
          </p>
        )}
      </div>
    </div>
  )
}