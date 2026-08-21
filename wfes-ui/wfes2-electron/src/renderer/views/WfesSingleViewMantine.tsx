/**
 * @file WfesSingleViewMantine.tsx
 * @brief Main view component for WFES Single population analysis using Mantine UI
 * 
 * This component provides the user interface for all single-population Wright-Fisher
 * exact solver models including absorption, fixation, establishment, fundamental matrix,
 * equilibrium distribution, allele age, and non-absorbing calculations.
 */

import React, { useState, useEffect } from 'react'
import { saveTextFile } from '../utils/saveFile'
import { 
  NumberInput, 
  TextInput, 
  Button, 
  Checkbox, 
  Radio, 
  Group, 
  Stack, 
  Paper, 
  Title, 
  Text,
  Divider,
  ActionIcon,
  Tooltip,
  Select,
  Grid,
  Container,
  Space,
  Loader,
  Alert,
  SegmentedControl,
  Box,
  useMantineTheme
} from '@mantine/core'
import { IconArrowLeft, IconPlayerPlay, IconPlayerStop, IconDownload } from '@tabler/icons-react'
import EquilibriumChartWindow from '../components/EquilibriumChartWindow'
import FundamentalMatrixWindow from '../components/FundamentalMatrixWindow'

/**
 * @interface WfesSingleViewProps
 * @brief Props for the WfesSingleView component
 */
interface WfesSingleViewProps {
  /** Callback function to navigate back to the main menu */
  onBack: () => void
  /** Whether to hide the back button (for embedded use) */
  hideBackButton?: boolean
}

/**
 * @type ModelType
 * @brief Available model types for single population analysis
 */
type ModelType = 'absorption' | 'fixation' | 'establishment' | 'fundamental' | 'nonAbsorbing' | 'equilibrium' | 'alleleAge'

/**
 * @component WfesSingleViewMantine
 * @brief Main component for WFES single population analysis interface
 * 
 * Provides a comprehensive UI for configuring and running Wright-Fisher exact solver
 * calculations for a single population. Supports multiple model types and displays
 * results in tables and charts.
 * 
 * @param props Component properties
 * @returns React component
 */
const WfesSingleViewMantine: React.FC<WfesSingleViewProps> = ({ onBack, hideBackButton = false }) => {
  const theme = useMantineTheme()
  
  // Model type
  const [modelType, setModelType] = useState<ModelType>('absorption')
  
  /**
   * @brief Clear all results and reset execution state
   * 
   * Called when model type changes or new execution starts
   */
  const clearResults = () => {
    setResults(null)
    setExecutionTime('')
    setProgress(0)
    setProgressMessage('')
  }

  // Get CPU count for default threads
  const getCpuCount = () => {
    return navigator.hardwareConcurrency || 4
  }

  // Input parameters
  const [populationSize, setPopulationSize] = useState('100')
  const [selectionCoefficient, setSelectionCoefficient] = useState('0')
  const [dominanceCoefficient, setDominanceCoefficient] = useState('0.5')
  const [mutationRateForward, setMutationRateForward] = useState('0.001')
  const [mutationRateBackward, setMutationRateBackward] = useState('0.001')
  
  const [alpha, setAlpha] = useState('1e-20')
  const [integrateOverP, setIntegrateOverP] = useState(false)
  const [startingCopies, setStartingCopies] = useState('1')
  const [integrationCutoff, setIntegrationCutoff] = useState('1e-10')
  const [mutationOnly, setMutationOnly] = useState(false)
  const [scaledMutation, setScaledMutation] = useState(false)
  const [scaledSelection, setScaledSelection] = useState(false)

  // Output options
  const [writeQ, setWriteQ] = useState(false)
  const [writeR, setWriteR] = useState(false)
  const [writeB, setWriteB] = useState(false)
  const [writeN, setWriteN] = useState(false)
  const [writeNExt, setWriteNExt] = useState(false)
  const [writeNFix, setWriteNFix] = useState(false)
  const [writeI, setWriteI] = useState(false)
  const [writeE, setWriteE] = useState(false)
  const [writeV, setWriteV] = useState(false)
  const [writeRes, setWriteRes] = useState(false)

  // Execution options
  const [force, setForce] = useState(false)
  const [threads, setThreads] = useState(getCpuCount().toString())
  const [library, setLibrary] = useState<'Accelerate' | 'ViennaCL'>('Accelerate')
  const [initialDistribution, setInitialDistribution] = useState('')

  // Results state
  const [results, setResults] = useState<any>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [executionTime, setExecutionTime] = useState('')
  const [showEquilibriumChart, setShowEquilibriumChart] = useState(false)
  const [showFundamentalMatrix, setShowFundamentalMatrix] = useState(false)

  // Validation functions
  const validatePositiveInteger = (value: string) => {
    const num = parseInt(value)
    return !isNaN(num) && num > 0
  }

  const validateProbability = (value: string) => {
    const num = parseFloat(value)
    return !isNaN(num) && num >= 0 && num <= 1
  }

  const validateStartingCopies = () => {
    const p = parseInt(startingCopies)
    const N = parseInt(populationSize)
    return !isNaN(p) && !isNaN(N) && p >= 0 && p <= 2 * N
  }

  const modelOptions = [
    { value: 'absorption', label: 'Absorption', description: 'Absorption probabilities and times' },
    { value: 'fixation', label: 'Fixation', description: 'Calculate fixation rate and time' },
    { value: 'establishment', label: 'Establishment', description: 'Calculate establishment probabilities' },
    { value: 'fundamental', label: 'Fundamental', description: 'Calculate fundamental matrix properties' },
    { value: 'nonAbsorbing', label: 'Non Absorbing', description: 'Non-absorbing steady state' },
    { value: 'equilibrium', label: 'Equilibrium', description: 'Equilibrium frequencies' },
    { value: 'alleleAge', label: 'Allele Age', description: 'Expected age of an allele' }
  ]

  const executeModel = async () => {
    setIsExecuting(true)
    setProgress(0)
    setProgressMessage('Initializing...')
    
    // Simulate execution with progress updates
    const steps = [
      { progress: 20, message: 'Building transition matrix...' },
      { progress: 40, message: 'Solving linear system...' },
      { progress: 60, message: 'Computing results...' },
      { progress: 80, message: 'Finalizing...' },
      { progress: 100, message: 'Complete!' }
    ]
    
    for (const step of steps) {
      await new Promise(resolve => setTimeout(resolve, 500))
      setProgress(step.progress)
      setProgressMessage(step.message)
    }
    
    // Mock results
    setResults({
      pAbsorption: '0.52341',
      pExtinction: '0.47659',
      tAbsorption: '125.3',
      tExtinction: '89.7',
      rate: '0.00234',
      executionTime: '0.245s'
    })
    
    setExecutionTime('0.245s')
    setIsExecuting(false)
    setProgressMessage('')
  }

  const stopExecution = () => {
    setIsExecuting(false)
    setProgress(0)
    setProgressMessage('')
  }

  const exportResults = () => {
    if (!results) return
    const data = JSON.stringify(results, null, 2)
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(data, 'wfes_single_results.json')
  }

  return (
    <div className={`flex flex-col h-full bg-gray-800 dark:bg-gray-800 ${!hideBackButton ? 'native-window' : ''}`}>
      {/* Header */}
      <Paper p="xs" radius={0} style={{ borderBottom: `1px solid ${theme.colors.gray[7]}` }}>
        <Group justify="space-between">
          <Group>
            {!hideBackButton && (
              <Tooltip label="Back to main menu">
                <ActionIcon onClick={onBack} variant="subtle" size="lg">
                  <IconArrowLeft size={20} />
                </ActionIcon>
              </Tooltip>
            )}
            <Title order={4}>WFES Single</Title>
          </Group>
        </Group>
      </Paper>

      {/* Main content */}
      <Container fluid p="md" style={{ flex: 1, overflow: 'auto' }}>
        <Grid>
          {/* Column 1: Mode & Input Parameters */}
          <Grid.Col span={4} style={{ minWidth: '350px', maxWidth: '400px' }}>
            <Stack>
              {/* Mode Section */}
              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Mode</Title>
                <SegmentedControl
                  value={modelType}
                  onChange={(value) => {
                    setModelType(value as ModelType)
                    clearResults()
                  }}
                  data={[
                    { label: 'Absorption', value: 'absorption' },
                    { label: 'Fixation', value: 'fixation' },
                    { label: 'Establishment', value: 'establishment' },
                    { label: 'Fundamental', value: 'fundamental' },
                    { label: 'Non Absorbing', value: 'nonAbsorbing' },
                    { label: 'Equilibrium', value: 'equilibrium' },
                    { label: 'Allele Age', value: 'alleleAge' }
                  ]}
                  orientation="vertical"
                  fullWidth
                />
                <Text size="xs" c="dimmed" mt="xs" style={{ minWidth: '300px', display: 'block' }}>
                  {modelOptions.find(m => m.value === modelType)?.description}
                </Text>
              </Paper>

              {/* Population Section */}
              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Population</Title>
                <Stack gap="sm">
                  <NumberInput
                    label="N"
                    description="Population size"
                    value={populationSize}
                    onChange={(value) => setPopulationSize(value?.toString() || '')}
                    min={1}
                    required
                    error={populationSize !== '' && !validatePositiveInteger(populationSize)}
                  />
                  <NumberInput
                    label="a"
                    description="Tail truncation weight"
                    value={alpha}
                    onChange={(value) => setAlpha(value?.toString() || '')}
                    placeholder="1e-20"
                  />
                  {(modelType === 'absorption' || modelType === 'fixation' || modelType === 'establishment' || modelType === 'alleleAge') && (
                    <>
                      <Checkbox
                        label="Integrate over p"
                        checked={integrateOverP}
                        onChange={(event) => setIntegrateOverP(event.currentTarget.checked)}
                      />
                      <NumberInput
                        label="p"
                        description="Starting number of copies"
                        value={startingCopies}
                        onChange={(value) => setStartingCopies(value?.toString() || '')}
                        disabled={integrateOverP}
                        min={0}
                        max={populationSize ? parseInt(populationSize) * 2 : undefined}
                        error={startingCopies !== '' && !validateStartingCopies()}
                      />
                      <NumberInput
                        label="c"
                        description="Starting probability cutoff (Ignore rare starting copy numbers with probability below this cutoff)"
                        value={integrationCutoff}
                        onChange={(value) => setIntegrationCutoff(value?.toString() || '')}
                        placeholder="1e-10"
                        disabled={!integrateOverP}
                      />
                    </>
                  )}
                </Stack>
              </Paper>

              {/* Mutation Section */}
              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Mutation</Title>
                <Stack gap="sm">
                  <Group grow>
                    <Checkbox
                      label="Population Scaled"
                      checked={scaledMutation}
                      onChange={(event) => setScaledMutation(event.currentTarget.checked)}
                    />
                  </Group>
                  <NumberInput
                    label="4Nu"
                    description="Forward mutation rate"
                    value={mutationRateForward}
                    onChange={(value) => setMutationRateForward(value?.toString() || '')}
                    step={0.001}
                    precision={3}
                    min={0}
                  />
                  <NumberInput
                    label="4Nv"
                    description="Backward mutation rate"
                    value={mutationRateBackward}
                    onChange={(value) => setMutationRateBackward(value?.toString() || '')}
                    step={0.001}
                    precision={3}
                    min={0}
                  />
                  <Checkbox
                    label="m"
                    checked={mutationOnly}
                    onChange={(event) => setMutationOnly(event.currentTarget.checked)}
                  />
                </Stack>
              </Paper>

              {/* Selection Section */}
              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Selection</Title>
                <Stack gap="sm">
                  <NumberInput
                    label="2Ns"
                    description="Selection coefficient"
                    value={selectionCoefficient}
                    onChange={(value) => setSelectionCoefficient(value?.toString() || '')}
                    step={0.1}
                    precision={2}
                  />
                  <NumberInput
                    label="h"
                    description="Dominance coefficient"
                    value={dominanceCoefficient}
                    onChange={(value) => setDominanceCoefficient(value?.toString() || '')}
                    step={0.1}
                    precision={2}
                    min={0}
                    max={1}
                    error={dominanceCoefficient !== '' && !validateProbability(dominanceCoefficient)}
                  />
                </Stack>
              </Paper>
            </Stack>
          </Grid.Col>

          {/* Column 2: Output Options */}
          <Grid.Col span={4} style={{ minWidth: '350px', maxWidth: '400px' }}>
            <Stack>
              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Output Options</Title>
                <Stack gap="xs">
                  <Checkbox label="Write Q" checked={writeQ} onChange={(e) => setWriteQ(e.currentTarget.checked)} />
                  <Checkbox label="Write R" checked={writeR} onChange={(e) => setWriteR(e.currentTarget.checked)} />
                  <Checkbox label="Write B" checked={writeB} onChange={(e) => setWriteB(e.currentTarget.checked)} />
                  <Checkbox label="Write N" checked={writeN} onChange={(e) => setWriteN(e.currentTarget.checked)} />
                  <Checkbox label="Write N_Ext" checked={writeNExt} onChange={(e) => setWriteNExt(e.currentTarget.checked)} />
                  <Checkbox label="Write N_Fix" checked={writeNFix} onChange={(e) => setWriteNFix(e.currentTarget.checked)} />
                  <Checkbox label="Write I" checked={writeI} onChange={(e) => setWriteI(e.currentTarget.checked)} />
                  <Checkbox label="Write E" checked={writeE} onChange={(e) => setWriteE(e.currentTarget.checked)} />
                  <Checkbox label="Write V" checked={writeV} onChange={(e) => setWriteV(e.currentTarget.checked)} />
                  <Checkbox label="Write Res" checked={writeRes} onChange={(e) => setWriteRes(e.currentTarget.checked)} />
                </Stack>
              </Paper>

              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Execution</Title>
                <Stack gap="sm">
                  <Checkbox 
                    label="Force" 
                    checked={force} 
                    onChange={(e) => setForce(e.currentTarget.checked)} 
                  />
                  <NumberInput
                    label="t"
                    description="Number of threads"
                    value={threads}
                    onChange={(value) => setThreads(value?.toString() || '')}
                    min={1}
                    max={getCpuCount()}
                  />
                  <Select
                    label="Library"
                    value={library}
                    onChange={(value) => setLibrary(value as 'Accelerate' | 'ViennaCL')}
                    data={[
                      { value: 'Accelerate', label: 'Accelerate' },
                      { value: 'ViennaCL', label: 'ViennaCL' }
                    ]}
                  />
                </Stack>
              </Paper>

              <Paper p="md" withBorder>
                <Title order={6} mb="sm">Initial Distribution</Title>
                <Stack gap="sm">
                  <TextInput
                    placeholder="Optional file path"
                    value={initialDistribution}
                    onChange={(e) => setInitialDistribution(e.currentTarget.value)}
                    rightSection={
                      <Button size="xs" variant="subtle">Browse</Button>
                    }
                  />
                </Stack>
              </Paper>

              <Group justify="center" mt="xl">
                {!isExecuting ? (
                  <Button 
                    leftSection={<IconPlayerPlay size={16} />}
                    size="lg"
                    onClick={executeModel}
                  >
                    Execute
                  </Button>
                ) : (
                  <Button 
                    leftSection={<IconPlayerStop size={16} />}
                    size="lg"
                    color="red"
                    onClick={stopExecution}
                  >
                    Stop
                  </Button>
                )}
              </Group>
            </Stack>
          </Grid.Col>

          {/* Column 3: Results */}
          <Grid.Col span={4} style={{ minWidth: '350px', maxWidth: '400px' }}>
            <Paper p="md" withBorder style={{ height: '100%' }}>
              <Group justify="space-between" mb="md">
                <Title order={6}>Results</Title>
                {results && (
                  <Tooltip label="Export results">
                    <ActionIcon onClick={exportResults} variant="subtle">
                      <IconDownload size={20} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
              
              {isExecuting ? (
                <Stack align="center" justify="center" style={{ height: '200px' }}>
                  <Loader size="lg" />
                  <Text size="sm" c="dimmed">{progressMessage}</Text>
                  <Text size="xs" c="dimmed">{progress}%</Text>
                </Stack>
              ) : results ? (
                <Stack gap="sm">
                  <Text size="sm"><strong>P(Absorption):</strong> {results.pAbsorption}</Text>
                  <Text size="sm"><strong>P(Extinction):</strong> {results.pExtinction}</Text>
                  <Text size="sm"><strong>T(Absorption):</strong> {results.tAbsorption}</Text>
                  <Text size="sm"><strong>T(Extinction):</strong> {results.tExtinction}</Text>
                  <Text size="sm"><strong>Rate:</strong> {results.rate}</Text>
                  <Divider my="sm" />
                  <Text size="xs" c="dimmed">Execution time: {executionTime}</Text>
                  
                  {modelType === 'equilibrium' && (
                    <Button 
                      variant="light" 
                      size="sm"
                      onClick={() => setShowEquilibriumChart(true)}
                      mt="md"
                    >
                      View Equilibrium Distribution
                    </Button>
                  )}
                  
                  {modelType === 'fundamental' && (
                    <Button 
                      variant="light" 
                      size="sm"
                      onClick={() => setShowFundamentalMatrix(true)}
                      mt="md"
                    >
                      View Fundamental Matrix
                    </Button>
                  )}
                </Stack>
              ) : (
                <Text size="sm" c="dimmed" ta="center" mt="xl">
                  No results yet. Configure parameters and click Execute.
                </Text>
              )}
            </Paper>
          </Grid.Col>
        </Grid>
      </Container>

      {/* Chart Windows */}
      {showEquilibriumChart && (
        <EquilibriumChartWindow
          data={results?.equilibriumData || []}
          onClose={() => setShowEquilibriumChart(false)}
        />
      )}
      
      {showFundamentalMatrix && (
        <FundamentalMatrixWindow
          matrixData={results?.fundamentalMatrix || []}
          populationSize={parseInt(populationSize)}
          onClose={() => setShowFundamentalMatrix(false)}
        />
      )}
    </div>
  )
}

export default WfesSingleViewMantine