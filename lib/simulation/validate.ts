import type { Architecture, NodeKind, Workload } from "../types";

const kinds: NodeKind[] = ["traffic", "server", "load-balancer", "database", "cache", "queue"];

export function validateSimulation(architecture: Architecture, workload: Workload): void {
  const { nodes, edges } = architecture;
  if (!Array.isArray(nodes) || !Array.isArray(edges) || nodes.length > 48 || edges.length > 96) {
    throw new Error("Use at most 48 components and 96 connections.");
  }
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new Error("Component identifiers must be unique.");
  const traffic = nodes.filter((node) => node.kind === "traffic");
  if (traffic.length !== 1) throw new Error("Add exactly one traffic source.");
  if (!traffic[0].enabled) throw new Error("Enable the traffic source before running.");
  for (const node of nodes) {
    if (!kinds.includes(node.kind)) throw new Error("The design contains an unsupported component.");
    if (!Number.isFinite(node.capacity) || node.capacity <= 0 || node.capacity > 100000) {
      throw new Error(`${node.label}: capacity must be between 1 and 100,000 requests/s.`);
    }
    if (!Number.isInteger(node.replicas) || node.replicas < 1 || node.replicas > 16) {
      throw new Error(`${node.label}: use between 1 and 16 replicas.`);
    }
    if (!Number.isFinite(node.latency) || node.latency < 0 || node.latency > 10000) {
      throw new Error(`${node.label}: latency must be between 0 and 10,000 ms.`);
    }
    if (!Number.isFinite(node.cacheHitRate) || node.cacheHitRate < 0 || node.cacheHitRate > 1) {
      throw new Error(`${node.label}: cache hit rate must be between 0 and 100%.`);
    }
    if (!Number.isFinite(node.cost) || node.cost < 0) throw new Error(`${node.label}: cost must be positive.`);
  }
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error("A connection references a missing component.");
    const key = `${edge.source}:${edge.target}`;
    if (seenEdges.has(key)) throw new Error("Remove duplicate connections between the same components.");
    seenEdges.add(key);
  }
  const children = (id: string) => edges.filter((edge) => edge.source === id).map((edge) => nodes.find((node) => node.id === edge.target)!);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("Remove the connection loop. Request routes must not contain cycles.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const node of children(id)) visit(node.id);
    visiting.delete(id);
    visited.add(id);
  }
  visit(traffic[0].id);
  const disconnected = nodes.filter((node) => !visited.has(node.id));
  if (disconnected.length) throw new Error(`Connect every component to traffic: ${disconnected.map((node) => node.label).join(", ")}.`);
  for (const node of nodes) {
    const next = children(node.id);
    const incoming = edges.filter((edge) => edge.target === node.id).map((edge) => nodes.find((source) => source.id === edge.source)!);
    if (node.kind === "traffic") {
      if (incoming.length || next.length !== 1 || !["server", "load-balancer"].includes(next[0].kind)) {
        throw new Error("Connect traffic to exactly one application server or load balancer.");
      }
    } else if (node.kind === "load-balancer") {
      if (!next.length || next.some((child) => child.kind !== "server" || child.role === "worker")) {
        throw new Error(`${node.label}: connect the load balancer to one or more application servers.`);
      }
    } else if (node.kind === "database") {
      if (next.length) throw new Error(`${node.label}: databases are the end of a request route.`);
    } else if (node.kind === "cache") {
      if (next.length !== 1 || next[0].kind !== "database") {
        throw new Error(`${node.label}: connect the cache to exactly one database for misses and writes.`);
      }
    } else if (node.kind === "queue") {
      if (next.length !== 1 || next[0].kind !== "server" || next[0].role !== "worker") {
        throw new Error(`${node.label}: connect the queue to one server with the Worker role.`);
      }
    } else if (node.kind === "server") {
      if (next.length > 1 || next.some((child) => child.kind === "traffic" || child.kind === "load-balancer")) {
        throw new Error(`${node.label}: use at most one outgoing dependency connection.`);
      }
      if (node.role === "worker" && incoming.some((parent) => parent.kind !== "queue")) {
        throw new Error(`${node.label}: a worker must receive jobs from a queue.`);
      }
    }
  }
  if (!Number.isFinite(workload.requestRate) || workload.requestRate < 1 || workload.requestRate > 2000) {
    throw new Error("Choose traffic between 1 and 2,000 requests/s.");
  }
  if (!Number.isInteger(workload.duration) || workload.duration < 1 || workload.duration > 60) {
    throw new Error("Choose a whole-number duration between 1 and 60 seconds.");
  }
  if (!Number.isFinite(workload.readRatio) || workload.readRatio < 0 || workload.readRatio > 1) {
    throw new Error("Read traffic must be between 0 and 100%.");
  }
  if (!Number.isFinite(workload.seed)) throw new Error("The simulation seed must be a finite number.");
  if (!["steady", "spike", "ramp"].includes(workload.pattern) || !["none", "server", "database"].includes(workload.failure)) {
    throw new Error("Choose a supported traffic pattern and failure scenario.");
  }
}
