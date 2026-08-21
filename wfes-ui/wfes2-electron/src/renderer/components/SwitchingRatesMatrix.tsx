import React, { useState, useEffect } from 'react'
import { 
  Paper, 
  Table, 
  TextInput, 
  Text, 
  Stack, 
  Title,
  Group,
  Badge,
  Box,
  Tooltip,
  Button,
  ActionIcon,
  Modal,
  Switch,
  Alert
} from '@mantine/core'
import { IconArrowRight, IconPlus, IconTrash, IconAlertCircle } from '@tabler/icons-react'

interface PopulationState {
  id: string
  name: string
}

interface SwitchingRate {
  fromState: string
  toState: string
  rate: string
}

interface SwitchingRatesMatrixProps {
  states: PopulationState[]
  rates: SwitchingRate[]
  onRateChange: (fromState: string, toState: string, rate: string) => void
  onStatesChange?: (states: PopulationState[]) => void
  onAddState?: () => void
  onRemoveState?: (id: string) => void
  onUpdateStateName?: (id: string, field: string, value: string) => void
  startingProbabilities?: string[]
  onStartingProbabilitiesChange?: (probabilities: string[]) => void
  disabled?: boolean
}

const SwitchingRatesMatrix: React.FC<SwitchingRatesMatrixProps> = ({
  states,
  rates,
  onRateChange,
  onStatesChange,
  onAddState,
  onRemoveState,
  onUpdateStateName,
  startingProbabilities: propStartingProbabilities,
  onStartingProbabilitiesChange,
  disabled = false
}) => {
  const [editingState, setEditingState] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [showPersistenceTimes, setShowPersistenceTimes] = useState(true) // Default to persistence times
  
  // Starting probabilities, shown as the run will actually use them.
  //
  // The parent owns this value and always supplies it, defaulting to all mass in
  // the first state. The fallback below matches that default; it exists only for
  // a caller that renders this dialog without the prop. Previously the fallback
  // was the real default and never propagated, so the dialog showed 100% in
  // state 1 while the diagram, the preview and the solver all used the CLI's
  // uniform default.
  const uniform = (n: number) =>
    Array.from({ length: n }, (_, i) => (i === 0 ? '1' : '0'))
  const [localStartingProbabilities, setLocalStartingProbabilities] = useState<string[]>(
    propStartingProbabilities || uniform(states.length)
  )
  
  // Update local starting probabilities when props change
  useEffect(() => {
    if (propStartingProbabilities) {
      setLocalStartingProbabilities(propStartingProbabilities)
    } else {
      // No explicit value: stay on the uniform default, resized to the current
      // number of states.
      setLocalStartingProbabilities(uniform(states.length))
    }
  }, [states.length, propStartingProbabilities])
  
  // Create a map for quick rate lookup
  const rateMap = new Map<string, string>()
  rates.forEach(r => {
    rateMap.set(`${r.fromState}-${r.toState}`, r.rate)
  })

  const getRate = (fromId: string, toId: string): string => {
    return rateMap.get(`${fromId}-${toId}`) || '0'
  }
  
  // Convert between rates and persistence times
  const rateToTime = (rate: string): string => {
    const r = parseFloat(rate)
    if (r === 0 || isNaN(r)) return ''
    return (1 / r).toFixed(0)
  }
  
  const timeToRate = (time: string): string => {
    if (time === '' || time === '0') return '0' // Special case: empty or 0 means no switching
    const t = parseFloat(time)
    if (isNaN(t) || t === 0) return '0'
    return (1 / t).toString()
  }

  const validateRate = (rate: string): boolean => {
    if (!rate) return false
    const num = parseFloat(rate)
    return !isNaN(num) && num >= 0 && num <= 1
  }
  
  const validateTime = (time: string): boolean => {
    if (!time || time === '') return true // Empty is ok (means no switching)
    if (time === '0') return true // Zero is ok (means no switching)
    const num = parseFloat(time)
    return !isNaN(num) && num >= 0
  }
  
  const validateProbability = (prob: string): boolean => {
    if (!prob) return false
    const num = parseFloat(prob)
    return !isNaN(num) && num >= 0 && num <= 1
  }
  
  const startingProbSum = (): number => {
    return localStartingProbabilities.reduce((sum, prob) => {
      const val = parseFloat(prob)
      return sum + (isNaN(val) ? 0 : val)
    }, 0)
  }
  
  const handleStartingProbabilityChange = (index: number, value: string) => {
    const newProbs = [...localStartingProbabilities]
    newProbs[index] = value
    setLocalStartingProbabilities(newProbs)
    
    if (onStartingProbabilitiesChange) {
      onStartingProbabilitiesChange(newProbs)
    }
  }

  // Calculate diagonal values (probability of staying in same state)
  const getDiagonalValue = (stateId: string): string => {
    let rowSum = 0
    states.forEach(toState => {
      if (toState.id !== stateId) {
        const rate = getRate(stateId, toState.id)
        const val = parseFloat(rate) || 0
        rowSum += val
      }
    })
    const diagonal = Math.max(0, 1 - rowSum)
    return diagonal.toFixed(6).replace(/\.?0+$/, '') // Remove trailing zeros
  }

  // Check if a row's off-diagonal sum exceeds 1
  const isRowSumExceeded = (fromStateId: string): boolean => {
    let rowSum = 0
    states.forEach(toState => {
      if (toState.id !== fromStateId) {
        const rate = getRate(fromStateId, toState.id)
        const val = parseFloat(rate) || 0
        rowSum += val
      }
    })
    return rowSum > 1
  }

  // Validate and potentially adjust rate to ensure row sum doesn't exceed 1
  const handleRateChange = (fromState: string, toState: string, newValue: string) => {
    if (showPersistenceTimes) {
      // Handle persistence time input
      if (validateTime(newValue)) {
        const rate = timeToRate(newValue)
        const newVal = parseFloat(rate) || 0
        
        // Calculate current row sum excluding this cell and diagonal
        let otherSum = 0
        states.forEach(state => {
          if (state.id !== fromState && state.id !== toState) {
            const r = getRate(fromState, state.id)
            otherSum += parseFloat(r) || 0
          }
        })
        
        // If new value would make row sum exceed 1, cap it
        const maxAllowed = 1 - otherSum
        if (newVal > maxAllowed) {
          onRateChange(fromState, toState, maxAllowed.toString())
        } else {
          onRateChange(fromState, toState, rate)
        }
      }
    } else {
      // Handle rate input
      if (newValue === '' || validateRate(newValue)) {
        const newVal = parseFloat(newValue) || 0
        
        // Calculate current row sum excluding this cell and diagonal
        let otherSum = 0
        states.forEach(state => {
          if (state.id !== fromState && state.id !== toState) {
            const rate = getRate(fromState, state.id)
            otherSum += parseFloat(rate) || 0
          }
        })
        
        // If new value would make row sum exceed 1, cap it
        const maxAllowed = 1 - otherSum
        if (newVal > maxAllowed) {
          onRateChange(fromState, toState, maxAllowed.toString())
        } else {
          onRateChange(fromState, toState, newValue)
        }
      }
    }
  }

  const handleStartEdit = (id: string, currentName: string) => {
    setEditingState(id)
    setEditingName(currentName)
  }

  const handleSaveEdit = () => {
    if (editingState && onUpdateStateName) {
      onUpdateStateName(editingState, 'name', editingName)
    }
    setEditingState(null)
    setEditingName('')
  }

  const handleCancelEdit = () => {
    setEditingState(null)
    setEditingName('')
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <div>
          <Title order={6}>Model Switching Configuration</Title>
          <Text size="sm" c="dimmed">
            {showPersistenceTimes 
              ? 'Enter the mean persistence time (generations) before switching to another state.'
              : 'Enter the probability of switching from one population state to another per generation.'
            }
          </Text>
        </div>
        <Group gap="md">
          <Switch
            label={showPersistenceTimes ? "Persistence Times" : "Switching Rates"}
            checked={showPersistenceTimes}
            onChange={(e) => setShowPersistenceTimes(e.currentTarget.checked)}
            disabled={disabled}
          />
          {onAddState && (
            <Button
              leftSection={<IconPlus size={16} />}
              variant="light"
              size="sm"
              onClick={onAddState}
              disabled={disabled}
            >
              Add State
            </Button>
          )}
        </Group>
      </Group>
      
      {/* Starting probabilities warning */}
      {Math.abs(startingProbSum() - 1.0) > 0.001 && (
        <Alert icon={<IconAlertCircle size={16} />} color="orange" variant="light">
          Starting probabilities must sum to 1.0 (currently: {startingProbSum().toFixed(3)})
        </Alert>
      )}
      
      <Box style={{ overflowX: 'auto' }}>
        <Table 
          striped 
          highlightOnHover
          withBorder
          withColumnBorders
          style={{ width: 'auto' }}
        >
          <thead>
            {/* Starting probabilities row */}
            <tr>
              <th style={{ 
                backgroundColor: 'rgba(37, 99, 235, 0.05)',
                padding: '8px 12px',
                borderBottom: '2px solid rgba(37, 99, 235, 0.2)'
              }}>
                <Text size="sm" fw={600} c="blue">
                  Starting Probability
                </Text>
              </th>
              {states.map((state, index) => (
                <th key={`start-prob-${state.id}`} style={{ 
                  backgroundColor: 'rgba(37, 99, 235, 0.05)',
                  padding: '6px',
                  borderBottom: '2px solid rgba(37, 99, 235, 0.2)',
                  width: '160px'
                }}>
                  <TextInput
                    value={localStartingProbabilities[index] || '0'}
                    onChange={(e) => handleStartingProbabilityChange(index, e.currentTarget.value)}
                    placeholder="0"
                    size="sm"
                    disabled={disabled}
                    error={!validateProbability(localStartingProbabilities[index] || '0') || Math.abs(startingProbSum() - 1.0) > 0.001}
                    styles={{
                      input: {
                        textAlign: 'center',
                        fontFamily: 'monospace',
                        backgroundColor: 'rgba(255, 255, 255, 0.05)',
                        fontWeight: 500
                      }
                    }}
                  />
                </th>
              ))}
            </tr>
            {/* Column headers */}
            <tr>
              <th style={{ 
                minWidth: '100px', 
                width: 'auto',
                backgroundColor: 'rgba(0, 0, 0, 0.02)',
                padding: '8px 12px',
                whiteSpace: 'nowrap'
              }}>
                <Group gap="xs">
                  <Text size="sm" fw={600}>From</Text>
                  <IconArrowRight size={14} />
                  <Text size="sm" fw={600}>To</Text>
                </Group>
              </th>
              {states.map(toState => (
                <th key={toState.id} style={{ 
                  textAlign: 'center', 
                  backgroundColor: 'rgba(0, 0, 0, 0.02)',
                  padding: '8px 12px',
                  minWidth: '160px',
                  width: '160px',
                  whiteSpace: 'nowrap'
                }}>
                  <Group gap={4} justify="center">
                    {editingState === toState.id ? (
                      <TextInput
                        value={editingName}
                        onChange={(e) => setEditingName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveEdit()
                          if (e.key === 'Escape') handleCancelEdit()
                        }}
                        onBlur={handleSaveEdit}
                        size="xs"
                        autoFocus
                        styles={{ input: { minWidth: '80px' } }}
                      />
                    ) : (
                      <Box
                        onClick={() => onUpdateStateName && !disabled && handleStartEdit(toState.id, toState.name)}
                        style={{ cursor: onUpdateStateName && !disabled ? 'pointer' : 'default' }}
                      >
                        <Badge 
                          color="blue" 
                          variant="light" 
                          size="md"
                        >
                          {toState.name}
                        </Badge>
                      </Box>
                    )}
                    {onRemoveState && states.length > 2 && !editingState && (
                      <ActionIcon 
                        size="xs" 
                        variant="subtle"
                        color="red"
                        onClick={() => onRemoveState(toState.id)}
                        disabled={disabled}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    )}
                  </Group>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {states.map(fromState => (
              <tr key={fromState.id}>
                <td style={{ 
                  backgroundColor: 'rgba(0, 0, 0, 0.02)',
                  padding: '8px 12px',
                  whiteSpace: 'nowrap'
                }}>
                  <Group gap={4}>
                    {editingState === fromState.id ? (
                      <TextInput
                        value={editingName}
                        onChange={(e) => setEditingName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveEdit()
                          if (e.key === 'Escape') handleCancelEdit()
                        }}
                        onBlur={handleSaveEdit}
                        size="xs"
                        autoFocus
                        styles={{ input: { minWidth: '80px' } }}
                      />
                    ) : (
                      <Box
                        onClick={() => onUpdateStateName && !disabled && handleStartEdit(fromState.id, fromState.name)}
                        style={{ cursor: onUpdateStateName && !disabled ? 'pointer' : 'default' }}
                      >
                        <Badge 
                          color="green" 
                          variant="light" 
                          size="md"
                        >
                          {fromState.name}
                        </Badge>
                      </Box>
                    )}
                    {onRemoveState && states.length > 2 && !editingState && (
                      <ActionIcon 
                        size="xs" 
                        variant="subtle"
                        color="red"
                        onClick={() => onRemoveState(fromState.id)}
                        disabled={disabled}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    )}
                  </Group>
                </td>
                {states.map(toState => (
                  <td key={toState.id} style={{ padding: '6px', width: '160px' }}>
                    {fromState.id === toState.id ? (
                      <Tooltip label="Probability of staying in the same state (auto-calculated)">
                        <Box
                          style={{
                            width: '100%',
                            height: '32px',
                            backgroundColor: 'rgba(0, 0, 0, 0.04)',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: isRowSumExceeded(fromState.id) ? '1px solid var(--mantine-color-red-6)' : 'none'
                          }}
                        >
                          <Text 
                            size="sm" 
                            c={isRowSumExceeded(fromState.id) ? 'red' : 'dimmed'}
                            fw={500}
                            style={{ fontFamily: 'monospace' }}
                          >
                            {getDiagonalValue(fromState.id)}
                          </Text>
                        </Box>
                      </Tooltip>
                    ) : (
                      <TextInput
                        value={showPersistenceTimes ? rateToTime(getRate(fromState.id, toState.id)) : getRate(fromState.id, toState.id)}
                        onChange={(e) => handleRateChange(fromState.id, toState.id, e.currentTarget.value)}
                        placeholder={showPersistenceTimes ? "∞" : "0"}
                        size="sm"
                        disabled={disabled}
                        error={
                          showPersistenceTimes 
                            ? (getRate(fromState.id, toState.id) !== '0' && !validateTime(rateToTime(getRate(fromState.id, toState.id)))) || isRowSumExceeded(fromState.id)
                            : !validateRate(getRate(fromState.id, toState.id)) || isRowSumExceeded(fromState.id)
                        }
                        onFocus={(e) => {
                          // Select all text when focused
                          e.currentTarget.select()
                        }}
                        onClick={(e) => {
                          // Also select all on click (in case already focused)
                          e.currentTarget.select()
                        }}
                        styles={{
                          input: {
                            textAlign: 'center',
                            fontFamily: 'monospace',
                            cursor: 'text'
                          }
                        }}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </Box>
      
      <Paper p="sm" withBorder>
        <Stack gap="xs">
          {showPersistenceTimes ? (
            <>
              <Text size="xs" c="dimmed">
                <strong>Persistence Times Mode:</strong> Enter the average number of generations before switching to another state.
              </Text>
              <Text size="xs" c="dimmed">
                • <strong>Off-diagonal cells:</strong> Mean persistence time before switching (e.g., 1000 = switch on average every 1000 generations)
              </Text>
              <Text size="xs" c="dimmed">
                • <strong>Diagonal cells:</strong> Probability of staying (auto-calculated from switching rates)
              </Text>
              <Text size="xs" c="dimmed">
                • <strong>Empty or 0:</strong> No switching between those states (infinite persistence time)
              </Text>
              <Text size="xs" c="dimmed">
                • <strong>Starting probabilities:</strong> Must sum to 1.0 - the probability of starting in each state
              </Text>
            </>
          ) : (
            <>
              <Text size="xs" c="dimmed">
                <strong>Switching Rates Mode:</strong> This is a stochastic matrix where each row must sum to 1.0 (100% probability).
              </Text>
              <Text size="xs" c="dimmed">
                • <strong>Off-diagonal cells:</strong> Probability of switching to another state per generation (0 to 1)
              </Text>
              <Text size="xs" c="dimmed">
                • <strong>Diagonal cells:</strong> Probability of staying (auto-calculated as 1 - sum of switching rates)
              </Text>
              <Text size="xs" c="dimmed">
                • <strong>Common values:</strong> 0.01 (1% per generation) or 0.001 (0.1% per generation)
              </Text>
              <Text size="xs" c="dimmed">
                • <strong>Starting probabilities:</strong> Must sum to 1.0 - the probability of starting in each state
              </Text>
            </>
          )}
          {states.some(state => isRowSumExceeded(state.id)) && (
            <Text size="xs" c="red" fw={500}>
              <strong>Warning:</strong> Some rows have switching rates that sum to more than 1.0. Please reduce the values.
            </Text>
          )}
        </Stack>
      </Paper>
    </Stack>
  )
}

export default SwitchingRatesMatrix