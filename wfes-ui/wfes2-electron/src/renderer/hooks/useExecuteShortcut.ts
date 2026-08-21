import { useEffect } from 'react'

/**
 * Fire a view's Execute / Re-execute action on Cmd+Enter (Ctrl+Enter off macOS).
 *
 * Bound on `window` rather than on the button, deliberately: the point of the
 * shortcut is to run without leaving the parameter field you are typing in, so
 * the handler has to see the event while an input holds focus.
 *
 * @param onExecute the same callback the Execute button calls
 * @param disabled  suppress while a run is already in flight, so holding the
 *                  keys cannot queue a second process
 */
export function useExecuteShortcut(onExecute: () => void, disabled = false): void {
  useEffect(() => {
    if (disabled) return

    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return
      if (!e.metaKey && !e.ctrlKey) return
      // Mid-composition Enter commits an IME candidate; it is not a command.
      if (e.isComposing) return
      e.preventDefault()
      onExecute()
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onExecute, disabled])
}
