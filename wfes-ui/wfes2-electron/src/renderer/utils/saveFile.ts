/**
 * @file saveFile.ts
 * @brief One way to put a file on disk, that actually works here.
 *
 * The app's exports all used the browser idiom: build a Blob, point an
 * <a download> at it, click it. In this Electron build that silently does
 * nothing -- verified with a minimal in-page test of all three cleanup
 * orderings (append then remove, click without appending, deferred revoke):
 * none produced a file, so it is the download Electron drops rather than the
 * cleanup timing. No error surfaced in the renderer either way, which is
 * exactly why the button appeared inert.
 *
 * So the bytes go to the main process, which writes them after a save dialog.
 * The anchor remains only as a fallback for a non-Electron context.
 */

export interface SaveResult {
  saved: boolean
  path: string | null
}

export async function saveTextFile(
  content: string,
  defaultFileName: string,
  directory?: string
): Promise<SaveResult> {
  const api = (window as any).api?.dialog
  if (api?.saveFile) {
    try {
      const result = await api.saveFile({ content, defaultFileName, directory, encoding: 'utf8' })
      return { saved: !!result?.saved, path: result?.path ?? null }
    } catch (error) {
      console.error('saveTextFile: main-process save failed', error)
    }
  }

  // Fallback: the browser idiom, for a context where it works.
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = defaultFileName
  document.body.appendChild(link)
  link.click()
  // Deferred: revoking or detaching synchronously can cancel a download that
  // has not started fetching yet.
  setTimeout(() => {
    link.remove()
    URL.revokeObjectURL(url)
  }, 10_000)
  return { saved: true, path: null }
}

/**
 * Same route for binary payloads (a canvas PNG, say): the bytes go over as
 * base64 and the main process writes them as a Buffer. Writing these through
 * saveTextFile would corrupt them.
 */
export async function saveBlobFile(
  blob: Blob,
  defaultFileName: string,
  directory?: string
): Promise<SaveResult> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // Chunked: String.fromCharCode(...buf) blows the argument limit on a
  // full-size image.
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  }
  const api = (window as any).api?.dialog
  if (api?.saveFile) {
    try {
      const result = await api.saveFile({
        content: btoa(binary), defaultFileName, directory, encoding: 'base64'
      })
      return { saved: !!result?.saved, path: result?.path ?? null }
    } catch (error) {
      console.error('saveBlobFile: main-process save failed', error)
    }
  }
  return { saved: false, path: null }
}
