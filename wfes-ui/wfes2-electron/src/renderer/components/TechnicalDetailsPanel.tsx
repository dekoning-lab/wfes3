import React, { useState } from 'react'
import {
  Paper,
  Collapse,
  Button,
  Stack,
  Title,
  Text,
  Divider,
  Box,
  Group,
  SegmentedControl
} from '@mantine/core'
import { IconChevronDown, IconChevronUp, IconInfoCircle } from '@tabler/icons-react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

interface TechnicalDetailsPanelProps {
  title?: string
  children: React.ReactNode
  sections?: {
    overview?: React.ReactNode
    model?: React.ReactNode
    computations?: React.ReactNode
  }
}

interface MathProps {
  children: string
  display?: boolean
}

// Component to render LaTeX equations
export const Math: React.FC<MathProps> = ({ children, display = false }) => {
  const html = katex.renderToString(children, {
    throwOnError: false,
    displayMode: display
  })

  return display ? (
    <div 
      dangerouslySetInnerHTML={{ __html: html }} 
      style={{ textAlign: 'center', margin: '1rem 0' }}
    />
  ) : (
    <span dangerouslySetInnerHTML={{ __html: html }} />
  )
}

const TechnicalDetailsPanel: React.FC<TechnicalDetailsPanelProps> = ({ 
  title = "About", 
  children,
  sections
}) => {
  const [opened, setOpened] = useState(false)
  const [activeSection, setActiveSection] = useState('overview')

  // If sections are provided, use the new layout
  const hasSections = sections && (sections.overview || sections.model || sections.computations)

  return (
    <Paper 
      withBorder 
      p="md" 
      mb="md"
      style={{ 
        backgroundColor: 'rgba(37, 99, 235, 0.1)', // Royal blue tint
        borderColor: 'rgba(37, 99, 235, 0.3)'
      }}
    >
      <Group justify="space-between">
        <Group gap="xs">
          <IconInfoCircle size={20} />
          <Title order={5}>{title}</Title>
        </Group>
        <Button
          variant="subtle"
          size="sm"
          onClick={() => setOpened(!opened)}
          rightSection={opened ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
        >
          {opened ? 'Hide' : 'Show'} Details
        </Button>
      </Group>
      
      <Collapse in={opened}>
        <Divider my="md" />
        {hasSections ? (
          <Stack gap="md">
            <SegmentedControl
              value={activeSection}
              onChange={setActiveSection}
              data={[
                { label: 'Overview', value: 'overview', disabled: !sections.overview },
                { label: 'Model', value: 'model', disabled: !sections.model },
                { label: 'Computations', value: 'computations', disabled: !sections.computations }
              ]}
              fullWidth
              size="sm"
              styles={{
                root: {
                  backgroundColor: 'rgba(37, 99, 235, 0.05)'
                }
              }}
            />
            <Box>
              {activeSection === 'overview' && sections.overview}
              {activeSection === 'model' && sections.model}
              {activeSection === 'computations' && sections.computations}
            </Box>
          </Stack>
        ) : (
          <Box>
            {children}
          </Box>
        )}
      </Collapse>
    </Paper>
  )
}

export default TechnicalDetailsPanel