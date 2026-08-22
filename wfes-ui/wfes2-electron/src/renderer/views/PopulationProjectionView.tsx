/**
 * @file PopulationProjectionView.tsx
 * @brief Project an allele-frequency distribution from one population size into
 *        another, in one Wright-Fisher generation.
 *
 * The other views answer questions about a process. This one is a utility: it
 * produces a distribution in a new state space, in the format the rest of WFES3
 * reads back through --initial. A user who wants to ask "what does a bottleneck
 * do to this distribution, and then what happens next?" previously had to build
 * that file by hand.
 *
 * The computation is a single rectangular block. WF::Single(N1, N2,
 * NON_ABSORBING) has rows binom_row(2*N2, psi_diploid(i, N1, s, h, u, v)): from
 * state i in a population of size N1, one generation of Wright-Fisher sampling
 * into 2*N2 draws. wfes-lib already builds this for the switching models, where
 * it carries a distribution across a size change between regimes.
 *
 * The backend reaches it through wfafs_deterministic with two zero-length
 * epochs, so the block between them is the only thing applied. See
 * buildProjectionArgs in wfesBackendService.
 */
import React, { useMemo, useState } from 'react'
import {
  Container, Grid, Paper, Title, Text, Group, Stack, Button, NumberInput,
  TextInput, Checkbox, Divider, Alert, Loader, ScrollArea, Table, Box, ActionIcon,
  Tooltip, SegmentedControl
} from '@mantine/core'
import {
  IconArrowLeft, IconPlayerPlay, IconCopy, IconDownload, IconArrowRight,
  IconAlertCircle
} from '@tabler/icons-react'
import InitialStateSelector, { InitialMode } from '../components/shared/InitialStateSelector'
import { AboutContentPanel, SolverWarnings } from '../components/shared'
import { saveTextFile } from '../utils/saveFile'
import { formatQuantity } from '../utils/quantityLabels'
import { intOrUndefined } from '../utils/numeric'

interface PopulationProjectionViewProps {
  onBack: () => void
  hideBackButton?: boolean
}

interface Point { count: number; probability: number }

/**
 * The tools do not share one state space, so there is no single "WFES3 initial
 * distribution" shape to write. Measured against the CLIs at N=5:
 *
 *   counts 0..2N    (2N+1)  wfafs_deterministic, wfafs_stochastic
 *   counts 1..2N-1  (2N-1)  wfes_single, time_dist
 *   counts 0..2N-1  (2N)    phase_type_dist
 *
 * Writing the full vector for all of them would produce a file two of the three
 * reject on length, so the format is chosen here and each option names the
 * views that read it.
 */
type ExportFormat = 'full' | 'interior' | 'noFixed'

const FORMATS: { value: ExportFormat; label: string; consumers: string; span: (n: number) => string }[] = [
  { value: 'full',     label: '0..2N',   consumers: 'Stochastic and Deterministic Switching',
    span: n => `${2 * n + 1} values` },
  { value: 'interior', label: '1..2N-1', consumers: 'Time-Homogeneous WFES, Time to Extinction and Fixation',
    span: n => `${2 * n - 1} values` },
  { value: 'noFixed',  label: '0..2N-1', consumers: 'Time to Substitution',
    span: n => `${2 * n} values` }
]

const PopulationProjectionView: React.FC<PopulationProjectionViewProps> = ({
  onBack, hideBackButton = false
}) => {
  const [sourceSize, setSourceSize] = useState('100')
  const [targetSize, setTargetSize] = useState('200')
  const [selection, setSelection] = useState('0')
  const [dominance, setDominance] = useState('0.5')
  const [backwardMutation, setBackwardMutation] = useState('1e-9')
  const [forwardMutation, setForwardMutation] = useState('1e-9')
  const [populationScaled, setPopulationScaled] = useState(false)
  const [alpha, setAlpha] = useState('1e-20')

  const [initialMode, setInitialMode] = useState<InitialMode>('fixed')
  const [startingCopies, setStartingCopies] = useState('1')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  const [initialFile, setInitialFile] = useState('')

  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Whatever the solver wrote to stderr while still exiting 0. The service
  // call has always returned these; this view was the one of the nine that
  // never showed them, so a projection the solver had qualified was presented
  // as final.
  const [warnings, setWarnings] = useState<string[]>([])
  const [dist, setDist] = useState<Point[] | null>(null)
  const [ranWith, setRanWith] = useState<{ N1: number; N2: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const [exportFormat, setExportFormat] = useState<ExportFormat>('full')

  const N1 = parseInt(sourceSize) || 0
  const N2 = parseInt(targetSize) || 0
  const sourceStates = N1 > 0 ? 2 * N1 + 1 : 0
  const targetStates = N2 > 0 ? 2 * N2 + 1 : 0

  // A starting count must be an interior state of the SOURCE space: 0 is the
  // allele being absent and 2N its being fixed, and neither is a distribution
  // anyone wants to project.
  const countError = useMemo(() => {
    if (initialMode !== 'fixed') return null
    const p = parseInt(startingCopies)
    if (!Number.isFinite(p)) return 'Enter a starting count.'
    if (p <= 0 || p >= 2 * N1) return `Starting count must be between 1 and ${2 * N1 - 1} for N = ${N1}.`
    return null
  }, [initialMode, startingCopies, N1])

  const sizeError = useMemo(() => {
    if (N1 <= 0 || N2 <= 0) return 'Both population sizes must be positive.'
    return null
  }, [N1, N2])

  const fileError = initialMode === 'file' && !initialFile
    ? 'Choose a distribution file, or switch to another starting mode.'
    : null

  const blocked = countError || sizeError || fileError

  const params = () => ({
    sourceSize: N1,
    targetSize: N2,
    initialMode,
    startingCopies,
    integrationCutoff,
    initial: initialMode === 'file' ? initialFile : undefined,
    selection, dominance, backwardMutation, forwardMutation,
    populationScaled, alpha
  })

  // Mirrors buildProjectionArgs. verify:previews holds the two together.
  const preview = useMemo(() => {
    const s = parseFloat(selection) || 0
    const u = parseFloat(backwardMutation) || 0
    const v = parseFloat(forwardMutation) || 0
    const h = parseFloat(dominance)
    const sr = populationScaled ? s / (2 * N1) : s
    const ur = populationScaled ? u / (4 * N1) : u
    const vr = populationScaled ? v / (4 * N1) : v
    const parts = ['wfafs_deterministic']
    if (initialMode === 'file' && initialFile) parts.push(`--initial ${initialFile}`)
    else if (initialMode === 'integrate') parts.push(`-c ${integrationCutoff}`)
    else {
      // Omit -p when blank rather than silently substituting 1: countError
      // above already tells the user to enter a count (a red border, not a
      // gate -- this view still lets the harness call Execute directly), but
      // the run and this preview must at least agree on what "blank" means
      // instead of both quietly claiming p=1.
      const p = intOrUndefined(startingCopies)
      if (p !== undefined) parts.push(`-p ${p}`)
    }
    parts.push(`--pop-sizes ${N1},${N2}`)
    parts.push('--generations 0,0')
    parts.push(`--selection ${sr},${sr}`)
    parts.push(`--dominance ${Number.isFinite(h) ? h : 0.5},${Number.isFinite(h) ? h : 0.5}`)
    parts.push(`--backward-mu ${ur},${ur}`)
    parts.push(`--forward-mu ${vr},${vr}`)
    if (alpha !== '') parts.push(`--alpha ${alpha}`)
    parts.push('--json')
    return parts.join(' ')
  }, [N1, N2, selection, dominance, backwardMutation, forwardMutation, populationScaled,
      alpha, initialMode, startingCopies, integrationCutoff, initialFile])

  const run = async () => {
    setRunning(true); setError(null); setDist(null); setCopied(false); setWarnings([])
    try {
      const res = await (window as any).api.wfes.projection.execute(params())
      if (!res?.success) {
        setError(res?.error || 'The projection failed.')
      } else {
        setWarnings(res.warnings || [])
        const raw = res.distribution || []
        const points: Point[] = raw.map((d: any, i: number) => ({
          count: d.count ?? d.state ?? i,
          probability: d.probability ?? d.value ?? 0
        }))
        setDist(points)
        setRanWith({ N1, N2 })
      }
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setRunning(false)
    }
  }

  /**
   * One probability per line, in state order, with no header and no index
   * column -- the format load_initial_distribution reads. Anything else here
   * produces a file that the --initial flag rejects, which would make this
   * whole view pointless.
   *
   * Trimming to a smaller state space drops mass at the boundaries, so the
   * remainder is renormalised and the amount dropped is reported on screen
   * rather than disappearing quietly.
   */
  const exported = useMemo(() => {
    if (!dist || dist.length === 0) return { values: [] as number[], dropped: 0 }
    const last = dist.length - 1
    const slice =
      exportFormat === 'interior' ? dist.slice(1, last)
        : exportFormat === 'noFixed' ? dist.slice(0, last)
        : dist
    const kept = slice.reduce((a, d) => a + d.probability, 0)
    const total = dist.reduce((a, d) => a + d.probability, 0)
    const values = kept > 0 ? slice.map(d => d.probability / kept) : slice.map(() => 0)
    return { values, dropped: total > 0 ? (total - kept) / total : 0 }
  }, [dist, exportFormat])

  const asInitialFile = () => exported.values.join('\n') + '\n'

  const copy = async () => {
    await navigator.clipboard.writeText(asInitialFile())
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const save = async () => {
    await saveTextFile(
      asInitialFile(),
      `projection_N${ranWith?.N1}_to_N${ranWith?.N2}_${exportFormat}.csv`
    )
  }

  const summary = useMemo(() => {
    if (!dist || dist.length === 0) return null
    const total = dist.reduce((a, d) => a + d.probability, 0)
    const maxCount = dist[dist.length - 1].count
    const mean = dist.reduce((a, d) => a + d.count * d.probability, 0)
    return {
      total,
      states: dist.length,
      lost: dist[0]?.probability ?? 0,
      fixed: dist[dist.length - 1]?.probability ?? 0,
      meanCount: mean,
      meanFreq: maxCount > 0 ? mean / maxCount : 0
    }
  }, [dist])

  return (
    <div className={`flex flex-col h-full ${!hideBackButton ? 'native-window' : ''}`}>
      <div className="native-header flex items-center px-4" style={{ minHeight: 44 }}>
        {!hideBackButton && (
          <ActionIcon onClick={onBack} variant="subtle" size="lg" mr="sm">
            <IconArrowLeft size={20} />
          </ActionIcon>
        )}
        <Title order={4}>Population Projection</Title>
      </div>

      <Container fluid p="md" style={{ flex: 1, overflow: 'auto' }}>
        <AboutContentPanel modelName="population_projection" />

        <Grid>
          <Grid.Col span={6}>
            <Stack>
              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Population sizes</Title>
                <Group grow align="flex-start">
                  <NumberInput
                    label="From (N)"
                    description={sourceStates ? `${sourceStates.toLocaleString()} states` : undefined}
                    value={sourceSize}
                    onChange={(v) => setSourceSize(String(v))}
                    min={1}
                    allowDecimal={false}
                  />
                  <Box style={{ flex: '0 0 28px', paddingTop: 30, textAlign: 'center' }}>
                    <IconArrowRight size={18} style={{ opacity: 0.6 }} />
                  </Box>
                  <NumberInput
                    label="To (N)"
                    description={targetStates ? `${targetStates.toLocaleString()} states` : undefined}
                    value={targetSize}
                    onChange={(v) => setTargetSize(String(v))}
                    min={1}
                    allowDecimal={false}
                  />
                </Group>
                {sizeError && <Text size="xs" c="red" mt="xs">{sizeError}</Text>}
                <Text size="xs" c="dimmed" mt="sm">
                  One Wright-Fisher generation carries the distribution from the
                  first size into the second. Selection, dominance and mutation
                  act during that generation.
                </Text>
              </Paper>

              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Starting distribution</Title>
                <InitialStateSelector
                  modes={['fixed', 'integrate', 'file']}
                  value={initialMode}
                  onChange={setInitialMode}
                  file={initialFile}
                  onFileChange={setInitialFile}
                  expectedLength={sourceStates}
                  stateSpace={`allele counts 0..${2 * N1} in the starting population`}
                />
                {initialMode === 'fixed' && (
                  <NumberInput
                    mt="sm"
                    label="Starting copies (p)"
                    description={N1 > 0 ? `1 to ${2 * N1 - 1}` : undefined}
                    value={startingCopies}
                    onChange={(v) => setStartingCopies(String(v))}
                    min={1}
                    allowDecimal={false}
                    error={countError || undefined}
                  />
                )}
                {initialMode === 'integrate' && (
                  <TextInput
                    mt="sm"
                    label="Integration cutoff"
                    description="Starting copy numbers rarer than this are left out of the integration over p"
                    value={integrationCutoff}
                    onChange={(e) => setIntegrationCutoff(e.currentTarget.value)}
                  />
                )}
                {fileError && <Text size="xs" c="red" mt="xs">{fileError}</Text>}
              </Paper>

              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Model parameters</Title>
                <Group grow>
                  <TextInput
                    label={populationScaled ? '2Ns' : 's'}
                    description="Selection coefficient"
                    value={selection}
                    onChange={(e) => setSelection(e.currentTarget.value)}
                  />
                  <TextInput
                    label="h"
                    description="Dominance coefficient"
                    value={dominance}
                    onChange={(e) => setDominance(e.currentTarget.value)}
                  />
                </Group>
                <Group grow mt="sm">
                  <TextInput
                    label={populationScaled ? '4Nu' : 'u'}
                    description="Backward mutation rate"
                    value={backwardMutation}
                    onChange={(e) => setBackwardMutation(e.currentTarget.value)}
                  />
                  <TextInput
                    label={populationScaled ? '4Nv' : 'v'}
                    description="Forward mutation rate"
                    value={forwardMutation}
                    onChange={(e) => setForwardMutation(e.currentTarget.value)}
                  />
                </Group>
                <Checkbox
                  mt="sm"
                  label="Population scaled"
                  description="Scaling uses the starting population size"
                  checked={populationScaled}
                  onChange={(e) => setPopulationScaled(e.currentTarget.checked)}
                />
                <TextInput
                  mt="sm"
                  label="Alpha"
                  description="Probability mass trimmed from the tails of each matrix row"
                  value={alpha}
                  onChange={(e) => setAlpha(e.currentTarget.value)}
                />
              </Paper>
            </Stack>
          </Grid.Col>

          <Grid.Col span={6}>
            <Paper p="md" withBorder style={{ minHeight: 300 }}>
              <Group justify="space-between" mb="md">
                <Title order={6}>Projected distribution</Title>
                <Group gap="xs">
                  {dist && dist.length > 0 && (
                    <>
                      <Tooltip label={copied ? 'Copied' : 'Copy as an initial-distribution column'}>
                        <Button
                          size="xs" variant="light"
                          leftSection={<IconCopy size={14} />}
                          onClick={copy}
                        >
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                      </Tooltip>
                      <Button
                        size="xs" variant="light"
                        leftSection={<IconDownload size={14} />}
                        onClick={save}
                      >
                        Save for --initial
                      </Button>
                    </>
                  )}
                  <Button
                    leftSection={<IconPlayerPlay size={16} />}
                    onClick={run}
                    loading={running}
                    disabled={!!blocked}
                  >
                    Execute
                  </Button>
                </Group>
              </Group>

              {blocked && !error && (
                <Alert color="yellow" variant="light" icon={<IconAlertCircle size={16} />} mb="md">
                  {blocked}
                </Alert>
              )}
              {error && (
                <Alert color="red" variant="light" mb="md">{error}</Alert>
              )}

              <SolverWarnings warnings={warnings} />

              {running && (
                <Stack align="center" p="xl">
                  <Loader size="sm" />
                  <Text size="sm" c="dimmed">Projecting...</Text>
                </Stack>
              )}

              {!running && !dist && !error && (
                <Text c="dimmed" size="sm">
                  No projection yet. Set the two population sizes and the starting
                  distribution, then click Execute.
                </Text>
              )}

              {!running && dist && summary && (
                <>
                  <Group gap="xl" mb="sm">
                    <Text size="xs" c="dimmed">
                      States: {summary.states.toLocaleString()} (counts 0..{2 * (ranWith?.N2 ?? 0)})
                    </Text>
                    <Text size="xs" c="dimmed">Sum: {formatQuantity(summary.total)}</Text>
                    <Text size="xs" c="dimmed">Mean count: {formatQuantity(summary.meanCount)}</Text>
                    <Text size="xs" c="dimmed">Mean frequency: {formatQuantity(summary.meanFreq)}</Text>
                  </Group>
                  <Group gap="xl" mb="sm">
                    <Text size="xs" c="dimmed">P(0) = {formatQuantity(summary.lost)}</Text>
                    <Text size="xs" c="dimmed">
                      P({2 * (ranWith?.N2 ?? 0)}) = {formatQuantity(summary.fixed)}
                    </Text>
                  </Group>
                  <Divider mb="xs" />
                  <Paper p="xs" withBorder mb="xs">
                    <Group gap="xs" align="center" mb={6}>
                      <Text size="xs" fw={600}>Export as counts</Text>
                      <SegmentedControl
                        size="xs"
                        value={exportFormat}
                        onChange={(v) => setExportFormat(v as ExportFormat)}
                        data={FORMATS.map(f => ({ value: f.value, label: f.label }))}
                      />
                      <Text size="xs" c="dimmed">
                        {FORMATS.find(f => f.value === exportFormat)?.span(ranWith?.N2 ?? 0)}
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed">
                      Read by: {FORMATS.find(f => f.value === exportFormat)?.consumers}.
                      {exported.dropped > 0 && (
                        <> Trimming drops {formatQuantity(exported.dropped)} of the
                        probability mass at the boundaries; the rest is renormalised.</>
                      )}
                    </Text>
                  </Paper>
                  <ScrollArea h={320}>
                    <Table striped highlightOnHover stickyHeader fz="xs">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Count</Table.Th>
                          <Table.Th>Frequency</Table.Th>
                          <Table.Th>Probability</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {dist.map((d) => (
                          <Table.Tr key={d.count}>
                            <Table.Td>{d.count}</Table.Td>
                            <Table.Td>
                              {formatQuantity(d.count / (2 * (ranWith?.N2 || 1)))}
                            </Table.Td>
                            <Table.Td>{formatQuantity(d.probability)}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </ScrollArea>
                </>
              )}
            </Paper>
          </Grid.Col>
        </Grid>

        <Paper p="md" withBorder mt="md">
          <Title order={6} mb="xs">Command Line Preview</Title>
          <Text
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' }}
          >
            {preview}
          </Text>
          <Text size="xs" c="dimmed" mt="xs">
            Two epochs of length zero, so the only step applied is the
            size-changing generation between them.
          </Text>
        </Paper>
      </Container>
    </div>
  )
}

export default PopulationProjectionView
