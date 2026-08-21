import React from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider, createTheme } from '@mantine/core'
import App from './App'
import '@mantine/core/styles.css'
import './styles/tokens.css'
import './styles/index.css'
import './styles/native.css'
import './styles/mantine-nav.css'
import './styles/resizable-nav.css'

const theme = createTheme({
  components: {
    TextInput: {
      styles: (theme) => ({
        input: {
          '&:disabled': {
            opacity: 0.3,
            cursor: 'not-allowed'
          }
        },
        label: {
          '&[data-disabled]': {
            opacity: 0.5
          }
        },
        description: {
          '&[data-disabled]': {
            opacity: 0.5
          }
        }
      })
    },
    NumberInput: {
      styles: (theme) => ({
        input: {
          '&:disabled': {
            opacity: 0.3,
            cursor: 'not-allowed'
          }
        },
        label: {
          '&[data-disabled]': {
            opacity: 0.5
          }
        },
        description: {
          '&[data-disabled]': {
            opacity: 0.5
          }
        }
      })
    },
    Select: {
      styles: (theme) => ({
        input: {
          '&:disabled': {
            opacity: 0.3,
            cursor: 'not-allowed'
          }
        },
        label: {
          '&[data-disabled]': {
            opacity: 0.5
          }
        },
        description: {
          '&[data-disabled]': {
            opacity: 0.5
          }
        }
      })
    },
    Checkbox: {
      styles: (theme) => ({
        input: {
          '&:disabled': {
            opacity: 0.25,
            cursor: 'not-allowed'
          }
        },
        label: {
          '&[data-disabled]': {
            opacity: 0.5
          }
        }
      })
    }
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
      <App />
    </MantineProvider>
  </React.StrictMode>
)