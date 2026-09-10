import type { Architecture, NodeKind, SystemNode, Workload } from "./types";

export const nodeDefaults: Record<NodeKind, Omit<SystemNode, "id" | "position">> = {
  traffic: { kind: "traffic", label: "Incoming traffic", capacity: 10000, latency: 0, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
  server: { kind: "server", label: "Application server", capacity: 200, latency: 15, replicas: 1, cacheHitRate: 0, enabled: true, cost: 3, role: "application" },
  "load-balancer": { kind: "load-balancer", label: "Load balancer", capacity: 5000, latency: 2, replicas: 1, cacheHitRate: 0, enabled: true, cost: 1 },
  database: { kind: "database", label: "Database", capacity: 150, latency: 25, replicas: 1, cacheHitRate: 0, enabled: true, cost: 4 },
  cache: { kind: "cache", label: "Cache", capacity: 2500, latency: 2, replicas: 1, cacheHitRate: 0.8, enabled: true, cost: 2 },
  queue: { kind: "queue", label: "Message queue", capacity: 10000, latency: 1, replicas: 1, cacheHitRate: 0, enabled: true, cost: 1 },
};

export const componentCatalog: { kind: NodeKind; name: string; description: string }[] = [
  { kind: "server", name: "Server", description: "Application replicas need routed traffic; workers pull queued jobs." },
  { kind: "load-balancer", name: "Load balancer", description: "Routes requests across healthy application replica endpoints." },
  { kind: "database", name: "Database", description: "An idealized managed pool for reads and writes, without replication semantics." },
  { kind: "cache", name: "Cache", description: "An idealized managed cache; read hits avoid a database trip." },
  { kind: "queue", name: "Queue", description: "Buffers jobs for worker replicas to pull from a shared FIFO queue." },
];

export function createSystemNode(kind: NodeKind, id: string, position: { x: number; y: number }): SystemNode {
  return { ...nodeDefaults[kind], id, position: { ...position } };
}

export const defaultWorkload: Workload = {
  requestRate: 100,
  readRatio: 0.85,
  duration: 30,
  seed: 42,
  pattern: "steady",
  failure: "none",
};

export interface ArchitectureTemplate {
  id: string;
  name: string;
  description: string;
  architecture: Architecture;
  workload: Workload;
}

export const sandboxArchitecture: Architecture = {
  nodes: [
    createSystemNode("traffic", "traffic", { x: 40, y: 140 }),
    createSystemNode("server", "server", { x: 320, y: 140 }),
    createSystemNode("database", "database", { x: 600, y: 140 }),
  ],
  edges: [
    { id: "traffic-server", source: "traffic", target: "server" },
    { id: "server-database", source: "server", target: "database" },
  ],
};

export const templates: ArchitectureTemplate[] = [
  {
    id: "web-app",
    name: "Web application",
    description: "Traffic addresses one application replica backed by a database.",
    architecture: sandboxArchitecture,
    workload: { ...defaultWorkload },
  },
  {
    id: "cached-service",
    name: "Cached service",
    description: "One application replica with a read cache in front of storage.",
    architecture: {
      nodes: [
        createSystemNode("traffic", "traffic", { x: 40, y: 140 }),
        { ...createSystemNode("server", "server", { x: 320, y: 140 }), capacity: 400, cost: 6 },
        createSystemNode("cache", "cache", { x: 600, y: 140 }),
        createSystemNode("database", "database", { x: 880, y: 140 }),
      ],
      edges: [
        { id: "traffic-server", source: "traffic", target: "server" },
        { id: "server-cache", source: "server", target: "cache" },
        { id: "cache-database", source: "cache", target: "database" },
      ],
    },
    workload: { ...defaultWorkload, requestRate: 300, readRatio: 0.95 },
  },
  {
    id: "background-jobs",
    name: "Background jobs",
    description: "An intake service and a shared queue supplying worker replicas.",
    architecture: {
      nodes: [
        createSystemNode("traffic", "traffic", { x: 40, y: 140 }),
        createSystemNode("server", "intake", { x: 320, y: 140 }),
        createSystemNode("queue", "queue", { x: 600, y: 140 }),
        { ...createSystemNode("server", "worker", { x: 880, y: 140 }), label: "Job worker", role: "worker" },
        createSystemNode("database", "database", { x: 1160, y: 140 }),
      ],
      edges: [
        { id: "traffic-intake", source: "traffic", target: "intake" },
        { id: "intake-queue", source: "intake", target: "queue" },
        { id: "queue-worker", source: "queue", target: "worker" },
        { id: "worker-database", source: "worker", target: "database" },
      ],
    },
    workload: { ...defaultWorkload, requestRate: 80, readRatio: 0 },
  },
];
