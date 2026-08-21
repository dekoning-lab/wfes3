/**
 * @file resultsCopy.ts
 * @brief One formatter for every view's "Copy results" button.
 *
 * Before this, all five switching-family views shared the same three-line
 * handler that serialized only the flat headline list -- so the per-state /
 * per-epoch breakdowns visible on screen were silently missing from the copy.
 *
 * Output is tab-separated: it pastes into a spreadsheet as a grid, into R via
 * read.delim, and stays readable as plain text. Matrix sections carry their
 * own header row of state/epoch names.
 */

export interface CopyItem {
  /** May be a node (subscripted symbol); `plain` carries the ASCII form. */
  label?: unknown
  plain?: string
  value: string | number
  /** Unrounded value, preferred over `value` so the copy keeps precision. */
  raw?: number | string
  description?: string
}

export interface CopyMatrix {
  title: string
  /** Column headers after the leading "Quantity" column. */
  columns: string[]
  rows: { label?: unknown; plain?: string; values: (string | number)[] }[]
  /** Optional caveat lines appended under the matrix. */
  notes?: string[]
}

export function formatResultsCopy(
  title: string,
  items: CopyItem[],
  matrices: CopyMatrix[] = []
): string {
  // The label may be a React node (a subscripted symbol), which would
  // serialize as "[object Object]"; `plain` is the ASCII form of the same name.
  const name = (x: { label?: unknown; plain?: string }): string =>
    x.plain ?? (typeof x.label === 'string' ? x.label : '?')

  const lines: string[] = [title, '']
  for (const it of items) {
    // Copy carries the unrounded value: the table rounds to six significant
    // digits for legibility, the clipboard should not lose the rest.
    lines.push(`${name(it)}\t${it.raw ?? it.value}`)
  }
  for (const m of matrices) {
    if (m.rows.length === 0) continue
    lines.push('', m.title, ['Quantity', ...m.columns].join('\t'))
    for (const r of m.rows) {
      lines.push([name(r), ...r.values].join('\t'))
    }
    for (const n of m.notes ?? []) {
      lines.push(`# ${n}`)
    }
  }
  return lines.join('\n')
}
