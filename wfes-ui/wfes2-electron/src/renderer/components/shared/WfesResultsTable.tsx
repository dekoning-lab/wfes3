/**
 * @file WfesResultsTable.tsx
 * @brief Shared label/value results table, one- or two-column.
 *
 * Rewritten on the Mantine v8 Table.* sub-component API. The previous version
 * used raw thead/td children plus a v7-era `sx` prop, so striping, borders and
 * cell padding were browser defaults rather than anything Mantine applied --
 * the same defect fixed in the per-state/per-epoch breakdown tables, applied
 * here so every results table renders identically.
 */
import React from 'react'
import { Table, Text } from '@mantine/core'
import { WfesResultItem } from '../../types/wfes'

interface WfesResultsTableProps {
  data: WfesResultItem[]
  columns?: 1 | 2
}

/**
 * Label cell with its description underneath, shown in full.
 *
 * These descriptions are deliberately not truncated. The CLI already computes
 * everything this application does; what the GUI adds is telling the user what
 * each of the many outputs actually is. Clamping that to two lines and a
 * tooltip removes the reason to use the GUI at all, so the text stays visible
 * and is kept short at the source instead.
 */
const LabelCell: React.FC<{ item: WfesResultItem; width: string }> = ({ item, width }) => (
  <Table.Td style={{ fontWeight: 500, width, verticalAlign: 'top' }}>
    <div>{item.label}</div>
    {item.description && (
      <Text size="xs" c="dimmed" style={{ fontWeight: 400, lineHeight: 1.45 }}>
        {item.description}
      </Text>
    )}
  </Table.Td>
)

/**
 * Values are the output of a solver, so they get the typographic care: tabular
 * figures (from tokens.css) and right alignment, which puts the digits of a
 * column over each other instead of letting them drift with string length.
 */
const ValueCell: React.FC<{ value: React.ReactNode; width: string }> = ({ value, width }) => (
  <Table.Td style={{
    fontFamily: 'ui-monospace, monospace',
    width,
    verticalAlign: 'top',
    whiteSpace: 'nowrap',
    textAlign: 'right',
    paddingRight: 'var(--mantine-spacing-md)'
  }}>
    {value}
  </Table.Td>
)

export const WfesResultsTable: React.FC<WfesResultsTableProps> = ({
  data,
  columns = 2
}) => {
  if (columns === 1) {
    return (
      <div style={{ overflowX: 'auto' }}>
      <Table size="sm" striped className="results-table">
        <Table.Tbody>
          {data.map((item, index) => (
            <Table.Tr key={index}>
              <LabelCell item={item} width="55%" />
              <ValueCell value={item.value} width="45%" />
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      </div>
    )
  }

  // Two-column layout, filled left-to-right: consecutive items share a row.
  //
  // This used to split the list at its midpoint and run down the columns, which
  // separated every quantity from its own standard deviation -- T_ext in the
  // left column, SD[T_ext] four rows up on the right. Pairing adjacent items
  // instead means the views control what sits together simply by ordering.
  const rows: (WfesResultItem | undefined)[][] = []
  for (let i = 0; i < data.length; i += 2) rows.push([data[i], data[i + 1]])

  // overflow-x: values render nowrap in a monospace face, and a long number in
  // a narrow panel (the sweep view) spilled past the Paper border. The table
  // scrolls inside its panel instead.
  return (
    <div style={{ overflowX: 'auto' }}>
    <Table size="sm" striped className="results-table">
      <Table.Tbody>
        {rows.map(([left, right], index) => (
          <Table.Tr key={index}>
            <LabelCell item={left!} width="35%" />
            <ValueCell value={left!.value} width="15%" />
            {right ? (
              <>
                <LabelCell item={right} width="35%" />
                <ValueCell value={right.value} width="15%" />
              </>
            ) : (
              <>
                <Table.Td></Table.Td>
                <Table.Td></Table.Td>
              </>
            )}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
    </div>
  )
}

export default WfesResultsTable
