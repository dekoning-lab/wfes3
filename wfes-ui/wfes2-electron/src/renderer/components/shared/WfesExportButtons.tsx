import React from 'react'
import { saveTextFile } from '../../utils/saveFile'
import { Group, Button, Menu } from '@mantine/core'
import { IconDownload, IconFileTypePng, IconFileTypeSvg, IconFileTypeCsv, IconJson } from '@tabler/icons-react'
import { ExportFormat } from '../../types/wfes'

interface WfesExportButtonsProps {
  onExport: (format: ExportFormat) => void
  formats?: ExportFormat[]
  disabled?: boolean
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  variant?: 'filled' | 'light' | 'outline' | 'subtle' | 'default'
  compact?: boolean
}

const formatIcons: Record<ExportFormat, React.ReactNode> = {
  png: <IconFileTypePng size={16} />,
  svg: <IconFileTypeSvg size={16} />,
  csv: <IconFileTypeCsv size={16} />,
  json: <IconJson size={16} />
}

const formatLabels: Record<ExportFormat, string> = {
  png: 'Export PNG',
  svg: 'Export SVG',
  csv: 'Export CSV',
  json: 'Export JSON'
}

export const WfesExportButtons: React.FC<WfesExportButtonsProps> = ({
  onExport,
  formats = ['png', 'svg', 'csv'],
  disabled = false,
  size = 'sm',
  variant = 'light',
  compact = false
}) => {
  if (compact || formats.length === 1) {
    // Single button mode
    const format = formats[0]
    return (
      <Button
        leftSection={formatIcons[format]}
        size={size}
        variant={variant}
        onClick={() => onExport(format)}
        disabled={disabled}
      >
        {compact ? 'Export' : formatLabels[format]}
      </Button>
    )
  }

  if (formats.length === 2 || formats.length === 3) {
    // Show individual buttons
    return (
      <Group gap="xs">
        {formats.map(format => (
          <Button
            key={format}
            leftSection={formatIcons[format]}
            size={size}
            variant={variant}
            onClick={() => onExport(format)}
            disabled={disabled}
          >
            {formatLabels[format]}
          </Button>
        ))}
      </Group>
    )
  }

  // Dropdown menu for many formats
  return (
    <Menu shadow="md" width={200}>
      <Menu.Target>
        <Button
          leftSection={<IconDownload size={16} />}
          size={size}
          variant={variant}
          disabled={disabled}
        >
          Export
        </Button>
      </Menu.Target>

      <Menu.Dropdown>
        {formats.map(format => (
          <Menu.Item
            key={format}
            icon={formatIcons[format]}
            onClick={() => onExport(format)}
          >
            {formatLabels[format]}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}

// Helper function to export data as CSV
export const exportToCSV = (data: any[][], filename: string) => {
  const csvContent = data.map(row => row.join(',')).join('\n')
  // Through the main process: an <a download> is silently dropped here.
  void saveTextFile(csvContent, filename)
}

// Helper function to export data as JSON
export const exportToJSON = (data: any, filename: string) => {
  const jsonContent = JSON.stringify(data, null, 2)
  // Through the main process: an <a download> is silently dropped here.
  void saveTextFile(jsonContent, filename)
}

// Helper function to generate filename with timestamp
export const generateFilename = (prefix: string, extension: string): string => {
  const timestamp = new Date().toISOString().slice(0, 10)
  return `${prefix}_${timestamp}.${extension}`
}

export default WfesExportButtons