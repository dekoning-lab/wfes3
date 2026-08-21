/**
 * @file AboutContentPanel.tsx
 * @brief Component that loads and displays About content from markdown files
 * 
 * This component replaces hardcoded technical details with content loaded
 * from the about folder, making documentation easier to maintain.
 */

import React, { useState, useEffect } from 'react'
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
  SegmentedControl,
  Loader,
  Alert
} from '@mantine/core'
import { IconChevronDown, IconChevronUp, IconInfoCircle } from '@tabler/icons-react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

/**
 * @interface AboutContentPanelProps
 * @brief Props for the AboutContentPanel component
 */
interface AboutContentPanelProps {
  modelName: string
  title?: string
  defaultOpen?: boolean
}

/**
 * @interface AboutContent
 * @brief Structure for About content sections
 */
interface AboutContent {
  /** Document H1, supplied separately by the main process so it is never
   *  re-prefixed as a section header. See aboutContentService.parseMarkdown. */
  title?: string
  description: string
  overview: string
  model: string
  computations: string
  fullContent: string
}

/**
 * @component AboutContentPanel
 * @brief Displays About content loaded from markdown files with LaTeX support
 */
const AboutContentPanel: React.FC<AboutContentPanelProps> = ({ 
  modelName, 
  title = "About",
  defaultOpen = false
}) => {
  const [opened, setOpened] = useState(defaultOpen)
  const [activeSection, setActiveSection] = useState('overview')
  const [content, setContent] = useState<AboutContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * @brief Load content when component mounts or modelName changes
   */
  useEffect(() => {
    const loadContent = async () => {
      setLoading(true)
      setError(null)
      
      try {
        console.log(`AboutContentPanel: Loading content for ${modelName}`)
        const loadedContent = await window.api.about.loadContent(modelName)
        console.log('AboutContentPanel: Loaded content:', loadedContent)
        setContent(loadedContent)
      } catch (err) {
        console.error('AboutContentPanel: Failed to load about content:', err)
        const errorMsg = err instanceof Error ? err.message : String(err)
        setError(errorMsg)
        // Show what we actually got back
        if (err && typeof err === 'object' && 'description' in err) {
          // If we got content back but with an error message
          setContent(err as AboutContent)
        } else {
          // Fallback to default content
          setContent({
            description: `Error loading ${modelName}: ${errorMsg}`,
            overview: `Documentation for ${modelName} could not be loaded.\n\nError: ${errorMsg}`,
            model: 'Mathematical model documentation unavailable',
            computations: 'Computational details unavailable',
            fullContent: ''
          })
        }
      } finally {
        setLoading(false)
      }
    }

    loadContent()
  }, [modelName])

  /**
   * @brief Render markdown with LaTeX support
   */
  const renderMarkdownWithMath = (text: string) => {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // Custom rendering for different elements.
          // h1 and h2 were missing here, so they fell back to raw browser
          // defaults while h3/h4 used Mantine Titles -- headings in the same
          // panel were styled by two different systems.
          h1: ({ children }) => (
            <Title order={2} mt="md" mb="sm">{children}</Title>
          ),
          h2: ({ children }) => (
            <Title order={3} mt="md" mb="xs">{children}</Title>
          ),
          h3: ({ children }) => (
            <Title order={4} mt="md" mb="xs">{children}</Title>
          ),
          h4: ({ children }) => (
            <Title order={5} mt="sm" mb="xs">{children}</Title>
          ),
          p: ({ children }) => (
            <Text size="sm" mb="sm">{children}</Text>
          ),
          ul: ({ children }) => (
            <Box component="ul" style={{ paddingLeft: '1.5rem' }} mb="sm">
              {children}
            </Box>
          ),
          li: ({ children }) => (
            <Text component="li" size="sm" mb={4}>{children}</Text>
          ),
          code: ({ inline, className, children }) => {
            // Handle code blocks vs inline code
            if (!inline && className?.includes('language-')) {
              return (
                <Box
                  component="pre"
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.05)',
                    padding: '0.5rem',
                    borderRadius: '4px',
                    overflowX: 'auto',
                    marginBottom: '1rem'
                  }}
                >
                  <code>{children}</code>
                </Box>
              )
            }
            return <code style={{ backgroundColor: 'rgba(0, 0, 0, 0.05)', padding: '0.1rem 0.3rem', borderRadius: '3px' }}>{children}</code>
          }
        }}
      >
        {text}
      </ReactMarkdown>
    )
  }

  const hasSections = content && (content.overview || content.model || content.computations)

  return (
    <Paper
      withBorder
      px="md"
      py={opened ? 'md' : 'xs'}
      mb="md"
      style={{
        // The tint stays -- it marks this as reference rather than controls --
        // but at 0.02 alpha it was invisible, so the panel read as an empty box
        // rather than as a distinct kind of surface.
        backgroundColor: 'var(--wfes-accent-quiet)',
        borderColor: 'rgba(34, 139, 230, 0.28)'
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
        
        {loading ? (
          <Stack align="center" p="xl">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">Loading documentation...</Text>
          </Stack>
        ) : error ? (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        ) : hasSections ? (
          <Stack gap="md">
            {content?.title && (
              <Title order={2} mb={0}>{content.title}</Title>
            )}
            {/* The introduction sits above the tabs, not inside one. Every
                About file routes its non-Model, non-Notes headings into
                `overview`, so `overview` is never empty and the parser's
                `overview || description` fallback never fired: the ## Description
                section -- the paragraphs introducing the tool -- was parsed,
                sent over IPC, and then rendered nowhere. It is also the one part
                that holds whichever tab is open, which is what an introduction
                is for. */}
            {content?.description && (
              <Box>{renderMarkdownWithMath(content.description)}</Box>
            )}
            <SegmentedControl
              value={activeSection}
              onChange={setActiveSection}
              data={[
                { label: 'Overview', value: 'overview', disabled: !content?.overview },
                { label: 'Model', value: 'model', disabled: !content?.model },
                { label: 'Computations', value: 'computations', disabled: !content?.computations }
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
              {activeSection === 'overview' && content?.overview && renderMarkdownWithMath(content.overview)}
              {activeSection === 'model' && content?.model && renderMarkdownWithMath(content.model)}
              {activeSection === 'computations' && content?.computations && renderMarkdownWithMath(content.computations)}
            </Box>
          </Stack>
        ) : (
          <Box>
            {content?.description && renderMarkdownWithMath(content.description)}
          </Box>
        )}
      </Collapse>
    </Paper>
  )
}

export default AboutContentPanel