/**
 * Stand-in for '@mantine/core' used only inside the verify-previews fixture
 * bundle (see scripts/verify-previews.mjs). Everything is re-exported from
 * the real package unchanged, except:
 *
 *  - Button records {label, onClick} into globalThis.__buttons, so the
 *    harness can invoke the view's own handleExecute closure -- the real
 *    parameter-building code -- rather than a transcription of it.
 *  - Checkbox / Switch / Select / SegmentedControl record their label and
 *    disabled state into globalThis.__controls, so the harness can verify a
 *    control is either wired (its probe changes the argv) or visibly
 *    disabled with a reason.
 *  - Drawer renders its children unconditionally in a plain <div>. The
 *    options drawer is mounted closed in every view, and the real Drawer
 *    renders nothing while closed (and portals when open, which
 *    react-dom/server cannot do) -- flattening it puts the drawer's
 *    checkboxes into the static markup where the harness can see them.
 *
 * The technique is from the T4 fixture (scratchpad/T4/mantine-shim.tsx),
 * promoted into the repo so the check runs permanently.
 */
import React from 'react'
// Relative, not '@mantine/core/...': the fixture bundles with an alias that
// remaps every @mantine/core specifier to THIS file, so the real package has
// to be named by a path the alias cannot touch.
import * as Real from '../../node_modules/@mantine/core/esm/index.mjs'

export * from '../../node_modules/@mantine/core/esm/index.mjs'

const flatten = (node: any): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  if (node.props) return flatten(node.props.children)
  return ''
}

const record = (kind: string, props: any) => {
  const g: any = globalThis as any
  g.__controls = g.__controls || []
  g.__controls.push({
    kind,
    label: flatten(props.label ?? props.title ?? ''),
    description: flatten(props.description ?? ''),
    checked: props.checked,
    value: props.value,
    disabled: !!props.disabled,
    onChange: props.onChange
  })
}

export const Button: any = (props: any) => {
  const g: any = globalThis as any
  g.__buttons = g.__buttons || []
  if (typeof props.onClick === 'function') {
    g.__buttons.push({ label: flatten(props.children), onClick: props.onClick })
  }
  return React.createElement((Real as any).Button, props)
}

export const Checkbox: any = (props: any) => {
  record('checkbox', props)
  return React.createElement((Real as any).Checkbox, props)
}

export const Switch: any = (props: any) => {
  record('switch', props)
  return React.createElement((Real as any).Switch, props)
}

export const Select: any = (props: any) => {
  record('select', props)
  return React.createElement((Real as any).Select, props)
}

export const SegmentedControl: any = (props: any) => {
  record('segmented', props)
  return React.createElement((Real as any).SegmentedControl, props)
}

export const Drawer: any = (props: any) =>
  React.createElement('div', { 'data-harness': 'drawer' }, props.children)
