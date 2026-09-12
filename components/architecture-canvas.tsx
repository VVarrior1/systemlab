"use client";
import { memo, useMemo, useState, type DragEvent } from "react";
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps, type Connection, type NodeChange, type NodePositionChange } from "@xyflow/react";
import { Activity, ArrowRight, Boxes, Copy, Database, Fingerprint, Gauge, Globe, Globe2, Layers3, Maximize, Network, Plus, Redo2, Repeat, RotateCcw, RotateCw, Server, ShieldAlert, Timer, Trash2, Undo2, Workflow, X, Zap } from "lucide-react";
import type { Architecture, NodeKind, NodeMetric, SimulationResult, SystemNode } from "@/lib/types";
import { componentCatalog, createSystemNode, normalizeNode } from "@/lib/templates";
import { componentCost, nodeCost } from "@/lib/cost";
import { LIMITS } from "@/lib/simulation/validate";
import { useEditor } from "@/lib/editor-store";
import { Tip } from "./ui";

export const kindIcons = { traffic: Globe2, server: Server, "load-balancer": Network, database: Database, cache: Zap, queue: Layers3, cdn: Globe, "rate-limiter": Gauge };
const kindLabels: Record<NodeKind, string> = { traffic: "TRAFFIC SOURCE", server: "APPLICATION", "load-balancer": "LOAD BALANCER", database: "DATABASE", cache: "CACHE", queue: "MESSAGE QUEUE", cdn: "CDN EDGE", "rate-limiter": "RATE LIMITER" };
type FlowData = { system: SystemNode; metric?: NodeMetric; running: boolean; selected: boolean; requestRate: number; balanced: boolean };
type FlowNode = Node<FlowData, "system">;

/** Left/right values for the node card's one glance-able line, per kind. */
function specLine(node: SystemNode, settings: ReturnType<typeof normalizeNode>, requestRate: number): [string, string] {
  switch (node.kind) {
    case "traffic": return [`${requestRate} req/s`, "HTTP"];
    case "server": return [`${node.capacity} req/s each`, node.replicas > 1 ? `${node.replicas} replicas` : `${node.latency} ms`];
    case "load-balancer": return [settings.algorithm === "least-connections" ? "Least connections" : "Round robin", settings.healthCheckMs > 0 ? `${settings.healthCheckMs}ms checks` : "instant failover"];
    case "database":
      if (settings.dbMode === "sharded") return ["Sharded", `${settings.shards} shards`];
      if (settings.dbMode === "leader-follower") return ["Leader + followers", `${settings.replicationLagMs}ms lag`];
      if (settings.dbMode === "quorum") return [`Quorum W${settings.quorumWrite}/R${settings.quorumRead}`, `of ${node.replicas} replicas`];
      return ["Single pool", node.replicas > 1 ? `${node.replicas} replicas` : `${node.capacity} req/s`];
    case "cache":
      if (settings.cacheModel === "keyed") return [`${settings.cacheEntries.toLocaleString()} entries`, settings.ttlMs > 0 ? `${settings.ttlMs}ms TTL${settings.coalesce ? " · coalesce" : ""}` : "no TTL"];
      return [`${Math.round(node.cacheHitRate * 100)}% hit rate`, settings.warmupSeconds > 0 ? `${settings.warmupSeconds}s warm-up` : "probabilistic"];
    case "rate-limiter": return [`${settings.limit} req/s limit`, `${settings.burst} burst`];
    case "cdn": return [`${Math.round(node.cacheHitRate * 100)}% hit rate`, "edge cache"];
    case "queue": return [`${node.capacity} req/s`, settings.maxQueue > 0 ? `${settings.maxQueue} bound` : "unbounded"];
    default: return [`${node.capacity} req/s`, `${node.replicas} replicas`];
  }
}
/** Server-only badges surfacing resilience settings that are actually turned on. */
function serverBadges(node: SystemNode, settings: ReturnType<typeof normalizeNode>) {
  const badges: { icon: typeof Timer; label: string }[] = [];
  if (settings.timeoutMs > 0) badges.push({ icon: Timer, label: `${settings.timeoutMs}ms timeout` });
  if (settings.retries > 0) badges.push({ icon: RotateCw, label: `${settings.retries}× retry` });
  if (settings.circuitBreaker) badges.push({ icon: ShieldAlert, label: "breaker" });
  if (settings.maxQueue > 0) badges.push({ icon: Layers3, label: `${settings.maxQueue} queue` });
  if (settings.poolSize > 0) badges.push({ icon: Boxes, label: `pool ${settings.poolSize}` });
  if (node.role === "worker" && settings.idempotent) badges.push({ icon: Fingerprint, label: "idempotent" });
  return badges;
}
/** Queue badges: at-least-once delivery is the setting worth surfacing at a glance. */
function queueBadges(settings: ReturnType<typeof normalizeNode>) {
  const badges: { icon: typeof Timer; label: string }[] = [];
  if (settings.ackMode === "at-least-once") badges.push({ icon: Repeat, label: `at-least-once, ${settings.maxDeliveries} deliveries` });
  return badges;
}

const SystemFlowNode = memo(function SystemFlowNode({ data }: NodeProps<FlowNode>) {
  const { system: node, metric } = data;
  const Icon = kindIcons[node.kind];
  const settings = useMemo(() => normalizeNode(node), [node]);
  const utilization = metric?.replicas?.length ? Math.max(...metric.replicas.map((replica) => replica.utilization)) : metric?.utilization ?? 0;
  const hot = utilization > 0.85;
  const directEndpointFailed = node.kind === "server" && node.role !== "worker" && !data.balanced && metric?.healthyReplicas !== undefined && metric.healthyReplicas < node.replicas;
  const offline = !node.enabled || metric?.healthyReplicas === 0 || directEndpointFailed;
  const [left, right] = specLine(node, settings, data.requestRate);
  const badges = node.kind === "server" ? serverBadges(node, settings) : node.kind === "queue" ? queueBadges(settings) : [];
  const regionTag = node.region && node.region !== "primary" ? node.region : null;
  return <div className={`system-node node-${node.kind} ${data.selected ? "node-selected" : ""} ${offline ? "node-disabled" : ""}`}>
    {node.kind !== "traffic" && <Handle type="target" position={Position.Left} className="node-handle" />}
    {regionTag && <span className="node-region-tag" title={`Region: ${regionTag}`}>{regionTag}</span>}
    <div className="node-topline"><span className="node-kind">{node.role === "worker" ? "BACKGROUND WORKER" : kindLabels[node.kind]}</span><span className={`node-status ${offline ? "offline" : hot ? "busy" : ""}`} /></div>
    <div className="node-identity"><span className="node-icon"><Icon size={20} strokeWidth={1.65} /></span><strong>{node.label}</strong></div>
    <div className="node-spec"><span>{left}</span><span>{right}</span></div>
    {badges.length > 0 && <div className="node-badges">{badges.map((b) => <span className="node-badge" key={b.label}><b.icon size={9} strokeWidth={2} />{b.label}</span>)}</div>}
    {node.kind === "database" && metric?.shards && metric.shards.length > 0 && <div className="node-shards" title="Per-shard utilization">{metric.shards.map((u, i) => <span key={i} className={u > 0.85 ? "hot" : ""} style={{ height: `${Math.max(10, Math.min(100, u * 100))}%` }} />)}</div>}
    {node.kind !== "traffic" && <div className="node-utilization"><div className="node-utilization-track"><span className={hot ? "hot" : ""} style={{ width: `${Math.min(100, utilization * 100)}%` }} /></div><span>{offline ? "Unavailable" : metric ? `${Math.round(utilization * 100)}% ${node.replicas > 1 ? "busiest replica" : "utilization"}` : "Not measured"}</span></div>}
    <Handle type="source" position={Position.Right} className="node-handle" />
  </div>;
});
const nodeTypes = { system: SystemFlowNode };

/** What Connect-to should offer, per §the v2 routing rules in lib/simulation/validate.ts. */
const entryKinds: NodeKind[] = ["server", "load-balancer", "cdn", "rate-limiter"];
const dependencyKinds: NodeKind[] = ["cache", "database", "queue", "server", "rate-limiter"];
function connectionOptions(selected: SystemNode, architecture: Architecture): { targets: SystemNode[]; limitNote?: string } | null {
  if (selected.kind === "database") return null;
  const outCount = architecture.edges.filter((e) => e.source === selected.id).length;
  const already = (id: string) => architecture.edges.some((e) => e.source === selected.id && e.target === id);
  const isEntry = (n: SystemNode) => entryKinds.includes(n.kind) && !(n.kind === "server" && n.role === "worker") && n.id !== selected.id;
  if (selected.kind === "traffic") return { targets: architecture.nodes.filter((n) => isEntry(n) && !already(n.id)) };
  if (selected.kind === "cdn" || selected.kind === "rate-limiter") {
    if (outCount >= 1) return { targets: [], limitNote: "Already forwarding to one entry point." };
    return { targets: architecture.nodes.filter(isEntry) };
  }
  if (selected.kind === "load-balancer") return { targets: architecture.nodes.filter((n) => n.kind === "server" && n.role !== "worker" && !already(n.id)) };
  if (selected.kind === "cache") {
    if (outCount >= 1) return { targets: [], limitNote: "Already routes misses to one database." };
    return { targets: architecture.nodes.filter((n) => n.kind === "database") };
  }
  if (selected.kind === "queue") {
    if (outCount >= 1) return { targets: [], limitNote: "Already feeding one worker." };
    return { targets: architecture.nodes.filter((n) => n.kind === "server" && n.role === "worker") };
  }
  // server: up to LIMITS.dependencies calls to caches, databases, queues, rate limiters or other application servers.
  if (outCount >= LIMITS.dependencies) return { targets: [], limitNote: `Servers call at most ${LIMITS.dependencies} dependencies.` };
  const isDependency = (n: SystemNode) => dependencyKinds.includes(n.kind) && !(n.kind === "server" && n.role === "worker") && n.id !== selected.id;
  return { targets: architecture.nodes.filter((n) => isDependency(n) && !already(n.id)) };
}
function routingNote(selected: SystemNode, selectedBalanced: boolean | undefined): string {
  switch (selected.kind) {
    case "traffic": return "Traffic may fan out to several entry points at once — servers, load balancers, CDNs or rate limiters.";
    case "cdn": return "Serves cacheable reads at the edge, in the request's region; misses forward to exactly one entry point.";
    case "rate-limiter": return "Token bucket: refills at the limit and can burst up to the bucket size, then sheds fast. Forwards accepted traffic to exactly one entry point.";
    case "load-balancer": return "Distributes across every healthy application replica on the chosen algorithm; a dead replica is detected on the health-check interval.";
    case "queue": return "Buffers jobs for one worker's replicas; a queue bound sheds overflow instead of growing forever.";
    case "server": return selected.role === "worker" ? "Queue consumer: replicas pull jobs from the connected queue and share its backlog." : selectedBalanced ? "Load-balancer connections route to individual healthy replicas. Direct connections still target replica 1." : "Direct endpoint: only replica 1 receives requests. No implicit load balancing or failover.";
    case "database": return "Idealized managed pool: equivalent read/write capacity and immediate failover. Not a primary/read-replica database model.";
    case "cache": return "Sits in front of exactly one database; misses and writes pass through, and a keyed cache can coalesce concurrent misses for the same key into one origin fetch.";
    default: return "";
  }
}

function Canvas({ result, running, allowedKinds, onReset }: { result: SimulationResult | null; running: boolean; allowedKinds: NodeKind[]; onReset: () => void }) {
  const { architecture, workload, selectedId, select, setArchitecture, updateNode, past, future, undo, redo } = useEditor();
  const [palette, setPalette] = useState(false);
  const [notice, setNotice] = useState("");
  const { screenToFlowPosition, fitView } = useReactFlow();
  const selected = architecture.nodes.find((n) => n.id === selectedId);
  const selectedSettings = useMemo(() => selected ? normalizeNode(selected) : null, [selected]);
  const selectedMetric = result?.nodes.find((node) => node.nodeId === selectedId);
  const selectedBalanced = selected && architecture.edges.some((edge) => edge.target === selected.id && architecture.nodes.some((node) => node.id === edge.source && node.kind === "load-balancer"));
  const connectOptions = selected ? connectionOptions(selected, architecture) : null;
  const nodes = useMemo(() => architecture.nodes.map((system) => ({ id: system.id, type: "system" as const, position: system.position, selected: selectedId === system.id, deletable: system.kind !== "traffic", data: { system, metric: result?.nodes.find((n) => n.nodeId === system.id), running, selected: selectedId === system.id, requestRate: workload.requestRate, balanced: architecture.edges.some((edge) => edge.target === system.id && architecture.nodes.some((node) => node.id === edge.source && node.kind === "load-balancer")) } })), [architecture.nodes, architecture.edges, selectedId, result, running, workload.requestRate]);
  const edges = useMemo(() => architecture.edges.map((edge) => ({ ...edge, type: "smoothstep", animated: running, style: { stroke: "#9caeb3", strokeWidth: 1.5 }, markerEnd: { type: MarkerType.ArrowClosed, color: "#9caeb3", width: 16, height: 16 }, interactionWidth: 20 })), [architecture.edges, running]);
  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    if (architecture.edges.some((e) => e.source === connection.source && e.target === connection.target)) return;
    const target = architecture.nodes.find((n) => n.id === connection.target);
    if (target?.kind === "traffic") { setNotice("Traffic sources cannot receive connections."); return; }
    setArchitecture({ ...architecture, edges: [...architecture.edges, { id: crypto.randomUUID(), source: connection.source, target: connection.target }] }); setNotice("");
  };
  const addNode = (kind: NodeKind, position?: { x: number; y: number }) => {
    if (architecture.nodes.length >= 30) { setNotice("This workspace supports up to 30 components."); return; }
    const sameKind = architecture.nodes.filter((n) => n.kind === kind).length;
    const node = createSystemNode(kind, crypto.randomUUID(), position ?? { x: 320 + sameKind * 35, y: 270 + (sameKind % 3) * 170 });
    if (sameKind) node.label = `${node.label} ${sameKind + 1}`;
    setArchitecture({ ...architecture, nodes: [...architecture.nodes, node] }); select(node.id); setPalette(false);
  };
  const onDrop = (event: DragEvent) => { event.preventDefault(); const kind = event.dataTransfer.getData("application/system-node") as NodeKind; if (allowedKinds.includes(kind) && kind !== "traffic") addNode(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY })); };
  const removeNode = (id: string) => { setArchitecture({ nodes: architecture.nodes.filter((n) => n.id !== id || n.kind === "traffic"), edges: architecture.edges.filter((e) => e.source !== id && e.target !== id) }); select(null); };
  const onNodesChange = (changes: NodeChange[]) => {
    const deleted = changes.filter((c) => c.type === "remove").map((c) => c.id).filter((id) => architecture.nodes.find((n) => n.id === id)?.kind !== "traffic");
    if (deleted.length) { setArchitecture({ nodes: architecture.nodes.filter((n) => !deleted.includes(n.id)), edges: architecture.edges.filter((e) => !deleted.includes(e.source) && !deleted.includes(e.target)) }); select(null); return; }
    const moved = changes.filter((c): c is NodePositionChange => c.type === "position" && !!c.position);
    if (moved.length) setArchitecture({ ...architecture, nodes: architecture.nodes.map((n) => { const change = moved.find((c) => c.id === n.id); return change?.type === "position" && change.position ? { ...n, position: change.position } : n; }) }, false);
  };
  const setCapacity = (value: number) => { if (!selected) return; const capacity = Math.min(LIMITS.capacity, Math.max(1, value)); updateNode(selected.id, { capacity, cost: componentCost({ ...selected, capacity }) }); };
  return <div className="canvas-wrap">
    <div className="canvas-toolbar"><div className="canvas-title"><Workflow size={15} /><span>Architecture</span><span className="count-label">{architecture.nodes.length} components</span></div><div className="toolbar-actions"><Tip label="Undo"><button className="icon-button" aria-label="Undo" disabled={!past.length} onClick={undo}><Undo2 size={16} /></button></Tip><Tip label="Redo"><button className="icon-button" aria-label="Redo" disabled={!future.length} onClick={redo}><Redo2 size={16} /></button></Tip><span className="toolbar-divider" /><Tip label="Fit architecture"><button className="icon-button" aria-label="Fit architecture" onClick={() => fitView({ padding: 0.2, duration: 300 })}><Maximize size={16} /></button></Tip><Tip label="Reset architecture"><button className="icon-button" aria-label="Reset architecture" onClick={onReset}><RotateCcw size={15} /></button></Tip></div></div>
    <div className="canvas-area" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={(changes) => { const ids = changes.filter((c) => c.type === "remove").map((c) => c.id); if (ids.length) setArchitecture({ ...architecture, edges: architecture.edges.filter((e) => !ids.includes(e.id)) }); }} onConnect={connect} onNodeClick={(_, node) => select(node.id)} onPaneClick={() => { select(null); setPalette(false); }} fitView fitViewOptions={{ padding: 0.22, maxZoom: 0.95 }} minZoom={0.2} maxZoom={1.6} deleteKeyCode={["Backspace", "Delete"]} proOptions={{ hideAttribution: false }}><Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d9dfe2" /><Controls showInteractive={false} /></ReactFlow>
      <div className="canvas-environment"><span className={running ? "tiny-dot pulse" : "tiny-dot"} />{running ? "SIMULATING" : "DEVELOPMENT"}<span className="canvas-env-separator">/</span>us-east-1 <span className="simulated-label">simulated</span></div>
      <div className="component-dock"><button className={`button add-component ${palette ? "selected" : ""}`} onClick={() => setPalette(!palette)} aria-expanded={palette}><Plus size={16} />Add component</button>{palette && <div className="component-palette"><div className="palette-label">COMPONENT LIBRARY</div>{componentCatalog.filter((c) => c.kind !== "traffic" && allowedKinds.includes(c.kind)).map((item) => { const Icon = kindIcons[item.kind]; return <button key={item.kind} className={`palette-item node-${item.kind}`} draggable onDragStart={(event) => { event.dataTransfer.setData("application/system-node", item.kind); event.dataTransfer.effectAllowed = "move"; }} onClick={() => addNode(item.kind)}><span className="node-icon"><Icon size={18} /></span><span><strong>{item.name}</strong><small>{item.description}</small></span><Plus size={14} /></button>; })}</div>}</div>
      {notice && <div className="canvas-notice" role="status">{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}><X size={14} /></button></div>}
      {selected && selectedSettings && <div className="inspector" aria-label="Component settings">
        <div className="inspector-title"><span>COMPONENT SETTINGS</span><button className="icon-button" aria-label="Close component settings" onClick={() => select(null)}><X size={16} /></button></div>
        <div className={`inspector-identity node-${selected.kind}`}><span className="node-icon">{(() => { const Icon = kindIcons[selected.kind]; return <Icon size={20} />; })()}</span><strong>{selected.label}</strong></div>
        <label className="field-label">Name<input aria-label="Component name" maxLength={40} value={selected.label} onChange={(e) => updateNode(selected.id, { label: e.target.value })} /></label>
        {selected.kind === "traffic" ? <p className="field-note">{workload.requestRate} requests/second. Traffic is configured in the workload controls.</p> : <>
          <div className="inspector-section">
            <div className="inspector-section-title">GENERAL</div>
            <label className="field-label">Capacity <span>req/s per replica</span><input type="number" aria-label="Component capacity" min="10" max="2000" step="10" value={selected.capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></label>
            <div className="field-row"><label className="field-label">Transit delay <span>ms</span><input type="number" aria-label="Component latency" min="1" max="1000" value={selected.latency} onChange={(e) => updateNode(selected.id, { latency: Math.max(1, Math.min(1000, Number(e.target.value))) })} /></label><label className="field-label">Replicas<input type="number" aria-label="Component replicas" min="1" max={LIMITS.replicas} value={selected.replicas} onChange={(e) => updateNode(selected.id, { replicas: Math.max(1, Math.min(LIMITS.replicas, Number(e.target.value))) })} /></label></div>
            <p className="setting-note">Capacity is how much traffic one replica handles per second; more replicas add capacity in parallel and, on a load-balanced server, survive one another's failure.</p>
            <div className="field-row"><label className="field-label">Region<input aria-label="Component region" maxLength={24} value={selected.region ?? ""} placeholder="primary" onChange={(e) => updateNode(selected.id, { region: e.target.value || undefined })} /></label><label className="field-label">Variance<select aria-label="Service-time variance" value={selected.variance ?? "medium"} onChange={(e) => updateNode(selected.id, { variance: e.target.value as SystemNode["variance"] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div>
            <p className="setting-note">A hop that crosses regions adds the workload's cross-region latency. Variance is how spread out individual service times are around the average — higher variance means fatter latency tails at the same load.</p>
            {selected.kind === "cache" && selectedSettings.cacheModel === "probabilistic" && <label className="field-label">Read hit rate <span>{Math.round(selected.cacheHitRate * 100)}%</span><input type="range" aria-label="Cache hit rate" min="0" max="100" value={Math.round(selected.cacheHitRate * 100)} onChange={(e) => updateNode(selected.id, { cacheHitRate: Number(e.target.value) / 100 })} /></label>}
            {selected.kind === "cdn" && <label className="field-label">Edge hit rate <span>{Math.round(selected.cacheHitRate * 100)}%</span><input type="range" aria-label="CDN hit rate" min="0" max="100" value={Math.round(selected.cacheHitRate * 100)} onChange={(e) => updateNode(selected.id, { cacheHitRate: Number(e.target.value) / 100 })} /></label>}
          </div>
          {selected.kind === "server" && <div className="inspector-section">
            <div className="inspector-section-title">SERVER</div>
            <label className="field-label">Role<select aria-label="Server role" value={selected.role || "application"} onChange={(e) => updateNode(selected.id, { role: e.target.value as "application" | "worker" })}><option value="application">Application server</option><option value="worker">Background worker</option></select></label>
            <p className="setting-note">A worker must be fed by a queue instead of routed traffic; its replicas pull jobs from the shared backlog.</p>
            {selected.role === "worker" && <>
              <label className="toggle-field"><span>Idempotent</span><input type="checkbox" checked={!!selected.idempotent} onChange={(e) => updateNode(selected.id, { idempotent: e.target.checked })} /></label>
              <p className="setting-note">Dedups redelivered jobs by key, so a job the worker already finished counts as a duplicate instead of doing the work twice.</p>
            </>}
            <label className="field-label">Fan-out<select aria-label="Dependency fan-out" value={selected.fanout ?? "parallel"} onChange={(e) => updateNode(selected.id, { fanout: e.target.value as SystemNode["fanout"] })}><option value="parallel">Parallel</option><option value="sequential">Sequential</option></select></label>
            <p className="setting-note">With several dependencies, parallel waits for the slowest reply; sequential adds up their times, one after another.</p>
            <div className="field-row"><label className="field-label">Dependency timeout <span>ms, 0 = none</span><input type="number" aria-label="Dependency timeout" min="0" max="60000" step="10" value={selected.timeoutMs ?? 0} onChange={(e) => updateNode(selected.id, { timeoutMs: Math.max(0, Math.min(60000, Number(e.target.value))) })} /></label><label className="field-label">Retries <span>0-3</span><input type="number" aria-label="Retries" min="0" max="3" value={selected.retries ?? 0} onChange={(e) => updateNode(selected.id, { retries: Math.max(0, Math.min(3, Number(e.target.value))) })} /></label></div>
            <p className="setting-note">A dependency call that outlasts the timeout counts as a failure. Retries reissue it, backing off with jitter, and amplify load on the dependency.</p>
            <label className="field-label">Retry backoff <span>ms base, exponential + jitter</span><input type="number" aria-label="Retry backoff" min="0" max="10000" step="10" value={selected.retryBackoffMs ?? 50} onChange={(e) => updateNode(selected.id, { retryBackoffMs: Math.max(0, Math.min(10000, Number(e.target.value))) })} /></label>
            <label className="toggle-field"><span>Circuit breaker</span><input type="checkbox" checked={!!selected.circuitBreaker} onChange={(e) => updateNode(selected.id, { circuitBreaker: e.target.checked })} /></label>
            <p className="setting-note">Trips open after repeated dependency failures, failing calls fast instead of piling up timeouts; recovers after a cooldown.</p>
            {selected.circuitBreaker && <>
              <div className="field-row"><label className="field-label">Breaker window <span>ms</span><input type="number" aria-label="Breaker window" min="100" max="60000" step="100" value={selected.breakerWindowMs ?? 1000} onChange={(e) => updateNode(selected.id, { breakerWindowMs: Math.max(100, Math.min(60000, Number(e.target.value))) })} /></label><label className="field-label">Min calls <span>to evaluate</span><input type="number" aria-label="Breaker minimum calls" min="1" max="1000" value={selected.breakerMinCalls ?? 20} onChange={(e) => updateNode(selected.id, { breakerMinCalls: Math.max(1, Math.min(1000, Number(e.target.value))) })} /></label></div>
              <div className="field-row"><label className="field-label">Failure ratio <span>0-1 to open</span><input type="number" aria-label="Breaker failure ratio" min="0.05" max="1" step="0.05" value={selected.breakerFailureRatio ?? 0.5} onChange={(e) => updateNode(selected.id, { breakerFailureRatio: Math.max(0.05, Math.min(1, Number(e.target.value))) })} /></label><label className="field-label">Open time <span>ms cooldown</span><input type="number" aria-label="Breaker open time" min="0" max="600000" step="100" value={selected.breakerOpenMs ?? 5000} onChange={(e) => updateNode(selected.id, { breakerOpenMs: Math.max(0, Math.min(600000, Number(e.target.value))) })} /></label></div>
              <p className="setting-note">Opens once at least the minimum calls land in the window and the failure share crosses the ratio; stays open for the cooldown before letting a trial call through.</p>
            </>}
            <label className="field-label">Queue bound <span>0 = unbounded</span><input type="number" aria-label="Queue bound" min="0" max="100000" step="5" value={selected.maxQueue ?? 0} onChange={(e) => updateNode(selected.id, { maxQueue: Math.max(0, Math.min(100000, Number(e.target.value))) })} /></label>
            <p className="setting-note">Arrivals beyond the bound (per replica) are rejected immediately instead of waiting — a real backpressure valve rather than an ever-growing queue.</p>
            <label className="field-label">Pool size <span>0 = unlimited in-flight calls</span><input type="number" aria-label="Pool size" min="0" max="10000" value={selected.poolSize ?? 0} onChange={(e) => updateNode(selected.id, { poolSize: Math.max(0, Math.min(10000, Number(e.target.value))) })} /></label>
            <p className="setting-note">Bounds concurrent dependency calls per replica; excess calls wait in the pool queue above, or are rejected as pool-exhausted once it fills — a slow dependency can starve an otherwise idle server.</p>
          </div>}
          {selected.kind === "load-balancer" && <div className="inspector-section">
            <div className="inspector-section-title">LOAD BALANCER</div>
            <label className="field-label">Algorithm<select aria-label="Load balancer algorithm" value={selected.algorithm ?? "round-robin"} onChange={(e) => updateNode(selected.id, { algorithm: e.target.value as SystemNode["algorithm"] })}><option value="round-robin">Round robin</option><option value="least-connections">Least connections</option></select></label>
            <p className="setting-note">Round robin cycles through replicas; least connections favors whichever replica currently has the fewest in-flight requests.</p>
            <label className="field-label">Health-check interval <span>ms, 0 = instant</span><input type="number" aria-label="Health-check interval" min="0" max="60000" step="10" value={selected.healthCheckMs ?? 0} onChange={(e) => updateNode(selected.id, { healthCheckMs: Math.max(0, Math.min(60000, Number(e.target.value))) })} /></label>
            <p className="setting-note">How long a dead replica keeps receiving traffic before the balancer notices and routes around it.</p>
          </div>}
          {selected.kind === "database" && <div className="inspector-section">
            <div className="inspector-section-title">DATABASE</div>
            <label className="field-label">Mode<select aria-label="Database mode" value={selected.dbMode ?? "single"} onChange={(e) => updateNode(selected.id, { dbMode: e.target.value as SystemNode["dbMode"] })}><option value="single">Single pool</option><option value="leader-follower">Leader + followers</option><option value="sharded">Sharded</option><option value="quorum">Quorum</option></select></label>
            <p className="setting-note">Single pool is one idealized capacity. Leader + followers splits reads across replicas with lag. Sharded splits keys across independent lanes that can be uneven under skew. Quorum requires W/R replicas to ack each write/read.</p>
            {selectedSettings.dbMode === "quorum" && <>
              <div className="field-row"><label className="field-label">Write quorum (W) <span>of {selected.replicas} replicas</span><input type="number" aria-label="Write quorum" min="1" max={selected.replicas} value={selected.quorumWrite ?? 2} onChange={(e) => updateNode(selected.id, { quorumWrite: Math.max(1, Math.min(selected.replicas, Number(e.target.value))) })} /></label><label className="field-label">Read quorum (R) <span>of {selected.replicas} replicas</span><input type="number" aria-label="Read quorum" min="1" max={selected.replicas} value={selected.quorumRead ?? 2} onChange={(e) => updateNode(selected.id, { quorumRead: Math.max(1, Math.min(selected.replicas, Number(e.target.value))) })} /></label></div>
              <p className="setting-note">A write needs W acks (latency set by the W-th fastest replica); a read needs R. Fewer than W healthy replicas fails writes. {(selected.quorumWrite ?? 2) + (selected.quorumRead ?? 2) > selected.replicas ? `R + W > N (${selected.replicas}): no stale reads.` : `R + W ≤ N (${selected.replicas}): reads can go stale by the replication lag.`}</p>
            </>}
            {selectedSettings.dbMode === "leader-follower" && <>
              <div className="field-row"><label className="field-label">Replication lag <span>ms</span><input type="number" aria-label="Replication lag" min="0" max="60000" step="10" value={selected.replicationLagMs ?? 200} onChange={(e) => updateNode(selected.id, { replicationLagMs: Math.max(0, Math.min(60000, Number(e.target.value))) })} /></label><label className="field-label">Failover time <span>ms</span><input type="number" aria-label="Failover time" min="0" max="60000" step="10" value={selected.failoverMs ?? 3000} onChange={(e) => updateNode(selected.id, { failoverMs: Math.max(0, Math.min(60000, Number(e.target.value))) })} /></label></div>
              <label className="field-label">Consistency<select aria-label="Consistency" value={selected.consistency ?? "eventual"} onChange={(e) => updateNode(selected.id, { consistency: e.target.value as SystemNode["consistency"] })}><option value="eventual">Eventual</option><option value="read-your-writes">Read-your-writes</option></select></label>
              <p className="setting-note">A follower can lag the leader; reads can go stale for that long. Read-your-writes routes reads of recently written keys to the leader instead. Failover time is how long writes are unavailable after the leader dies.</p>
            </>}
            {selectedSettings.dbMode === "sharded" && <>
              <div className="field-row"><label className="field-label">Shards<input type="number" aria-label="Shards" min="1" max={LIMITS.shards} value={selected.shards ?? 4} onChange={(e) => updateNode(selected.id, { shards: Math.max(1, Math.min(LIMITS.shards, Number(e.target.value))) })} /></label><label className="field-label">Strategy<select aria-label="Shard strategy" value={selected.shardStrategy ?? "hash"} onChange={(e) => updateNode(selected.id, { shardStrategy: e.target.value as SystemNode["shardStrategy"] })}><option value="hash">Hash</option><option value="range">Range</option></select></label></div>
              <p className="setting-note">Hash spreads keys evenly; range keeps adjacent keys together but can hot-spot one shard under skewed or sequential access.</p>
            </>}
          </div>}
          {selected.kind === "cache" && <div className="inspector-section">
            <div className="inspector-section-title">CACHE</div>
            <label className="field-label">Model<select aria-label="Cache model" value={selected.cacheModel ?? "probabilistic"} onChange={(e) => updateNode(selected.id, { cacheModel: e.target.value as SystemNode["cacheModel"] })}><option value="probabilistic">Probabilistic</option><option value="keyed">Keyed (LRU)</option></select></label>
            <p className="setting-note">Probabilistic hits a fixed share of reads. Keyed models an actual LRU: capacity, eviction, TTL expiry, and cold-start misses after a flush.</p>
            {selectedSettings.cacheModel === "probabilistic" ? <label className="field-label">Warm-up <span>seconds, 0 = instant</span><input type="number" aria-label="Cache warm-up" min="0" max="60" value={selected.warmupSeconds ?? 0} onChange={(e) => updateNode(selected.id, { warmupSeconds: Math.max(0, Math.min(60, Number(e.target.value))) })} /></label> : <>
              <div className="field-row"><label className="field-label">Entries <span>LRU capacity</span><input type="number" aria-label="Cache entries" min="1" max={LIMITS.keySpace} value={selected.cacheEntries ?? 1000} onChange={(e) => updateNode(selected.id, { cacheEntries: Math.max(1, Math.min(LIMITS.keySpace, Number(e.target.value))) })} /></label><label className="field-label">TTL <span>ms, 0 = none</span><input type="number" aria-label="Cache TTL" min="0" max="600000" step="100" value={selected.ttlMs ?? 0} onChange={(e) => updateNode(selected.id, { ttlMs: Math.max(0, Math.min(600000, Number(e.target.value))) })} /></label></div>
              <label className="toggle-field"><span>Coalesce concurrent misses</span><input type="checkbox" checked={!!selected.coalesce} onChange={(e) => updateNode(selected.id, { coalesce: e.target.checked })} /></label>
              <p className="setting-note">Coalescing collapses simultaneous misses for the same key into one origin fetch instead of one per waiting request.</p>
            </>}
          </div>}
          {selected.kind === "queue" && <div className="inspector-section">
            <div className="inspector-section-title">QUEUE</div>
            <label className="field-label">Queue bound <span>0 = unbounded</span><input type="number" aria-label="Queue bound" min="0" max="100000" step="5" value={selected.maxQueue ?? 0} onChange={(e) => updateNode(selected.id, { maxQueue: Math.max(0, Math.min(100000, Number(e.target.value))) })} /></label>
            <p className="setting-note">Jobs beyond the bound are rejected immediately instead of backing up forever.</p>
            <label className="field-label">Ack mode<select aria-label="Ack mode" value={selected.ackMode ?? "at-most-once"} onChange={(e) => updateNode(selected.id, { ackMode: e.target.value as SystemNode["ackMode"] })}><option value="at-most-once">At-most-once</option><option value="at-least-once">At-least-once</option></select></label>
            <p className="setting-note">At-most-once: a job lost with a dead worker is gone. At-least-once: it is redelivered after the visibility timeout — a worker that isn&apos;t idempotent counts a redelivered but already-finished job as a duplicate.</p>
            {selectedSettings.ackMode === "at-least-once" && <>
              <div className="field-row"><label className="field-label">Visibility timeout <span>ms</span><input type="number" aria-label="Visibility timeout" min="0" max="600000" step="100" value={selected.visibilityTimeoutMs ?? 2000} onChange={(e) => updateNode(selected.id, { visibilityTimeoutMs: Math.max(0, Math.min(600000, Number(e.target.value))) })} /></label><label className="field-label">Max deliveries<input type="number" aria-label="Max deliveries" min="1" max="20" value={selected.maxDeliveries ?? 3} onChange={(e) => updateNode(selected.id, { maxDeliveries: Math.max(1, Math.min(20, Number(e.target.value))) })} /></label></div>
              <p className="setting-note">A worker that dies or outlasts the visibility timeout causes redelivery; a job redelivered more than this many times is dead-lettered instead of retried forever.</p>
            </>}
          </div>}
          {selected.kind === "rate-limiter" && <div className="inspector-section">
            <div className="inspector-section-title">RATE LIMITER</div>
            <div className="field-row"><label className="field-label">Limit <span>req/s refill</span><input type="number" aria-label="Rate limit" min="1" max={LIMITS.capacity} step="10" value={selected.limit ?? 500} onChange={(e) => updateNode(selected.id, { limit: Math.max(1, Math.min(LIMITS.capacity, Number(e.target.value))) })} /></label><label className="field-label">Burst <span>bucket size</span><input type="number" aria-label="Burst allowance" min="1" max={LIMITS.capacity} step="10" value={selected.burst ?? selected.limit ?? 500} onChange={(e) => updateNode(selected.id, { burst: Math.max(1, Math.min(LIMITS.capacity, Number(e.target.value))) })} /></label></div>
            <p className="setting-note">Tokens refill at the limit, up to the burst size; a request beyond the bucket is rejected fast rather than queued.</p>
          </div>}
          <label className="toggle-field"><span>Online at run start</span><input type="checkbox" checked={selected.enabled} onChange={(e) => updateNode(selected.id, { enabled: e.target.checked })} /></label>
          <p className="routing-note">{routingNote(selected, selectedBalanced)}</p>
          {selectedMetric?.replicas && <div className="replica-metrics"><span className="field-label">Measured replica activity</span>{selectedMetric.replicas.map((replica) => <div key={replica.index}><span>Replica {replica.index}</span><span>{replica.processed} done / {replica.errors} errors</span><strong>{Math.round(replica.utilization * 100)}%</strong></div>)}</div>}
          {selectedMetric?.shards && selectedMetric.shards.length > 0 && <div className="shard-metrics"><span className="field-label">Measured shard utilization</span>{selectedMetric.shards.map((u, i) => <div key={i}><span>Shard {i}</span><strong>{Math.round(u * 100)}%</strong></div>)}</div>}
          <div className="inspector-cost"><span>Infrastructure cost</span><strong>{nodeCost(selected).toFixed(3)} credits</strong></div>
          <div className="inspector-actions"><button className="button" onClick={() => { const copy = { ...selected, id: crypto.randomUUID(), label: `${selected.label} copy`.slice(0, 40), position: { x: selected.position.x, y: selected.position.y + 190 } }; setArchitecture({ ...architecture, nodes: [...architecture.nodes, copy] }); select(copy.id); }}><Copy size={14} />Duplicate</button><button className="icon-button danger" aria-label="Delete component" onClick={() => removeNode(selected.id)}><Trash2 size={16} /></button></div>
        </>}
        <div className="connection-list"><span className="field-label">Outgoing connections</span>{architecture.edges.filter((e) => e.source === selected.id).map((edge) => <div key={edge.id}><ArrowRight size={12} /><span>{architecture.nodes.find((n) => n.id === edge.target)?.label}</span><button className="icon-button" aria-label={`Remove connection to ${architecture.nodes.find((n) => n.id === edge.target)?.label}`} onClick={() => setArchitecture({ ...architecture, edges: architecture.edges.filter((e) => e.id !== edge.id) })}><X size={13} /></button></div>)}
          {connectOptions && (connectOptions.targets.length > 0 ? <label className="field-label">Connect to<select aria-label="Connect component to" value="" onChange={(e) => { if (e.target.value) connect({ source: selected.id, target: e.target.value, sourceHandle: null, targetHandle: null }); }}><option value="">Select component</option>{connectOptions.targets.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label> : connectOptions.limitNote ? <p className="connect-limit-note">{connectOptions.limitNote}</p> : null)}
        </div>
      </div>}
    </div><div className="canvas-footer"><span><span className="legend-dot green" />Available</span><span><span className="legend-dot amber" />Busy replica</span><span><span className="legend-dot gray" />Unavailable</span><span className="canvas-footer-right"><Activity size={12} />{result ? `Engine ${result.engineVersion}` : "Deterministic simulation"}</span></div>
  </div>;
}
export function ArchitectureCanvas(props: { result: SimulationResult | null; running: boolean; allowedKinds: NodeKind[]; onReset: () => void }) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>; }
