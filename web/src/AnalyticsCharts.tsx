import { useId, useState } from 'react'

export type ChartPart = { label: string; amount: number; tone: string }
type Series = { label: string; tone: string }
type ChartRow = { date: string; values: number[] }
const date = (value: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value))
const count = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)

export function TrendChart({ title, rows, series, unit = 'orders', line = false }: { title: string; rows: ChartRow[]; series: Series[]; unit?: string; line?: boolean }) {
  const id = useId()
  const [selected, setSelected] = useState<number | null>(null)
  const totals = rows.map(row => row.values.reduce((a, b) => a + b, 0))
  const largest = Math.max(1, ...totals)
  const step = Math.max(line ? 0.5 : 1, Math.ceil(largest / 4))
  const maximum = step * 4
  const width = 720, height = 254, left = 42, right = 12, top = 18, bottom = 34
  const plotWidth = width - left - right, plotHeight = height - top - bottom
  const band = plotWidth / Math.max(1, rows.length)
  const x = (index: number) => left + (index + 0.5) * band
  const y = (value: number) => top + plotHeight * (1 - value / maximum)
  const active = selected !== null ? Math.min(selected, rows.length - 1) : Math.max(0, totals.indexOf(Math.max(...totals)))
  const current = rows[active]
  const describe = (row: ChartRow) => `${date(row.date)}: ${series.map((part, i) => `${count(row.values[i])} ${part.label.toLowerCase()}`).join(', ')}`
  const linePoints = rows.map((row, index) => `${x(index)},${y(row.values[0])}`).join(' ')
  return <div className="trend-chart">
    <div className="chart-plot">
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-labelledby={id}>
      <title id={id}>{title}. Daily {unit}. Use Tab or arrow keys to inspect values.</title>
      {[0, 1, 2, 3, 4].map(tick => <g key={tick} className="chart-axis">
        <line x1={left} x2={width - right} y1={y(tick * step)} y2={y(tick * step)} />
        <text x={left - 10} y={y(tick * step) + 4} textAnchor="end">{count(tick * step)}</text>
      </g>)}
      {line ? <>
        <polygon points={`${x(0)},${y(0)} ${linePoints} ${x(rows.length - 1)},${y(0)}`} className="chart-area" />
        <polyline points={linePoints} className="chart-line" />
      </> : null}
      {rows.map((row, index) => {
        let cumulative = 0
        return <g key={row.date} tabIndex={0} role="img" aria-label={describe(row)} className={index === active ? 'chart-day is-active' : 'chart-day'}
          onMouseEnter={() => setSelected(index)} onFocus={() => setSelected(index)}
          onKeyDown={event => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
            event.preventDefault()
            const next = event.key === 'ArrowRight' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling
            if (next?.classList.contains('chart-day')) (next as SVGElement).focus()
          }}>
          <title>{describe(row)}</title>
          <rect className="chart-hover-column" x={left + index * band} y={top} width={band} height={plotHeight} rx="5" />
          {line ? <circle cx={x(index)} cy={y(row.values[0])} r={index === active ? 4.5 : rows.length > 7 ? 2 : 3} className="chart-dot" /> : row.values.map((amount, part) => {
            cumulative += amount
            return <rect key={series[part].label} data-tone={series[part].tone} className="chart-column" x={x(index) - Math.min(28, band * 0.52) / 2} y={y(cumulative)} width={Math.min(28, band * 0.52)} height={Math.max(0, amount / maximum * plotHeight)} />
          })}
        </g>
      })}
      {rows.map((row, index) => index === 0 || index === rows.length - 1 || index % Math.ceil(rows.length / 6) === 0
        ? <text key={row.date} className="chart-date" x={x(index)} y={height - 9} textAnchor="middle">{date(row.date)}</text> : null)}
    </svg>
    </div>
    <p className="chart-scroll-hint">Scroll the chart horizontally to see all dates.</p>
    <div className="chart-reading" aria-live="polite"><span>{current ? date(current.date) : ''}</span>{current ? series.map((part, index) => <span key={part.label}><i className="analytics-key" data-tone={part.tone} /><strong>{count(current.values[index])}</strong> {part.label.toLowerCase()}</span>) : null}</div>
    {!totals.some(Boolean) ? <p className="chart-empty-note">No {unit} recorded in this period. The chart will update as activity comes in.</p> : null}
  </div>
}

export function OutcomeRing({ parts }: { parts: ChartPart[] }) {
  const total = parts.reduce((sum, part) => sum + part.amount, 0)
  let offset = 0
  return <div className="outcome-ring">
    <svg viewBox="0 0 160 160" role="img" aria-label={total ? parts.map(part => `${part.label}: ${part.amount}`).join(', ') : 'No orders in this period'}>
      <circle className="ring-track" cx="80" cy="80" r="60" fill="none" strokeWidth="17" />
      {parts.map(part => {
        const length = total ? part.amount / total * 100 : 0
        const start = offset
        offset += length
        return <circle key={part.label} className="ring-segment" data-tone={part.tone} cx="80" cy="80" r="60" fill="none" strokeWidth="17" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-start} transform="rotate(-90 80 80)" />
      })}
      <text className="ring-total" x="80" y="79" textAnchor="middle">{count(total)}</text>
      <text className="ring-label" x="80" y="99" textAnchor="middle">total orders</text>
    </svg>
  </div>
}
