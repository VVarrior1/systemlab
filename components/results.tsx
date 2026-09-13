"use client";
import { useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Ban, Check, CircleAlert, Clock3, CopyX, FileX, GitCompareArrows, History, Hourglass, Info, Merge, Pin, RefreshCw, Repeat, ScanLine, ShieldCheck, Skull, SplitSquareHorizontal, Timer, Unplug, X } from "lucide-react";
import type { SimulationResult, TraceStatus, Workload } from "@/lib/types";

export interface SeedSpread { p95: [number, number, number]; throughput: [number, number, number]; errorRate: [number, number, number] }

export interface AlternativeView {
  id: string;
  title: string;
  rationale: string;
  result: SimulationResult | null;
  comparison: string;
  passed: number;
  total: number;
  error?: string;
}

const traceStatusLabel: Record<TraceStatus, string> = {
  ok: "Processed",
  error: "Request failed",
  hit: "Cache hit",
  miss: "Cache miss",
  bypass: "Write bypasses cache",
  rejected: "Rejected: shed by a limiter, bounded queue, or open circuit",
  timeout: "Timed out waiting on a dependency",
  retry: "Retried after a timeout or failure",
  coalesced: "Coalesced into an in-flight request for the same key",
  stale: "Served a stale cached value",
  "open-circuit": "Circuit open: call skipped without waiting",
  redelivered: "Redelivered after the visibility timeout expired",
  duplicate: "Duplicate: redelivered after the job already completed",
  "dead-letter": "Dead-lettered after too many redeliveries",
  "pool-exhausted": "Rejected: dependency connection pool exhausted",
  "lost-write": "Lost write: leader died before it replicated",
};
const traceStatusIcon: Record<TraceStatus, typeof Check> = {
  ok: Check,
  hit: Check,
  miss: Check,
  bypass: Check,
  error: CircleAlert,
  rejected: Ban,
  timeout: Timer,
  retry: RefreshCw,
  coalesced: Merge,
  stale: History,
  "open-circuit": Unplug,
  redelivered: Repeat,
  duplicate: CopyX,
  "dead-letter": Skull,
  "pool-exhausted": Hourglass,
  "lost-write": FileX,
};

function fmt(value: number, digits: number) {
  return Number(value.toFixed(digits)).toLocaleString();
}

export function Results({ result, baseline, workload, baselineWorkload, onPin, onUnpin, stale, running, alternatives, alternativesLoading, seedSpread }: { result: SimulationResult | null; baseline: SimulationResult | null; workload: Workload | null; baselineWorkload: Workload | null; onPin: () => void; onUnpin: () => void; stale: boolean; running: boolean; alternatives?: AlternativeView[] | null; alternativesLoading?: boolean; seedSpread?: SeedSpread }) {
  const [tab, setTab] = useState("overview");
  const [traceId, setTraceId] = useState(0);
  const [chartMetric, setChartMetric] = useState("p95");
  const differentWorkload = !!baseline && !!workload && !!baselineWorkload && (Object.keys(workload) as (keyof Workload)[]).some((key) => workload[key] !== baselineWorkload[key]);
  const chartLabels: Record<string, string> = { p95: "Response latency", throughput: "Throughput", chartErrorRate: "Error rate", queueDepth: "Waiting requests", rejected: "Rejected requests" };
  const chartUnit = chartMetric === "p95" ? "ms" : chartMetric === "throughput" ? "req/s" : chartMetric === "chartErrorRate" ? "%" : chartMetric === "rejected" ? "req" : "";
  const chartData = result?.samples.map((sample) => ({ ...sample, p95: sample.throughput ? sample.p95 : null, latency: sample.throughput ? sample.latency : null, chartErrorRate: sample.throughput || sample.errorRate ? sample.errorRate * 100 : null, rejected: sample.rejected ?? 0 }));
  const chartScope = chartMetric === "p95" ? "successful responses only" : chartMetric === "queueDepth" ? "waiting requests at each second end" : chartMetric === "chartErrorRate" ? "failures / finished requests in each second" : chartMetric === "rejected" ? "requests shed in each second" : "successful completions in each second";
  const metrics = [
    { label: "P95 LATENCY", value: result?.completed ? result.p95 : null, unit: "ms", previous: baseline?.completed ? baseline.p95 : undefined, lower: true },
    { label: "P99 LATENCY", value: result?.completed ? result.p99 : null, unit: "ms", previous: baseline?.completed ? baseline.p99 : undefined, lower: true },
    { label: "THROUGHPUT", value: result ? result.throughput : null, unit: "req/s", previous: baseline?.throughput, lower: false },
    { label: "ERROR RATE", value: result ? result.errorRate * 100 : null, unit: "%", previous: baseline ? baseline.errorRate * 100 : undefined, lower: true },
    { label: "REJECTED (SHED)", value: result ? result.rejectedRate * 100 : null, unit: "%", previous: baseline ? baseline.rejectedRate * 100 : undefined, lower: true, dim: !!result && result.rejectedRate === 0 },
    { label: "STALE READS", value: result ? result.staleReadRate * 100 : null, unit: "%", previous: baseline ? baseline.staleReadRate * 100 : undefined, lower: true, dim: !!result && result.staleReadRate === 0 },
    { label: "DUPLICATES", value: result ? result.duplicateRate * 100 : null, unit: "%", previous: baseline ? baseline.duplicateRate * 100 : undefined, lower: true, dim: !!result && result.duplicateRate === 0 },
    { label: "DEAD-LETTERED", value: result ? result.deadLetterRate * 100 : null, unit: "%", previous: baseline ? baseline.deadLetterRate * 100 : undefined, lower: true, dim: !!result && result.deadLetterRate === 0 },
    { label: "LOST WRITES", value: result ? result.lostWrites : null, unit: "", previous: baseline?.lostWrites, lower: true, dim: !!result && result.lostWrites === 0 },
    { label: "CONFLICTING WRITES", value: result ? result.conflictingWrites : null, unit: "", previous: baseline?.conflictingWrites, lower: true, dim: !!result && result.conflictingWrites === 0 },
    { label: "EGRESS", value: result ? result.egressGb : null, unit: "GB/h", previous: baseline?.egressGb, lower: true, dim: !!result && result.egressGb === 0 },
    { label: "INFRASTRUCTURE", value: result ? result.cost : null, unit: "credits", previous: baseline?.cost, lower: true, breakdown: result?.costBreakdown, extraCostRows: result ? [{ label: "Storage", cost: result.storageCost }, { label: "Egress", cost: result.egressCost }].filter((row) => row.cost > 0) : undefined, sub: result ? `${fmt(result.provisionedCost, 1)} provisioned + ${fmt(result.usageCost, 1)} usage` : undefined },
  ];
  const trace = result?.traces[traceId] ?? result?.traces[0];
  return <section className="results-section" aria-label="Simulation results">
    <div className="results-top"><div className="results-tabs" role="tablist" aria-label="Results views">{[{ id: "overview", name: "Overview" }, { id: "insights", name: "Insights" }, { id: "traces", name: "Request traces" }, { id: "alternatives", name: "Alternatives" }, { id: "model", name: "Model" }].map((item) => <button role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)} key={item.id}>{item.name}{item.id === "insights" && !!result?.insights.length && <span>{result.insights.length}</span>}{item.id === "alternatives" && !!alternatives?.length && <span>{alternatives.length}</span>}</button>)}</div><div className="results-meta">{!stale && result ? <span className="run-seed">SEED {result.seed}</span> : null}<button className="text-button" disabled={!result || running || stale} onClick={onPin}><Pin size={13} />Pin baseline</button></div></div>
    {stale && <div className="results-stale" role="status">Previous run: architecture or traffic has changed. These measurements are not current.</div>}
    {baseline && <div className="baseline-banner"><GitCompareArrows size={14} /><span>Comparing with baseline: {baseline.completed ? Math.round(baseline.p95) : "--"} ms p95 / {Math.round(baseline.throughput)} req/s</span><button className="icon-button" aria-label="Remove baseline" onClick={onUnpin}><X size={14} /></button></div>}
    {differentWorkload && <div className="results-stale" role="status">Different workload or seed: these deltas do not isolate the effect of architecture changes.</div>}
    {tab === "overview" && <div role="tabpanel"><div className="metric-grid">{metrics.map((metric) => { const diff = metric.value !== null && metric.previous !== undefined ? metric.value - metric.previous : null; const good = diff !== null && (metric.lower ? diff < 0 : diff > 0); return <div className={`metric${metric.dim ? " dim" : ""}`} key={metric.label}><span className="metric-label">{metric.label}</span><div><strong>{metric.value === null ? "--" : fmt(metric.value, metric.unit === "%" || metric.unit === "credits" ? 1 : 0)}</strong><span className="metric-unit">{metric.unit}</span>{diff !== null && Math.abs(diff) > 0.05 && <span className={`metric-delta ${differentWorkload ? "" : good ? "good" : "bad"}`} title={`${diff > 0 ? "+" : ""}${diff.toFixed(1)} ${metric.unit === "%" ? "percentage points" : metric.unit} versus baseline`}>{diff < 0 ? <ArrowDownRight size={12} /> : <ArrowUpRight size={12} />}{Math.abs(diff).toFixed(1)}{metric.unit === "%" ? " pp" : ""}</span>}</div>{"sub" in metric && metric.sub && <span className="metric-sub">{metric.sub}</span>}{"breakdown" in metric && metric.breakdown && metric.breakdown.length > 0 && <details className="cost-breakdown"><summary>Cost breakdown</summary><ul>{metric.breakdown.map((line) => <li key={line.nodeId}><span>{line.label}</span><span className="mono">{fmt(line.cost, 1)}{typeof line.usage === "number" && line.usage > 0 && <span className="cost-usage"> ({fmt(line.usage, 1)} usage)</span>}</span></li>)}{"extraCostRows" in metric && metric.extraCostRows?.map((row) => <li key={row.label} className="cost-row-usage"><span>{row.label}</span><span className="mono">{fmt(row.cost, 1)}</span></li>)}</ul></details>}</div>; })}</div>
      {seedSpread && <div className="seed-spread" role="note"><div className="seed-spread-heading"><SplitSquareHorizontal size={13} /><span>Variance across 5 seeds</span></div><div className="seed-spread-grid">
        <div><span className="seed-spread-label">P95</span><span className="seed-spread-values"><span title="Minimum">{fmt(seedSpread.p95[0], 0)}</span><span title="Median">{fmt(seedSpread.p95[1], 0)}</span><span title="Maximum">{fmt(seedSpread.p95[2], 0)}</span></span><span className="seed-spread-caption">min / median / max, ms</span></div>
        <div><span className="seed-spread-label">Throughput</span><span className="seed-spread-values"><span title="Minimum">{fmt(seedSpread.throughput[0], 0)}</span><span title="Median">{fmt(seedSpread.throughput[1], 0)}</span><span title="Maximum">{fmt(seedSpread.throughput[2], 0)}</span></span><span className="seed-spread-caption">min / median / max, req/s</span></div>
        <div><span className="seed-spread-label">Error rate</span><span className="seed-spread-values"><span title="Minimum">{fmt(seedSpread.errorRate[0] * 100, 1)}</span><span title="Median">{fmt(seedSpread.errorRate[1] * 100, 1)}</span><span title="Maximum">{fmt(seedSpread.errorRate[2] * 100, 1)}</span></span><span className="seed-spread-caption">min / median / max, %</span></div>
      </div><p className="seed-spread-note">A design is a distribution, not a single number — objectives must hold on every assessment seed, not just this one.</p></div>}
      <div className="chart-header"><select aria-label="Chart metric" value={chartMetric} onChange={(e) => setChartMetric(e.target.value)}>{Object.entries(chartLabels).map(([key, label]) => <option key={key} value={key}>{label} over time</option>)}</select><div><span className="chart-key p95" />{chartMetric === "p95" ? "95th percentile" : chartLabels[chartMetric]}{chartMetric === "p95" && <><span className="chart-key mean" />Mean</>}</div></div>
      <div className="chart-area">{result ? <ResponsiveContainer width="100%" height="100%" minWidth={0}><ComposedChart data={chartData} margin={{ top: 8, right: 18, left: 3, bottom: 0 }}><defs><linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#23977e" stopOpacity={0.14} /><stop offset="100%" stopColor="#23977e" stopOpacity={0.01} /></linearGradient></defs><CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e8edef" /><XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#748289" }} tickFormatter={(v) => `${v}s`} minTickGap={30} /><YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#748289" }} width={57} tickFormatter={(v) => `${v}${chartUnit}`} /><Tooltip contentStyle={{ fontSize: 12, border: "1px solid #e1e7e8", borderRadius: 6 }} labelFormatter={(v) => `${v} seconds`} formatter={(v, name) => [`${Number(v).toFixed(1)} ${chartUnit}`, name === "latency" ? "Mean" : name === "p95" ? "95th percentile" : chartLabels[String(name)]]} /><Area dataKey={chartMetric} stroke="#238b73" fill="url(#latencyFill)" strokeWidth={2} isAnimationActive={false} />{chartMetric === "p95" && <Line dataKey="latency" stroke="#8ba9bf" strokeWidth={1.5} dot={false} isAnimationActive={false} />}</ComposedChart></ResponsiveContainer> : <div className="chart-empty"><ScanLine size={22} /><span>{running ? "Measuring request behavior..." : "Run your architecture to see its behavior."}</span></div>}</div><div className="chart-footnote"><Clock3 size={12} />{result ? `${result.requestCount.toLocaleString()} requests / ${result.duration}s workload + drain / ${chartScope}` : "No requests have been simulated yet."}</div>
    </div>}
    {tab === "insights" && <div role="tabpanel">{result && result.events.length > 0 && <div className="events-timeline"><span className="field-label">Timeline</span><div className="events-list">{result.events.map((event, i) => <div className="event-row" key={i}><Activity size={13} /><span className="mono event-time">{Math.round(event.time)}s</span><div><strong>{event.title}</strong><p>{event.detail}</p></div></div>)}</div></div>}
      <div className="insights-list">{result ? result.insights.map((insight, i) => <div className={`insight ${insight.severity}`} key={i}>{insight.severity === "good" ? <ShieldCheck size={18} /> : <CircleAlert size={18} />}<div><strong>{insight.title}</strong><p>{insight.detail}</p></div></div>) : <div className="panel-empty">Run a simulation to investigate your system.</div>}</div>
    </div>}
    {tab === "traces" && <div className="traces-panel" role="tabpanel">{result && trace ? <><div className="trace-selector"><label htmlFor="request-trace">Request</label><select id="request-trace" value={Math.min(traceId, result.traces.length - 1)} onChange={(e) => setTraceId(Number(e.target.value))}>{result.traces.map((t, i) => <option value={i} key={`${t.id}-${i}`}>#{t.id} / {Math.round(t.latency)} ms / {t.success ? "success" : "failed"}</option>)}</select><span className={`status-chip ${trace.success ? "success" : "failed"}`}>{trace.success ? "Completed" : "Failed"}</span></div><div className="trace-steps">{trace.steps.map((step, i) => { const StatusIcon = traceStatusIcon[step.status]; return <div className="trace-step" key={i}><span className="trace-index">{i + 1}</span><div><strong>{step.label}{step.replica ? ` / replica ${step.replica}` : ""}</strong><span>{traceStatusLabel[step.status]}</span></div><span className="mono">{step.duration.toFixed(1)} ms</span><StatusIcon size={14} /></div>; })}</div><p className="trace-summary">End-to-end latency <strong>{trace.latency.toFixed(1)} ms</strong></p></> : <div className="panel-empty">Request traces will appear after a simulation.</div>}</div>}
    {tab === "alternatives" && <div className="alternatives-panel" role="tabpanel">{alternativesLoading ? <div className="panel-empty"><ArrowRight size={16} className="spin" /><span>Running alternative designs on your workload...</span></div> : alternatives && alternatives.length > 0 ? <div className="alt-table-wrap"><table className="alt-table"><thead><tr><th>Design</th><th title="Hover a cost to see its provisioned vs. usage split">Cost</th><th>P95</th><th>Error rate</th><th>Rejected</th><th>Objectives</th></tr></thead><tbody>
      <tr className="alt-row-you"><td><strong>Your design</strong><span className="alt-rationale">The architecture you built.</span></td><td className="mono" title={result ? `${fmt(result.provisionedCost, 1)} provisioned + ${fmt(result.usageCost, 1)} usage` : undefined}>{result ? fmt(result.cost, 1) : "--"}</td><td className="mono">{result?.completed ? `${Math.round(result.p95)} ms` : "--"}</td><td className="mono">{result ? `${(result.errorRate * 100).toFixed(1)}%` : "--"}</td><td className="mono">{result ? `${(result.rejectedRate * 100).toFixed(1)}%` : "--"}</td><td className="mono">--</td></tr>
      {alternatives.map((alt) => <tr key={alt.id}><td><strong>{alt.title}</strong><span className="alt-rationale">{alt.rationale}</span>{alt.comparison && <p className="alt-comparison">{alt.comparison}</p>}</td>{alt.error || !alt.result ? <td colSpan={5} className="alt-error"><CircleAlert size={13} />{alt.error ?? "Could not simulate this alternative."}</td> : <><td className="mono" title={`${fmt(alt.result.provisionedCost, 1)} provisioned + ${fmt(alt.result.usageCost, 1)} usage`}>{fmt(alt.result.cost, 1)}</td><td className="mono">{alt.result.completed ? `${Math.round(alt.result.p95)} ms` : "--"}</td><td className="mono">{`${(alt.result.errorRate * 100).toFixed(1)}%`}</td><td className="mono">{`${(alt.result.rejectedRate * 100).toFixed(1)}%`}</td><td className="mono">{alt.passed}/{alt.total}</td></>}</tr>)}
    </tbody></table></div> : <div className="panel-empty">Alternative designs appear here after you run Check solution. They compare your architecture against a scaled bottleneck, an added cache, trimmed replicas, and the reference design.</div>}</div>}
    {tab === "model" && <div className="model-panel" role="tabpanel"><div className="model-intro"><Info size={18} /><div><strong>A model you can inspect</strong><p>Results describe this simulation, not a benchmark of a cloud provider. Credits are teaching units.</p></div></div><ul>{(result?.assumptions ?? ["Seeded request arrivals make experiments repeatable.", "Direct application endpoints reach replica 1 only. Load balancers round-robin across healthy application replicas. No client-side discovery or hidden routing is assumed.", "Worker replicas pull queued jobs. Databases, caches, and balancers are idealized managed pools, not simulations of real replication protocols.", "Read cache hits skip downstream storage. Writes always continue.", "Network partitions, data consistency, and real infrastructure billing are not modeled."]).map((a) => <li key={a}>{a}</li>)}</ul></div>}
  </section>;
}
