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

// The window title is the one place the running version is visible without
// opening a menu, and it matters now that exported figures carry a version
// stamp: a reader comparing a figure to a session needs to see which build
// made it. Set here rather than in BrowserWindow's `title` option, which the
// page's own <title> overrides on load.
document.title = `WFES3 v${__APP_VERSION__} — Wright-Fisher Exact Solver`

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