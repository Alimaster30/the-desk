import { useEffect, useState } from 'react'
import type { organizationAnalytics } from '../../src/server/analytics'
import { PageHeading } from './ui'
import { TrendChart, OutcomeRing } from './AnalyticsCharts'

type Analytics = Awaited<ReturnType<typeof organizationAnalytics>>
type Segment = { label: string; amount: number; tone: string }
const number = new Intl.NumberFormat()
const dayLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
const dateText = (day: string) => dayLabel.format(new Date(day))

function Bar({ segments, max }: { segments: Segment[]; max: number }) {
  return <div className="analytics-bar" aria-hidden="true">
    {segments.map(segment => <span key={segment.label} data-tone={segment.tone} style={{ width: `${segment.amount / Math.max(1, max) * 100}%` }} />)}
  </div>
}

function Counts({ segments }: { segments: Segment[] }) {
  return <ul className="analytics-counts">
    {segments.map(segment => <li key={segment.label}><span className="analytics-key" data-tone={segment.tone} aria-hidden="true" />{segment.label}<strong>{number.format(segment.amount)}</strong></li>)}
  </ul>
}

function OrderLinks({ title, rows, total }: { title: string; rows: Analytics['pending']; total: number }) {
  return <section className="analytics-panel">
    <h2>{title} <span className="badge">{number.format(total)}</span></h2>
    {rows.length ? <ul className="analytics-orders">
      {rows.map(order => <li key={order.id}><a href={`#/orders?order=${encodeURIComponent(order.id)}`}>{order.reference}</a><time dateTime={order.createdAt}>{dateText(order.createdAt)}</time></li>)}
    </ul> : <p>No orders to review in this period.</p>}
    {total > rows.length && rows.length ? <p>Showing the {rows.length} most recent. <a href="#/orders">Open Orders</a></p> : null}
  </section>
}

export function AnalyticsPage() {
  const [days, setDays] = useState<7 | 30>(7)
  const [data, setData] = useState<Analytics | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setData(null)
    setError('')
    fetch(`/api/admin/analytics?days=${days}`, { signal: controller.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Analytics could not be loaded.')
      if (!controller.signal.aborted) setData(result)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message || 'Analytics could not be loaded.') })
    return () => controller.abort()
  }, [days, refresh])

  const total = data ? data.outcomes.pending + data.outcomes.confirmed + data.outcomes.cancelled : 0
  const segments = (counts: Analytics['outcomes']): Segment[] => [
    { label: 'Confirmed', amount: counts.confirmed, tone: 'positive' },
    { label: 'Cancelled', amount: counts.cancelled, tone: 'negative' },
    { label: 'Pending', amount: counts.pending, tone: 'waiting' },
  ]
  const messages = data ? [
    { label: 'Queued or sending', amount: data.invitations.queued, tone: 'waiting' },
    { label: 'Provider acknowledged', amount: data.invitations.acknowledged, tone: 'positive' },
    { label: 'Failed', amount: data.invitations.failed, tone: 'negative' },
    { label: 'Skipped', amount: data.invitations.skipped, tone: 'neutral' },
    ...(data.invitations.legacyProcessed ? [{ label: 'Processed (older records)', amount: data.invitations.legacyProcessed, tone: 'neutral' }] : []),
  ] : []

  return <main className="analytics-page">
    <PageHeading title="Analytics" description="Order confirmations and calling activity across this organization.">
      <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh analytics</button>
    </PageHeading>
    <div className="analytics-toolbar">
      <div className="filter-tabs" aria-label="Analytics period">
        {[7, 30].map(period => <button type="button" key={period} aria-pressed={days === period} onClick={() => setDays(period === 7 ? 7 : 30)}>Last {period} days</button>)}
      </div>
      {data ? <span className="note">{dateText(data.daily[0].date)} – {dateText(data.daily.at(-1)!.date)} · UTC</span> : null}
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {!data ? !error && <p className="waiting" role="status">Loading analytics…</p> : <>
      <dl className="analytics-metrics">
        <div><dt>Orders created</dt><dd>{number.format(total)}</dd><small>Across the organization</small></div>
        <div><dt>Confirmation rate</dt><dd>{total ? `${Math.round(data.outcomes.confirmed / total * 100)}%` : '—'}</dd><small>{data.outcomes.confirmed} confirmed of {total} orders</small></div>
        <div><dt>Awaiting confirmation</dt><dd>{number.format(data.outcomes.pending)}</dd><small>Current pending orders in this period</small></div>
        <div><dt>Connected minutes</dt><dd>{(data.usage.seconds / 60).toFixed(1)}</dd><small>{number.format(data.usage.calls)} Telnyx calls recorded</small></div>
      </dl>
      <div className="analytics-charts-grid">
        <section className="analytics-panel analytics-trend">
          <div className="analytics-section-head"><div><h2>Order activity</h2><p>Daily volume, grouped by creation date and current status.</p></div><span className="chart-unit">Orders</span></div>
          <div className="chart-legend">{segments(data.outcomes).map(part => <span key={part.label}><i className="analytics-key" data-tone={part.tone} />{part.label}</span>)}</div>
          <TrendChart title="Daily order activity" rows={data.daily.map(day => ({ date: day.date, values: [day.confirmed, day.cancelled, day.pending] }))} series={segments(data.outcomes)} />
        </section>
        <section className="analytics-panel analytics-outcomes">
          <h2>Order outcomes</h2><p>Where this period’s orders stand today.</p>
          <OutcomeRing parts={segments(data.outcomes)} />
          <Counts segments={segments(data.outcomes)} />
        </section>
      </div>
      <section className="analytics-panel analytics-call-trend">
        <div className="analytics-section-head"><div><h2>Calling activity</h2><p>Connected Telnyx minutes by call start date.</p></div><span className="chart-unit">{data.usage.calls} calls · {(data.usage.seconds / 60).toFixed(1)} min</span></div>
        <TrendChart title="Daily connected call minutes" unit="minutes" line rows={data.daily.map(day => ({ date: day.date, values: [day.minutes] }))} series={[{label:'Minutes',tone:'positive'}]} />
      </section>
      <div className="analytics-grid">
        <section className="analytics-panel">
          <h2>Confirmation messages</h2>
          <p>First requests queued during the period. Provider acknowledgement records acceptance for sending.</p>
          <div className="delivery-bars">{messages.map(part => <div key={part.label}>
            <div><span>{part.label}</span><strong>{number.format(part.amount)}</strong></div>
            <Bar segments={[part]} max={Math.max(1, ...messages.map(value => value.amount))} />
          </div>)}</div>
        </section>
        <section className="analytics-panel">
          <h2>Order callbacks</h2>
          <p>Requests and recorded outcomes for orders created during the period.</p>
          {(['telnyx', 'whatsapp'] as const).map(channel => {
            const values = data.callbacks[channel]
            const parts = [
              { label: 'Queued or active', amount: values.active, tone: 'waiting' },
              { label: 'Completed', amount: values.completed, tone: 'positive' },
              { label: 'No decision', amount: values.noDecision, tone: 'neutral' },
              { label: 'Needs review', amount: values.review, tone: 'negative' },
            ]
            const count = parts.reduce((sum, part) => sum + part.amount, 0)
            return <div key={channel} className="analytics-channel">
              <h3>{channel === 'telnyx' ? 'Telnyx' : 'WhatsApp'} <span className="badge">{count}</span></h3>
              <Bar segments={parts} max={count} />
              <Counts segments={parts} />
            </div>
          })}
        </section>
        <section className="analytics-panel">
          <h2>Telnyx usage</h2>
          <p>Calls started during the period.</p>
          <dl className="analytics-usage">
            <div><dt>Calls recorded</dt><dd>{number.format(data.usage.calls)}</dd></div>
            <div><dt>Minutes connected</dt><dd>{(data.usage.seconds / 60).toFixed(1)}</dd></div>
            <div><dt>Ended calls awaiting a cost</dt><dd>{number.format(data.usage.pendingCosts)}</dd></div>
            {data.usage.charges.length ? data.usage.charges.map(charge => <div key={charge.currency}><dt>Recorded charges ({charge.currency})</dt><dd>{charge.amount}</dd></div>) : <div><dt>Recorded charges</dt><dd>None</dd></div>}
          </dl>
        </section>
        <div className="analytics-exceptions">
          <OrderLinks title="Failed confirmation messages" rows={data.failed} total={data.invitations.failed} />
          <OrderLinks title="Pending orders" rows={data.pending} total={data.outcomes.pending} />
        </div>
      </div>
    </>}
  </main>
}
