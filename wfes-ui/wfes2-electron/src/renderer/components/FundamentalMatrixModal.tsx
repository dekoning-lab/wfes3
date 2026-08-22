import React from 'react'
import { saveTextFile, saveBlobFile } from '../utils/saveFile'
import { Modal, Group, Button, Title, Text, Paper, Grid, Stack } from '@mantine/core'
import { IconDownload, IconFileTypeSvg, IconTable } from '@tabler/icons-react'
import FundamentalMatrixChart from './FundamentalMatrixChart'
import SojournVectorChart from './SojournVectorChart'
import { buildMatrixSvg } from '../utils/matrixSvg'
import { rasterWithStamp, rasterizeSvgString } from '../utils/chartStamp'
import { exportChartsSvg, exportChartsPng } from '../utils/exportChartsSvg'

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
  /**
   * Which sojourn matrix `data` actually is. The caption below used to be
   * chosen by searching the display title for "extinction" / "fixation", but
   * the titles say "Extinction-Conditioned" and "Fixation-Conditioned" with a
   * capital letter, so neither test ever matched: both conditional matrices
   * were shown under the unconditional definition, which describes a different
   * quantity. Semantics come from this prop now, not from prose.
   */
  kind?: 'unconditional' | 'extinction' | 'fixation' | 'transition'
  /**
   * The starting count the row was solved from, when the run used "One
   * starting count". Only used for labelling the single-row case.
   */
  startingCopies?: number
  /**
   * Command that produced this matrix, captured at execution. Stamps the
   * exported figures with a reproduce-this block; without it they export
   * unstamped rather than carrying a guess.
   */
  command?: string
}

const FundamentalMatrixModal: React.FC<FundamentalMatrixModalProps> = ({
  opened,
  onClose,
  data,
  populationSize,
  parameters,
  title = 'Fundamental Matrix Visualization',
  kind = 'unconditional',
  startingCopies,
  command
}) => {
  // One row means the solver was asked for one starting state, not that a
  // matrix came back short.
  const isVector = data.length === 1
  const symbol =
    kind === 'extinction' ? 'N_ext' :
    kind === 'fixation' ? 'N_fix' :
    kind === 'transition' ? 'Q' : 'N'
  const startingLabel =
    startingCopies !== undefined
      ? `${startingCopies} ${startingCopies === 1 ? 'copy' : 'copies'}`
      : 'the chosen starting count'
  const rowLabel = `${symbol}(${startingCopies ?? 'p'}, j)`
  /** What the chart is currently drawing, so an export can work from it. */
  const chartSurface = () => {
    const c = document.querySelector('.fundamental-matrix-container')
    return {
      svg: c?.querySelector('svg') as SVGElement | null,
      canvas: c?.querySelector('canvas') as HTMLCanvasElement | null,
      img: c?.querySelector('img') as HTMLImageElement | null
    }
  }

  const exportBase = `${symbol}_matrix_N${parameters.N}_${new Date().toISOString().slice(0, 10)}`

  /**
   * PNG of whatever is on screen.
   *
   * The chart renders three different ways depending on size -- SVG at 50 rows
   * or fewer, a canvas up to 200, a pre-rendered image above that -- and this
   * used to look only for an SVG and `return` when it found none. Every matrix
   * big enough to be worth exporting took that branch, so the button did
   * nothing at all and said nothing about it.
   */
  const handleExportPNG = () => {
    // A single row is displayed as a line chart, not a heatmap, so it has to be
    // exported as one. Both handlers used to go straight to buildMatrixSvg,
    // which always draws a heatmap -- the axis LABELS were switched for the
    // vector case but the figure was not, so the file disagreed with the screen
    // it came from. Routing through the shared chart exporter also matches how
    // every other chart in the app exports, and picks up the provenance stamp.
    if (isVector) {
      void exportChartsPng({
        container: document.querySelector('.fundamental-matrix-container') as HTMLElement | null,
        titles: [title],
        filename: `${symbol}_vector_N${parameters.N}`,
        command,
        version: __APP_VERSION__
      }).then(n => { if (!n) alert('The chart is not on screen yet. Wait for it to draw and try again.') })
        .catch((e: any) => alert(`The figure could not be exported as PNG: ${e?.message ?? e}`))
      return
    }

    const { svg, canvas, img } = chartSurface()

    // Preferred route: rasterise the same white, vector figure that Export SVG
    // writes. The on-screen heatmap is drawn for the dark UI, so capturing it
    // put a black chart above a white provenance block in one image -- and the
    // two formats disagreed about what the figure looked like. Falls through to
    // the screen capture only when the vector build declines (a matrix too
    // large to draw as shapes), which still beats no PNG at all.
    const vector = buildMatrixSvg({
      data,
      title,
      command,
      version: __APP_VERSION__,
      subtitle:
        `N = ${parameters.N}, 2Ns = ${(2 * parameters.N * parameters.s).toFixed(3)}, ` +
        `h = ${parameters.h}, 4Nu = ${(4 * parameters.N * parameters.u).toPrecision(4)}, ` +
        `4Nv = ${(4 * parameters.N * parameters.v).toPrecision(4)}`,
      xLabel: isVector ? 'Allele count (j)' : 'End State (j)',
      yLabel: isVector ? '' : 'Start State (i)'
    })
    if (vector.ok) {
      void rasterizeSvgString(vector.svg, 2)
        .then(blob => saveBlobFile(blob, `${exportBase}.png`))
        .catch((e: any) => alert(`The figure could not be exported as PNG: ${e?.message ?? e}`))
      return
    }

    const stampAndSave = (dataUrl: string, w: number, h: number) => {
      rasterWithStamp(dataUrl, w, h, { command: command!, version: __APP_VERSION__ }, 2)
        .then(blob => saveBlobFile(blob, `${exportBase}.png`))
        .catch((e: any) => alert(`The figure could not be exported as PNG: ${e?.message ?? e}`))
    }

    if (canvas) {
      if (command) {
        stampAndSave(canvas.toDataURL('image/png'), canvas.width, canvas.height)
        return
      }
      canvas.toBlob(blob => {
        if (blob) void saveBlobFile(blob, `${exportBase}.png`)
        else alert('The chart could not be converted to a PNG.')
      })
      return
    }

    if (img?.src) {
      // Already a raster: the chart drew it on an offscreen canvas and handed
      // it over as a data: URL. Decode that directly rather than fetch()ing it
      // -- fetch on a data: URL is at the mercy of the renderer's content
      // policy, and when it was refused here the failure surfaced as an alert
      // where a PNG should have been.
      if (command) {
        stampAndSave(img.src, img.naturalWidth || img.width, img.naturalHeight || img.height)
        return
      }
      try {
        const comma = img.src.indexOf(',')
        const bin = atob(img.src.slice(comma + 1))
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        void saveBlobFile(new Blob([bytes], { type: 'image/png' }), `${exportBase}.png`)
      } catch {
        alert('The chart image could not be read for export.')
      }
      return
    }

    if (svg) {
      const clone = svg.cloneNode(true) as SVGElement
      const width = parseInt(svg.getAttribute('width') || '800')
      const height = parseInt(svg.getAttribute('height') || '800')
      clone.setAttribute('width', '800')
      clone.setAttribute('height', '800')
      clone.setAttribute('viewBox', `0 0 ${width} ${height}`)
      const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      background.setAttribute('width', width.toString())
      background.setAttribute('height', height.toString())
      background.setAttribute('fill', 'white')
      clone.insertBefore(background, clone.firstChild)
      clone.querySelectorAll('text').forEach(t => t.setAttribute('fill', 'black'))

      const svgData = new XMLSerializer().serializeToString(clone)
      const out = document.createElement('canvas')
      out.width = 800
      out.height = 800
      const ctx = out.getContext('2d')
      const image = new Image()
      image.onload = () => {
        ctx!.fillStyle = 'white'
        ctx!.fillRect(0, 0, out.width, out.height)
        ctx!.drawImage(image, 0, 0)
        out.toBlob(blob => {
          if (blob) void saveBlobFile(blob, `${exportBase}.png`)
          else alert('The chart could not be converted to a PNG.')
        })
      }
      image.onerror = () => alert('The chart could not be converted to a PNG.')
      image.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
      return
    }

    alert('There is no chart on screen to export yet. Wait for it to finish drawing and try again.')
  }

  /**
   * SVG built from the data rather than scraped off the screen.
   *
   * Serialising the on-screen SVG only ever worked for matrices of 50 rows or
   * fewer, because that is the only size the chart draws as SVG. Building it
   * from `data` makes the export independent of the render mode and keeps it
   * true vector at any size -- which is the whole reason to pick SVG over PNG.
   */
  const handleExportSVG = () => {
    // A single row is displayed as a line chart, not a heatmap, so it has to be
    // exported as one. Both handlers used to go straight to buildMatrixSvg,
    // which always draws a heatmap -- the axis LABELS were switched for the
    // vector case but the figure was not, so the file disagreed with the screen
    // it came from. Routing through the shared chart exporter also matches how
    // every other chart in the app exports, and picks up the provenance stamp.
    if (isVector) {
      const n = exportChartsSvg({
        container: document.querySelector('.fundamental-matrix-container') as HTMLElement | null,
        titles: [title],
        filename: `${symbol}_vector_N${parameters.N}`,
        command,
        version: __APP_VERSION__
      })
      if (!n) alert('The chart is not on screen yet. Wait for it to draw and try again.')
      return
    }

    const result = buildMatrixSvg({
      data,
      title,
      command,
      version: __APP_VERSION__,
      subtitle:
        `N = ${parameters.N}, 2Ns = ${(2 * parameters.N * parameters.s).toFixed(3)}, ` +
        `h = ${parameters.h}, 4Nu = ${(4 * parameters.N * parameters.u).toPrecision(4)}, ` +
        `4Nv = ${(4 * parameters.N * parameters.v).toPrecision(4)}`,
      xLabel: isVector ? 'Allele count (j)' : 'End State (j)',
      yLabel: isVector ? '' : 'Start State (i)'
    })

    if (!result.ok) {
      alert(result.error)
      return
    }
    void saveTextFile(result.svg, `${exportBase}.svg`)
  }

  const handleExportData = () => {
    // Dense CSV of exactly what is plotted. Named for the matrix it holds --
    // every file used to be called "fundamental_matrix" regardless, so a
    // transition matrix and two conditional sojourn matrices all landed under
    // the name of the unconditional one and overwrote each other.
    const csvContent = data.map(row => row.join(',')).join('\n')

    // Through the main process: an <a download> is silently dropped here.
    void saveTextFile(csvContent, `${exportBase}.csv`)
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
                {isVector ? (
                  <><strong>Vector:</strong> {data[0]?.length || 0} states</>
                ) : (
                  <><strong>Matrix Size:</strong> {data.length} × {data[0]?.length || 0}</>
                )}
              </Text>
            </Grid.Col>
          </Grid>
          <Text size="sm" c="dimmed" mt="xs">
            {isVector ? (
              kind === 'extinction' ?
                `${rowLabel} is the expected number of visits to state j, starting from ${startingLabel}, given that the allele eventually goes extinct.` :
              kind === 'fixation' ?
                `${rowLabel} is the expected number of visits to state j, starting from ${startingLabel}, given that the allele eventually fixes.` :
                `${rowLabel} is the expected number of visits to state j, starting from ${startingLabel}, before absorption (extinction or fixation).`
            ) : (
              kind === 'transition' ?
                'Q(i,j) is the probability of moving from state i to state j in one generation. Every state is transient in this model, so each row sums to 1 and nothing is absorbed. Blank cells are transitions the model gives zero probability.' :
              kind === 'extinction' ?
                'N_ext(i,j) represents the expected number of visits to state j starting from state i, given that the allele eventually goes extinct.' :
              kind === 'fixation' ?
                'N_fix(i,j) represents the expected number of visits to state j starting from state i, given that the allele eventually fixes.' :
                'N(i,j) represents the expected number of visits to state j starting from state i before absorption (extinction or fixation).'
            )}
          </Text>
        </Paper>

        {/* "One starting count" solves a single row, and the CLI writes exactly
            that one row. Drawing it on the heatmap stretched it over the whole
            plot height, which read as a matrix with every other row missing.
            A single row is a vector, so it gets a vector's chart. */}
        <div className="flex-1 fundamental-matrix-container overflow-auto" style={{ minHeight: 0 }}>
          {isVector ? (
            <SojournVectorChart
              values={data[0]}
              kind={kind}
              startingCopies={startingCopies}
              className="h-full"
            />
          ) : (
            <FundamentalMatrixChart
              data={data}
              populationSize={populationSize}
              className="h-full"
              showExportButton={false}
              parameters={parameters}
            />
          )}
        </div>
      </Stack>
    </Modal>
  )
}

export default FundamentalMatrixModal