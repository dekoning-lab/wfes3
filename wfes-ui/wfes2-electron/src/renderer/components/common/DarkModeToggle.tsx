import React from 'react'
import { ActionIcon, useMantineColorScheme, Tooltip } from '@mantine/core'

export const DarkModeToggle: React.FC = () => {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  
  return (
    <Tooltip label={`Switch to ${colorScheme === 'dark' ? 'light' : 'dark'} mode`}>
      <ActionIcon
        onClick={() => toggleColorScheme()}
        size="lg"
        variant="default"
        radius="md"
        aria-label="Toggle color scheme"
        className="fixed top-4 right-4 z-50"
      >
        {colorScheme === 'dark' ? '☀️' : '🌙'}
      </ActionIcon>
    </Tooltip>
  )
}