import React, { useState, useRef } from 'react'
import { saveTextFile, saveBlobFile } from '../utils/saveFile'
import { Modal, Group, Button, Title, Text, Switch, Paper, Grid, Stack } from '@mantine/core'
import { IconDownload, IconFileTypeSvg, IconTable } from '@tabler/icons-react'
import EquilibriumChartMantine, { EquilibriumChartRef } from './EquilibriumChartMantine'

interface EquilibriumChartModalProps {
  opened: boolean
  onClose: () => void
  data: Array<{
    copies: number
    probability: number
  }>
  populationSize: number
  expectedFrequency: number
  parameters: {
    N: number
    s: number
    h: number
    u: number
    v: number
  }
}

const EquilibriumChartModal: React.FC<EquilibriumChartModalProps> = ({
  opened,
  onClose,
  data,
  populationSize,
  expectedFrequency,
  parameters
}) => {
  const [logScale, setLogScale] = useState(true)
  const chartRef = useRef<EquilibriumChartRef>(null)

  const handleExportPNG = () => {
    const svg = document.querySelector('.equilibrium-chart-container svg') as SVGElement
    if (!svg) return

    // Clone the SVG for export
    const svgClone = svg.cloneNode(true) as SVGElement
    
    // Get the viewBox or use the width/height
    const width = parseInt(svg.getAttribute('width') || '800')
    const height = parseInt(svg.getAttribute('height') || '600')
    
    // Set export dimensions
    svgClone.setAttribute('width', '800')
    svgClone.setAttribute('height', '600')
    svgClone.setAttribute('viewBox', `0 0 ${width} ${height}`)
    
    // Add white background
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    background.setAttribute('width', width.toString())
    background.setAttribute('height', height.toString())
    background.setAttribute('fill', 'white')
    svgClone.insertBefore(background, svgClone.firstChild)
    
    // Change all colors to black for export
    svgClone.querySelectorAll('text').forEach(text => {
      text.setAttribute('fill', 'black')
    })
    
    svgClone.querySelectorAll('line').forEach(line => {
      const strokeWidth = line.getAttribute('stroke-width')
      if (strokeWidth === '2') {
        line.setAttribute('stroke', 'black')
      } else {
        line.setAttribute('stroke', '#cccccc')
      }
    })
    
    // Keep data curve and points blue
    svgClone.querySelectorAll('path').forEach(path => {
      if (path.getAttribute('fill') === 'none') {
        path.setAttribute('stroke', '#3b82f6')
      }
    })
    
    svgClone.querySelectorAll('circle').forEach(circle => {
      circle.setAttribute('fill', '#3b82f6')
    })

    const svgData = new XMLSerializer().serializeToString(svgClone)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new Image()

    canvas.width = 800
    canvas.height = 600

    img.onload = () => {
      ctx!.fillStyle = 'white'
      ctx!.fillRect(0, 0, canvas.width, canvas.height)
      ctx!.drawImage(img, 0, 0)
      
      canvas.toBlob(blob => {
        // Binary route: an <a download> is silently dropped here.
        void saveBlobFile(blob!, `equilibrium_distribution_N${parameters.N}_${new Date().toISOString().slice(0, 10)}.png`)
      })
    }

    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
  }

  const handleExportSVG = () => {
    chartRef.current?.exportToSVG()
  }

  const handleExportData = () => {
    // Create CSV content
    const csvContent = [
      'copies,frequency,probability',
      ...data.map(d => `${d.copies},${d.copies / (2 * populationSize)},${d.probability}`)
    ].join('\n')

    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(csvContent, `equilibrium_distribution_N${parameters.N}.csv`)
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="95%"
      title={
        <Title order={4}>Equilibrium Frequency Distribution</Title>
      }
      styles={{
        content: { maxWidth: '1200px' },
        body: { height: 'calc(90vh - 100px)' }
      }}
    >
      <Stack h="100%">
        <Group justify="space-between">
          <Switch
            label="Log Scale"
            checked={logScale}
            onChange={(event) => setLogScale(event.currentTarget.checked)}
          />
          
          <Group gap="sm">
            <Button
              leftSection={<IconDownload size={16} />}
              size="sm"
              onClick={handleExportPNG}
            >
              Export PNG
            </Button>
            <Button
              leftSection={<IconFileTypeSvg size={16} />}
              size="sm"
              onClick={handleExportSVG}
            >
              Export SVG
            </Button>
            <Button
              leftSection={<IconTable size={16} />}
              size="sm"
              color="green"
              onClick={handleExportData}
            >
              Export Data
            </Button>
          </Group>
        </Group>

        <Paper p="sm" withBorder>
          <Grid>
            <Grid.Col span={4}>
              <Text size="sm">
                <strong>Expected Frequency:</strong> {expectedFrequency.toFixed(6)}
              </Text>
            </Grid.Col>
            <Grid.Col span={4}>
              <Text size="sm">
                <strong>Population Size (N):</strong> {parameters.N}
              </Text>
            </Grid.Col>
            <Grid.Col span={4}>
              <Text size="sm">
                <strong>Selection (2Ns):</strong> {(2 * parameters.N * parameters.s).toFixed(3)}
              </Text>
            </Grid.Col>
            <Grid.Col span={4}>
              <Text size="sm">
                <strong>Dominance (h):</strong> {parameters.h}
              </Text>
            </Grid.Col>
            <Grid.Col span={4}>
              <Text size="sm">
                <strong>Forward Mutation (4Nu):</strong> {(4 * parameters.N * parameters.u).toFixed(6)}
              </Text>
            </Grid.Col>
            <Grid.Col span={4}>
              <Text size="sm">
                <strong>Backward Mutation (4Nv):</strong> {(4 * parameters.N * parameters.v).toFixed(6)}
              </Text>
            </Grid.Col>
          </Grid>
        </Paper>

        <div className="flex-1 equilibrium-chart-container" style={{ minHeight: 0 }}>
          <EquilibriumChartMantine
            ref={chartRef}
            data={data}
            populationSize={populationSize}
            logScale={logScale}
            className="h-full"
            showExportButton={false}
            parameters={parameters}
          />
        </div>
      </Stack>
    </Modal>
  )
}

export default EquilibriumChartModal