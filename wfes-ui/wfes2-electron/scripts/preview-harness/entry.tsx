/**
 * Fixture entry for scripts/verify-previews.mjs: renders any of the REAL
 * views with react-dom/server and hands the runner (a) the produced markup,
 * from which the Command Line Preview text is read, and (b) the captured
 * Execute onClick closures and control inventory (see mantine-shim.tsx), so
 * the runner drives the view's own handleExecute and the real IPC handler.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'

import WfesSingleViewMantine2 from '../../src/renderer/views/WfesSingleViewMantine2'
import WfesSweepViewMantine from '../../src/renderer/views/WfesSweepViewMantine'
import WfesSequentialViewMantine from '../../src/renderer/views/WfesSequentialViewMantine'
import WfesSwitchingViewMantine from '../../src/renderer/views/WfesSwitchingViewMantine'
import WfafsViewMantine from '../../src/renderer/views/WfafsViewMantine'
import WfafdViewMantine from '../../src/renderer/views/WfafdViewMantine'
import TimeDistViewMantine from '../../src/renderer/views/TimeDistViewMantine'
import PhaseTypeViewMantine from '../../src/renderer/views/PhaseTypeViewMantine'
import PopulationProjectionView from '../../src/renderer/views/PopulationProjectionView'

const VIEWS: Record<string, React.ComponentType<any>> = {
  single: WfesSingleViewMantine2,
  sweep: WfesSweepViewMantine,
  sequential: WfesSequentialViewMantine,
  switching: WfesSwitchingViewMantine,
  wfafs: WfafsViewMantine,
  wfafd: WfafdViewMantine,
  timedist: TimeDistViewMantine,
  phasetype: PhaseTypeViewMantine,
  projection: PopulationProjectionView
}

export function render(viewKey: string, props: Record<string, unknown> = {}): string {
  const View = VIEWS[viewKey]
  if (!View) throw new Error(`unknown view key: ${viewKey}`)
  ;(globalThis as any).__buttons = []
  ;(globalThis as any).__controls = []
  return renderToStaticMarkup(
    React.createElement(
      MantineProvider,
      null,
      React.createElement(View, { onBack: () => {}, hideBackButton: true, ...props })
    )
  )
}
