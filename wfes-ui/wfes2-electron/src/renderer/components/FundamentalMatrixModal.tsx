import React from 'react'
import { saveTextFile, saveBlobFile } from '../utils/saveFile'
import { Modal, Group, Button, Title, Text, Paper, Grid, Stack } from '@mantine/core'
import { IconDownload, IconFileTypeSvg, IconTable } from '@tabler/icons-react'
import FundamentalMatrixChart from './FundamentalMatrixChart'

interface FundamentalMatrixModalProps {
  opened: boolean
  onClose: () => void
  data: number[][]
  populationSize: number
  parameters: {
    N: number
    s: number
    h: number
    u: number
    v: number
  }
  title?: string
}

const FundamentalMatrixModal: React.FC<FundamentalMatrixModalProps> = ({
  opened,
  onClose,
  data,
  populationSize,
  parameters,
  title = 'Fundamental Matrix Visualization'
}) => {
  const handleExportPNG = () => {
    const svg = document.querySelector('.fundamental-matrix-container svg') as SVGElement
    if (!svg) return

    // Clone the SVG for export
    const svgClone = svg.cloneNode(true) as SVGElement
    
    // Get the viewBox or use the width/height
    const width = parseInt(svg.getAttribute('width') || '800')
    const height = parseInt(svg.getAttribute('height') || '800')
    
    // Set export dimensions
    svgClone.setAttribute('width', '800')
    svgClone.setAttribute('height', '800')
    svgClone.setAttribute('viewBox', `0 0 ${width} ${height}`)
    
    // Add white background
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    background.setAttribute('width', width.toString())
    background.setAttribute('height', height.toString())
    background.setAttribute('fill', 'white')
    svgClone.insertBefore(background, svgClone.firstChild)
    
    // Change all text to black
    svgClone.querySelectorAll('text').forEach(text => {
      text.setAttribute('fill', 'black')
    })
    
    // Change axes and grid lines
    svgClone.querySelectorAll('line').forEach(line => {
      const strokeWidth = line.getAttribute('stroke-width')
      if (strokeWidth === '2') {
        line.setAttribute('stroke', 'black')
      } else {
        line.setAttribute('stroke', '#cccccc')
      }
    })
    
    // Update any paths
    svgClone.querySelectorAll('path').forEach(path => {
      if (path.getAttribute('stroke')) {
        path.setAttribute('stroke', '#666666')
      }
    })
    
    // Update rectangles (matrix cells) - keep their original colors
    // They should remain colored to show the heat map

    const svgData = new XMLSerializer().serializeToString(svgClone)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new Image()

    canvas.width = 800
    canvas.height = 800

    img.onload = () => {
      ctx!.fillStyle = 'white'
      ctx!.fillRect(0, 0, canvas.width, canvas.height)
      ctx!.drawImage(img, 0, 0)
      
      canvas.toBlob(blob => {
        // Binary route: an <a download> is silently dropped here, and the
        // text route would corrupt the PNG.
        void saveBlobFile(blob!, `fundamental_matrix_N${parameters.N}_${new Date().toISOString().slice(0, 10)}.png`)
      })
    }

    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
  }

  const handleExportSVG = () => {
    const svg = document.querySelector('.fundamental-matrix-container svg') as SVGElement
    if (!svg) return

    // Clone the SVG for export
    const svgClone = svg.cloneNode(true) as SVGElement
    
    // Get dimensions
    const width = parseInt(svg.getAttribute('width') || '800')
    const height = parseInt(svg.getAttribute('height') || '800')
    
    // Set export dimensions
    svgClone.setAttribute('width', '800')
    svgClone.setAttribute('height', '800')
    svgClone.setAttribute('viewBox', `0 0 ${width} ${height}`)
    
    // Add white background
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    background.setAttribute('width', width.toString())
    background.setAttribute('height', height.toString())
    background.setAttribute('fill', 'white')
    svgClone.insertBefore(background, svgClone.firstChild)
    
    // Change all text to black
    svgClone.querySelectorAll('text').forEach(text => {
      text.setAttribute('fill', 'black')
    })
    
    // Change axes and grid lines
    svgClone.querySelectorAll('line').forEach(line => {
      const strokeWidth = line.getAttribute('stroke-width')
      if (strokeWidth === '2') {
        line.setAttribute('stroke', 'black')
      } else {
        line.setAttribute('stroke', '#cccccc')
      }
    })
    
    // Update any paths
    svgClone.querySelectorAll('path').forEach(path => {
      if (path.getAttribute('stroke')) {
        path.setAttribute('stroke', '#666666')
      }
    })
    
    // Add title
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = 'Fundamental Matrix Visualization'
    svgClone.insertBefore(title, svgClone.firstChild)

    const svgData = new XMLSerializer().serializeToString(svgClone)
    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(svgData, `fundamental_matrix_N${parameters.N}_${new Date().toISOString().slice(0, 10)}.svg`)
  }

  const handleExportData = () => {
    // Create CSV content - matrix format
    const csvContent = data.map(row => row.join(',')).join('\n')

    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(csvContent, `fundamental_matrix_N${parameters.N}.csv`)
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="90%"
      title={
        <Title order={4}>{title}</Title>
      }
      styles={{
        content: { maxWidth: '1400px' },
        body: { height: 'calc(90vh - 100px)' }
      }}
    >
      <Stack h="100%">
        <Group justify="flex-end">
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

        <Paper p="sm" withBorder>
          <Grid>
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
            <Grid.Col span={4}>
              <Text size="sm">
                <strong>Matrix Size:</strong> {data.length} × {data[0]?.length || 0}
              </Text>
            </Grid.Col>
          </Grid>
          <Text size="sm" c="dimmed" mt="xs">
            {title.includes('extinction') ? 
              'N_ext(i,j) represents the expected number of visits to state j starting from state i, given that the allele eventually goes extinct.' :
              title.includes('fixation') ?
              'N_fix(i,j) represents the expected number of visits to state j starting from state i, given that the allele eventually fixes.' :
              'N(i,j) represents the expected number of visits to state j starting from state i before absorption (extinction or fixation).'}
          </Text>
        </Paper>

        <div className="flex-1 fundamental-matrix-container overflow-auto" style={{ minHeight: 0 }}>
          <FundamentalMatrixChart
            data={data}
            populationSize={populationSize}
            className="h-full"
            showExportButton={false}
            parameters={parameters}
          />
        </div>
      </Stack>
    </Modal>
  )
}

export default FundamentalMatrixModal