/**
 * @file WfesParameterInput.tsx
 * @brief Unified parameter input component for WFES forms
 * 
 * This component provides a consistent interface for all parameter inputs
 * across the WFES application, supporting various input types with
 * validation, tooltips, and help text.
 */

import React from 'react'
import { TextInput, NumberInput, Checkbox, Select, Tooltip, Text } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'

/**
 * @type InputType
 * @brief Supported input types for WFES parameters
 */
type InputType = 'text' | 'number' | 'checkbox' | 'select' | 'scientific'

/**
 * @interface WfesParameterInputProps
 * @brief Props for the WfesParameterInput component
 */
interface WfesParameterInputProps {
  /** Type of input to render */
  type?: InputType
  /** Label text for the input */
  label: string
  /** Brief description shown under the label */
  description?: string
  /** Tooltip text shown on hover */
  tooltip?: string
  /** Help text displayed below the input */
  helpText?: string
  /** Current value of the input */
  value: any
  /** Callback when value changes */
  onChange: (value: any) => void
  /** Error state or message */
  error?: boolean | string
  /** Whether the field is required */
  required?: boolean
  /** Whether the field is disabled */
  disabled?: boolean
  // For number inputs
  /** Minimum allowed value */
  min?: number
  /** Maximum allowed value */
  max?: number
  /** Step increment for number inputs */
  step?: number
  /** Decimal precision for number inputs */
  precision?: number
  // For select inputs
  /** Options for select inputs */
  data?: Array<{ value: string; label: string }>
  // For text/scientific inputs
  /** Placeholder text */
  placeholder?: string
  // Icon
  /** Icon to display in the input */
  icon?: React.ReactNode
  // Width
  /** Custom width for the input */
  width?: string | number
}

/**
 * @component WfesParameterInput
 * @brief Reusable parameter input component with multiple input types
 * 
 * This component automatically renders the appropriate input type based on
 * the `type` prop, handling scientific notation, tooltips, and validation.
 * Used throughout the application for consistent parameter entry.
 * 
 * @param props Component properties
 * @returns React component
 */
export const WfesParameterInput: React.FC<WfesParameterInputProps> = ({
  type = 'text',
  label,
  description,
  tooltip,
  helpText,
  value,
  onChange,
  error,
  required,
  disabled,
  min,
  max,
  step,
  precision,
  data,
  placeholder,
  icon,
  width
}) => {
  const labelWithTooltip = tooltip ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {label}
      <Tooltip label={tooltip} withArrow>
        <IconInfoCircle size={16} style={{ opacity: 0.6, cursor: 'help' }} />
      </Tooltip>
    </div>
  ) : label

  const commonProps = {
    label: labelWithTooltip,
    description,
    error,
    required,
    disabled,
    style: width ? { width } : undefined
  }

  // Helper function to wrap input with help text if provided
  const wrapWithHelpText = (input: React.ReactElement) => {
    if (helpText) {
      return (
        <div>
          {input}
          <Text size="xs" c="dimmed" mt={4}>
            {helpText}
          </Text>
        </div>
      )
    }
    return input
  }

  switch (type) {
    case 'number':
      return wrapWithHelpText(
        <NumberInput
          {...commonProps}
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          precision={precision}
          icon={icon}
        />
      )

    case 'checkbox':
      return wrapWithHelpText(
        <Checkbox
          label={label}
          description={description}
          checked={value}
          onChange={(e) => onChange(e.currentTarget.checked)}
          error={error}
          disabled={disabled}
        />
      )

    case 'select':
      return wrapWithHelpText(
        <Select
          {...commonProps}
          value={value}
          onChange={onChange}
          data={data || []}
          icon={icon}
        />
      )

    case 'scientific':
    case 'text':
    default:
      return wrapWithHelpText(
        <TextInput
          {...commonProps}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          placeholder={placeholder}
          icon={icon}
        />
      )
  }
}

// Helper function to validate scientific notation
export const validateScientificNotation = (value: string): boolean => {
  if (value === '' || value === '0') return true
  const scientificRegex = /^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/
  return scientificRegex.test(value)
}

// Helper function to validate positive integer
export const validatePositiveInteger = (value: string): boolean => {
  const num = parseInt(value)
  return !isNaN(num) && num > 0 && num.toString() === value.trim()
}

// Helper function to validate probability (0 <= p <= 1)
export const validateProbability = (value: string): boolean => {
  const num = parseFloat(value)
  return !isNaN(num) && num >= 0 && num <= 1
}

// Helper function to validate positive number
export const validatePositiveNumber = (value: string): boolean => {
  const num = parseFloat(value)
  return !isNaN(num) && num > 0
}

export default WfesParameterInput