"use client";
import { memo, useMemo, useState, type DragEvent } from "react";
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps, type Connection, type NodeChange, type NodePositionChange } from "@xyflow/react";
import { Activity, ArrowRight, Check, Copy, Database, Globe2, Layers3, Maximize, Network, Plus, Redo2, RotateCcw, Server, Trash2, Undo2, Workflow, X, Zap } from "lucide-react";
import type { Architecture, NodeKind, NodeMetric, SimulationResult, SystemNode } from "@/lib/types";
import { componentCatalog, createSystemNode } from "@/lib/templates";
import { componentCost } from "@/lib/cost";
import { useEditor } from "@/lib/editor-store";
import { Tip } from "./ui";

export const kindIcons = { traffic: Globe2, server: Server, "load-balancer": Network, database: Database, cache: Zap, queue: Layers3 };
const kindLabels: Record<NodeKind, string> = { traffic: "TRAFFIC SOURCE", server: "APPLICATION", "load-balancer": "LOAD BALANCER", database: "DATABASE", cache: "CACHE", queue: "MESSAGE QUEUE" };
type FlowData = { system: SystemNode; metric?: NodeMetric; running: boolean; selected: boolean; requestRate: number; balanced: boolean };
type FlowNode = Node<FlowData, "system">;

const SystemFlowNode = memo(function SystemFlowNode({ data }: NodeProps<FlowNode>) {
  const { system: node, metric } = data;
  const Icon = kindIcons[node.kind];
  const utilization = metric?.replicas?.length ? Math.max(...metric.replicas.map((replica) => replica.utilization)) : metric?.utilization ?? 0;
  const hot = utilization > 0.85;
  const directEndpointFailed = node.kind === "server" && node.role !== "worker" && !data.balanced && metric?.healthyReplicas !== undefined && metric.healthyReplicas < node.replicas;
  const offline = !node.enabled || metric?.healthyReplicas === 0 || directEndpointFailed;
  return <div className={`system-node node-${node.kind} ${data.selected ? "node-selected" : ""} ${offline ? "node-disabled" : ""}`}>
    {node.kind !== "traffic" && <Handle type="target" position={Position.Left} className="node-handle" />}
    <div className="node-topline"><span className="node-kind">{node.role === "worker" ? "BACKGROUND WORKER" : kindLabels[node.kind]}</span><span className={`node-status ${offline ? "offline" : hot ? "busy" : ""}`} /></div>
    <div className="node-identity"><span className="node-icon"><Icon size={20} strokeWidth={1.65} /></span><strong>{node.label}</strong></div>
    <div className="node-spec"><span>{node.kind === "traffic" ? `${data.requestRate} req/s` : node.kind === "cache" ? `${Math.round(node.cacheHitRate * 100)}% read hits` : `${node.capacity} req/s each`}</span><span>{node.kind === "traffic" ? "HTTP" : node.replicas > 1 ? `${node.replicas} replicas` : `${node.latency} ms`}</span></div>
    {node.kind !== "traffic" && <div className="node-utilization"><div className="node-utilization-track"><span className={hot ? "hot" : ""} style={{ width: `${Math.min(100, utilization * 100)}%` }} /></div><span>{offline ? "Unavailable" : metric ? `${Math.round(utilization * 100)}% ${node.replicas > 1 ? "busiest replica" : "utilization"}` : "Not measured"}</span></div>}
    <Handle type="source" position={Position.Right} className="node-handle" />
  </div>;
});
const nodeTypes = { system: SystemFlowNode };

function Canvas({ result, running, allowedKinds, onReset }: { result: SimulationResult | null; running: boolean; allowedKinds: NodeKind[]; onReset: () => void }) {
  const { architecture, workload, selectedId, select, setArchitecture, updateNode, past, future, undo, redo } = useEditor();
  const [palette, setPalette] = useState(false);
  const [notice, setNotice] = useState("");
  const { screenToFlowPosition, fitView } = useReactFlow();
  const selected = architecture.nodes.find((n) => n.id === selectedId);
  const selectedMetric = result?.nodes.find((node) => node.nodeId === selectedId);
  const selectedBalanced = selected && architecture.edges.some((edge) => edge.target === selected.id && architecture.nodes.some((node) => node.id === edge.source && node.kind === "load-balancer"));
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
  return <div className="canvas-wrap">
    <div className="canvas-toolbar"><div className="canvas-title"><Workflow size={15} /><span>Architecture</span><span className="count-label">{architecture.nodes.length} components</span></div><div className="toolbar-actions"><Tip label="Undo"><button className="icon-button" aria-label="Undo" disabled={!past.length} onClick={undo}><Undo2 size={16} /></button></Tip><Tip label="Redo"><button className="icon-button" aria-label="Redo" disabled={!future.length} onClick={redo}><Redo2 size={16} /></button></Tip><span className="toolbar-divider" /><Tip label="Fit architecture"><button className="icon-button" aria-label="Fit architecture" onClick={() => fitView({ padding: 0.2, duration: 300 })}><Maximize size={16} /></button></Tip><Tip label="Reset architecture"><button className="icon-button" aria-label="Reset architecture" onClick={onReset}><RotateCcw size={15} /></button></Tip></div></div>
    <div className="canvas-area" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={(changes) => { const ids = changes.filter((c) => c.type === "remove").map((c) => c.id); if (ids.length) setArchitecture({ ...architecture, edges: architecture.edges.filter((e) => !ids.includes(e.id)) }); }} onConnect={connect} onNodeClick={(_, node) => select(node.id)} onPaneClick={() => { select(null); setPalette(false); }} fitView fitViewOptions={{ padding: 0.22, maxZoom: 0.95 }} minZoom={0.2} maxZoom={1.6} deleteKeyCode={["Backspace", "Delete"]} proOptions={{ hideAttribution: false }}><Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d9dfe2" /><Controls showInteractive={false} /></ReactFlow>
      <div className="canvas-environment"><span className={running ? "tiny-dot pulse" : "tiny-dot"} />{running ? "SIMULATING" : "DEVELOPMENT"}<span className="canvas-env-separator">/</span>us-east-1 <span className="simulated-label">simulated</span></div>
      <div className="component-dock"><button className={`button add-component ${palette ? "selected" : ""}`} onClick={() => setPalette(!palette)} aria-expanded={palette}><Plus size={16} />Add component</button>{palette && <div className="component-palette"><div className="palette-label">COMPONENT LIBRARY</div>{componentCatalog.filter((c) => c.kind !== "traffic" && allowedKinds.includes(c.kind)).map((item) => { const Icon = kindIcons[item.kind]; return <button key={item.kind} className={`palette-item node-${item.kind}`} draggable onDragStart={(event) => { event.dataTransfer.setData("application/system-node", item.kind); event.dataTransfer.effectAllowed = "move"; }} onClick={() => addNode(item.kind)}><span className="node-icon"><Icon size={18} /></span><span><strong>{item.name}</strong><small>{item.description}</small></span><Plus size={14} /></button>; })}</div>}</div>
      {notice && <div className="canvas-notice" role="status">{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}><X size={14} /></button></div>}
      {selected && <div className="inspector" aria-label="Component settings"><div className="inspector-title"><span>COMPONENT SETTINGS</span><button className="icon-button" aria-label="Close component settings" onClick={() => select(null)}><X size={16} /></button></div><div className={`inspector-identity node-${selected.kind}`}><span className="node-icon">{(() => { const Icon = kindIcons[selected.kind]; return <Icon size={20} />; })()}</span><strong>{selected.label}</strong></div><label className="field-label">Name<input aria-label="Component name" maxLength={40} value={selected.label} onChange={(e) => updateNode(selected.id, { label: e.target.value })} /></label>
        {selected.kind === "traffic" ? <p className="field-note">{workload.requestRate} requests/second. Traffic is configured in the workload controls.</p> : <>
          <label className="field-label">Capacity <span>req/s per replica</span><input type="number" aria-label="Component capacity" min="10" max="2000" step="10" value={selected.capacity} onChange={(e) => { const capacity = Math.min(2000, Math.max(10, Number(e.target.value))); updateNode(selected.id, { capacity, cost: componentCost({ ...selected, capacity }) }); }} /></label>
          <div className="field-row"><label className="field-label">Transit delay <span>ms</span><input type="number" aria-label="Component latency" min="1" max="1000" value={selected.latency} onChange={(e) => updateNode(selected.id, { latency: Math.max(1, Math.min(1000, Number(e.target.value))) })} /></label><label className="field-label">Replicas<input type="number" aria-label="Component replicas" min="1" max="8" value={selected.replicas} onChange={(e) => updateNode(selected.id, { replicas: Math.max(1, Math.min(8, Number(e.target.value))) })} /></label></div>
          {selected.kind === "cache" && <label className="field-label">Read hit rate <span>{Math.round(selected.cacheHitRate * 100)}%</span><input type="range" aria-label="Cache hit rate" min="0" max="100" value={Math.round(selected.cacheHitRate * 100)} onChange={(e) => updateNode(selected.id, { cacheHitRate: Number(e.target.value) / 100 })} /></label>}
          {selected.kind === "server" && <label className="field-label">Role<select aria-label="Server role" value={selected.role || "application"} onChange={(e) => updateNode(selected.id, { role: e.target.value as "application" | "worker" })}><option value="application">Application server</option><option value="worker">Background worker</option></select></label>}
          <label className="toggle-field"><span>Online at run start</span><input type="checkbox" checked={selected.enabled} onChange={(e) => updateNode(selected.id, { enabled: e.target.checked })} /></label>
          <p className="routing-note">{selected.kind === "server" ? selected.role === "worker" ? "Queue consumers: replicas share the pending job queue." : selectedBalanced ? "Load-balancer connections route to individual healthy replicas. Direct connections still target replica 1." : "Direct endpoint: only replica 1 receives requests. No implicit load balancing or failover." : selected.kind === "database" ? "Idealized managed pool: equivalent read/write capacity and immediate failover. Not a primary/read-replica database model." : "Idealized managed pool with automatic distribution. Internal routing and replication protocols are not simulated."}</p>
          {selectedMetric?.replicas && <div className="replica-metrics"><span className="field-label">Measured replica activity</span>{selectedMetric.replicas.map((replica) => <div key={replica.index}><span>Replica {replica.index}</span><span>{replica.processed} done / {replica.errors} errors</span><strong>{Math.round(replica.utilization * 100)}%</strong></div>)}</div>}
          <div className="inspector-cost"><span>Infrastructure cost</span><strong>{(componentCost(selected) * selected.replicas).toFixed(3)} credits</strong></div>
          <div className="inspector-actions"><button className="button" onClick={() => { const copy = { ...selected, id: crypto.randomUUID(), label: `${selected.label} copy`.slice(0, 40), position: { x: selected.position.x, y: selected.position.y + 190 } }; setArchitecture({ ...architecture, nodes: [...architecture.nodes, copy] }); select(copy.id); }}><Copy size={14} />Duplicate</button><button className="icon-button danger" aria-label="Delete component" onClick={() => removeNode(selected.id)}><Trash2 size={16} /></button></div>
        </>}
        <div className="connection-list"><span className="field-label">Outgoing connections</span>{architecture.edges.filter((e) => e.source === selected.id).map((edge) => <div key={edge.id}><ArrowRight size={12} /><span>{architecture.nodes.find((n) => n.id === edge.target)?.label}</span><button className="icon-button" aria-label={`Remove connection to ${architecture.nodes.find((n) => n.id === edge.target)?.label}`} onClick={() => setArchitecture({ ...architecture, edges: architecture.edges.filter((e) => e.id !== edge.id) })}><X size={13} /></button></div>)}{selected.kind !== "database" && <label className="field-label">Connect to<select aria-label="Connect component to" value="" onChange={(e) => { if (e.target.value) connect({ source: selected.id, target: e.target.value, sourceHandle: null, targetHandle: null }); }}><option value="">Select component</option>{architecture.nodes.filter((node) => node.kind !== "traffic" && node.id !== selected.id && !architecture.edges.some((edge) => edge.source === selected.id && edge.target === node.id)).map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label>}</div>
      </div>}
    </div><div className="canvas-footer"><span><span className="legend-dot green" />Available</span><span><span className="legend-dot amber" />Busy replica</span><span><span className="legend-dot gray" />Unavailable</span><span className="canvas-footer-right"><Activity size={12} />{result ? `Engine ${result.engineVersion}` : "Deterministic simulation"}</span></div>
  </div>;
}
export function ArchitectureCanvas(props: { result: SimulationResult | null; running: boolean; allowedKinds: NodeKind[]; onReset: () => void }) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>; }
