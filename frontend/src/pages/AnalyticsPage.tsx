import { useState, useEffect, useCallback } from 'react'
// import { useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
   RefreshCw, Zap, Clock, AlertTriangle,
  MessageSquare, TrendingUp, CheckCircle, XCircle, AlertCircle,
} from 'lucide-react'
// import { useAuth } from '../context/AuthContext'
import { apiFetch } from '../api/client'
import {AdminHeader} from '../components/adminHeader'
// ---------- types ----------
interface QueryLog {
  id: string
  session_id: string
  question: string
  chunks_retrieved: number
  top_chunk_score: number
  final_answer: string
  latency_ms: number
  escalated: boolean
  created_at: string
}

interface AnalyticsData {
  total_queries: number
  avg_latency_ms: number
  escalation_rate: string
  no_context_rate: string
  top_questions: { question: string; count: number }[]
  recent_queries: QueryLog[]
}

// ---------- helpers ----------
const NO_CONTEXT = "I don't have that information, please contact our sales team."

function statusOf(log: QueryLog): 'answered' | 'escalated' | 'no-context' {
  if (log.escalated) return 'escalated'
  if (log.final_answer === NO_CONTEXT) return 'no-context'
  return 'answered'
}

function fmt(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// bucket recent_queries into last-7-day bars
function buildDailyBars(logs: QueryLog[]) {
  const days: Record<string, { day: string; answered: number; escalated: number }> = {}
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    days[key] = { day: labels[d.getDay()], answered: 0, escalated: 0 }
  }
  for (const log of logs) {
    const key = log.created_at.slice(0, 10)
    if (!days[key]) continue
    if (log.escalated) days[key].escalated++
    else days[key].answered++
  }
  return Object.values(days)
}

// mock latency trend (real data would need p50/p95 from backend)
function buildLatencyTrend(logs: QueryLog[]) {
  const days: Record<string, number[]> = {}
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    days[d.toISOString().slice(0, 10)] = []
  }
  for (const log of logs) {
    const key = log.created_at.slice(0, 10)
    if (days[key]) days[key].push(log.latency_ms)
  }
  return Object.entries(days).map(([date, vals]) => {
    const sorted = [...vals].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
    const d = new Date(date)
    return { day: labels[d.getDay()], p50, p95 }
  })
}

// ---------- sub-components ----------
interface KpiCardProps {
  label: string
  value: string | number
  sub?: string
  accent?: 'default' | 'danger' | 'warning' | 'success'
  icon: React.ReactNode
}

function KpiCard({ label, value, sub, accent = 'default', icon }: KpiCardProps) {
  const valueColor =
    accent === 'danger' ? 'text-red-500' :
    accent === 'warning' ? 'text-amber-500' :
    accent === 'success' ? 'text-green-500' :
    'text-accent'

  return (
    <div className="rounded-xl bg-surface border border-border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-ui text-xs text-text-hint uppercase tracking-widest">{label}</span>
        <span className={`${valueColor} opacity-80`}>{icon}</span>
      </div>
      <div>
        <p className={`font-ui text-2xl font-medium ${valueColor}`}>{value}</p>
        {sub && <p className="font-ui text-xs text-text-hint mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: 'answered' | 'escalated' | 'no-context' }) {
  if (status === 'answered')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-950/30 px-2 py-0.5 font-ui text-xs text-green-600 dark:text-green-400">
        <CheckCircle className="h-3 w-3" strokeWidth={2} /> Answered
      </span>
    )
  if (status === 'escalated')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-950/30 px-2 py-0.5 font-ui text-xs text-red-500">
        <XCircle className="h-3 w-3" strokeWidth={2} /> Escalated
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 font-ui text-xs text-amber-600 dark:text-amber-400">
      <AlertCircle className="h-3 w-3" strokeWidth={2} /> No context
    </span>
  )
}

// Custom tooltip for recharts
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 shadow-lg">
      <p className="font-ui text-xs text-text-hint mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} className="font-ui text-xs font-medium" style={{ color: p.color }}>
          {p.name}: {p.value}{p.name.includes('p') ? 'ms' : ''}
        </p>
      ))}
    </div>
  )
}

// ---------- main page ----------
export function AnalyticsPage() {
  // const navigate = useNavigate()
  // const { user } = useAuth()
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [logs, setLogs] = useState<QueryLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  //const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (silent = false) => {
  if (!silent) setLoading(true)
  //else setRefreshing(true)
  setError('')
  try {
    const analyticsData = await apiFetch<AnalyticsData>('/api/chat/analytics')
    setData(analyticsData)
    setLogs(analyticsData.recent_queries ?? [])
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Something went wrong')
  } finally {
    setLoading(false)
    //setRefreshing(false)
  }
}, [])

  useEffect(() => { load() }, [load])

  const dailyBars = buildDailyBars(logs)
  const latencyTrend = buildLatencyTrend(logs)
  const maxCount = data?.top_questions?.[0]?.count ?? 1

  return (
    <div className="flex min-h-full flex-col bg-background">

      {/* header */}
      <AdminHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-6">

        {error && (
          <p className="mb-6 rounded-lg bg-red-50 px-4 py-3 font-ui text-sm text-red-600">{error}</p>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <RefreshCw className="h-6 w-6 animate-spin text-accent" strokeWidth={2} />
          </div>
        ) : (
          <>
            {/* KPI row */}
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <KpiCard
                label="Total queries"
                value={data?.total_queries.toLocaleString() ?? '—'}
                sub="All time"
                icon={<MessageSquare className="h-4 w-4" strokeWidth={2} />}
              />
              <KpiCard
                label="Avg latency"
                value={data ? fmt(data.avg_latency_ms) : '—'}
                sub="Per query"
                accent="default"
                icon={<Clock className="h-4 w-4" strokeWidth={2} />}
              />
              <KpiCard
                label="Escalation rate"
                value={data?.escalation_rate ?? '—'}
                sub="Routed to agent"
                accent="danger"
                icon={<AlertTriangle className="h-4 w-4" strokeWidth={2} />}
              />
              <KpiCard
                label="No-context rate"
                value={data?.no_context_rate ?? '—'}
                sub="Bot couldn't answer"
                accent="warning"
                icon={<Zap className="h-4 w-4" strokeWidth={2} />}
              />
              <KpiCard
                label="Pipeline"
                value="Active"
                sub="Hybrid + Rerank"
                accent="success"
                icon={<TrendingUp className="h-4 w-4" strokeWidth={2} />}
              />
            </div>

            {/* charts row */}
            <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">

              {/* daily volume */}
              <div className="rounded-xl border border-border bg-surface p-5">
                <p className="mb-4 font-ui text-sm font-medium text-text-primary">Queries per day</p>
                <div className="mb-3 flex gap-4">
                  <span className="flex items-center gap-1.5 font-ui text-xs text-text-hint">
                    <span className="inline-block h-2 w-2 rounded-sm bg-accent" /> Answered
                  </span>
                  <span className="flex items-center gap-1.5 font-ui text-xs text-text-hint">
                    <span className="inline-block h-2 w-2 rounded-sm bg-red-400" /> Escalated
                  </span>
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={dailyBars} barSize={18} barGap={4}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--color-text-hint, #9ca3af)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-hint, #9ca3af)' }} axisLine={false} tickLine={false} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                    <Bar dataKey="answered" stackId="a" fill="#2DD4BF" radius={[0, 0, 0, 0]} name="Answered" />
                    <Bar dataKey="escalated" stackId="a" fill="#f87171" radius={[3, 3, 0, 0]} name="Escalated" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* latency trend */}
              <div className="rounded-xl border border-border bg-surface p-5">
                <p className="mb-4 font-ui text-sm font-medium text-text-primary">Latency trend</p>
                <div className="mb-3 flex gap-4">
                  <span className="flex items-center gap-1.5 font-ui text-xs text-text-hint">
                    <span className="inline-block h-2 w-2 rounded-sm bg-accent" /> p50
                  </span>
                  <span className="flex items-center gap-1.5 font-ui text-xs text-text-hint">
                    <span className="inline-block h-2 w-2 rounded-sm bg-amber-400" /> p95
                  </span>
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={latencyTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--color-text-hint, #9ca3af)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-hint, #9ca3af)' }} axisLine={false} tickLine={false} tickFormatter={v => `${v}ms`} />
                    <Tooltip content={<ChartTooltip />} />
                    <Line type="monotone" dataKey="p50" stroke="#2DD4BF" strokeWidth={2} dot={{ r: 3, fill: '#2DD4BF' }} name="p50" />
                    <Line type="monotone" dataKey="p95" stroke="#fbbf24" strokeWidth={2} dot={{ r: 3, fill: '#fbbf24' }} name="p95" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* top questions (full width) */}
            <div className="mb-6 rounded-xl border border-border bg-surface overflow-hidden">
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <div className="flex items-center gap-2">
                  <p className="font-ui text-sm font-medium text-text-primary">Top questions</p>
                  {data?.top_questions?.length ? (
                    <span className="rounded-full bg-surface-muted px-2 py-0.5 font-ui text-xs text-text-hint">
                      {data.top_questions.length} tracked
                    </span>
                  ) : null}
                </div>
                <span className="font-ui text-xs text-text-hint">Last 7 days</span>
              </div>

              {data?.top_questions?.length ? (
                <div
                  className={`grid grid-cols-1 ${
                    data.top_questions.length > 1
                      ? 'lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border'
                      : ''
                  }`}
                >
                  <ul className="divide-y divide-border">
                    {data.top_questions.slice(0, Math.ceil(data.top_questions.length / 2)).map((q, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-muted/40"
                      >
                        <span
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-ui text-xs ${
                            i === 0
                              ? 'bg-accent/15 font-semibold text-accent'
                              : 'bg-surface-muted font-normal text-text-hint'
                          }`}
                        >
                          {i + 1}
                        </span>
                        <span className="flex-1 truncate font-ui text-xs text-text-secondary" title={q.question}>
                          {q.question}
                        </span>
                        <div className="flex shrink-0 items-center gap-2.5">
                          <div className="h-1.5 w-20 sm:w-28 overflow-hidden rounded-full bg-surface-muted">
                            <div
                              className="h-full rounded-full bg-accent transition-all duration-300"
                              style={{ width: `${Math.round((q.count / maxCount) * 100)}%` }}
                            />
                          </div>
                          <span className="w-8 text-right font-mono font-ui text-xs text-text-hint">{q.count}</span>
                        </div>
                      </li>
                    ))}
                  </ul>

                  {data.top_questions.length > 1 ? (
                    <ul className="divide-y divide-border">
                      {data.top_questions.slice(Math.ceil(data.top_questions.length / 2)).map((q, i) => {
                        const rank = Math.ceil(data.top_questions.length / 2) + i + 1
                        return (
                          <li
                            key={rank}
                            className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-muted/40"
                          >
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-muted font-ui text-xs font-normal text-text-hint">
                              {rank}
                            </span>
                            <span className="flex-1 truncate font-ui text-xs text-text-secondary" title={q.question}>
                              {q.question}
                            </span>
                            <div className="flex shrink-0 items-center gap-2.5">
                              <div className="h-1.5 w-20 sm:w-28 overflow-hidden rounded-full bg-surface-muted">
                                <div
                                  className="h-full rounded-full bg-accent transition-all duration-300"
                                  style={{ width: `${Math.round((q.count / maxCount) * 100)}%` }}
                                />
                              </div>
                              <span className="w-8 text-right font-mono font-ui text-xs text-text-hint">{q.count}</span>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                </div>
              ) : (
                <p className="px-5 py-8 text-center font-ui text-xs text-text-hint">No data yet</p>
              )}
            </div>

            {/* recent queries table */}
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <p className="font-ui text-sm font-medium text-text-primary">Recent queries</p>
                <span className="font-ui text-xs text-text-hint">Last 20</span>
              </div>
              {logs.length === 0 ? (
                <p className="px-5 py-8 text-center font-ui text-xs text-text-hint">No queries logged yet</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        {['Question', 'Session', 'Chunks', 'Latency', 'Status', 'Time'].map(h => (
                          <th key={h} className="px-5 py-2.5 text-left font-ui text-xs text-text-hint font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {logs.map(log => (
                        <tr key={log.id} className="transition-colors hover:bg-surface-muted">
                          <td className="px-5 py-3 font-ui text-xs text-text-primary max-w-xs truncate">{log.question}</td>
                          <td className="px-5 py-3 font-ui text-xs text-text-hint font-mono">{log.session_id.slice(0, 8)}…</td>
                          <td className="px-5 py-3 font-ui text-xs text-text-secondary">{log.chunks_retrieved}</td>
                          <td className="px-5 py-3 font-ui text-xs text-text-secondary">{fmt(log.latency_ms)}</td>
                          <td className="px-5 py-3"><StatusBadge status={statusOf(log)} /></td>
                          <td className="px-5 py-3 font-ui text-xs text-text-hint whitespace-nowrap">{timeAgo(log.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}