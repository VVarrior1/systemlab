import { describe, expect, it } from "vitest";
import { fitScore, suggestFor, techCatalog, workloadTraits, type Trait } from "./tech-catalog";
import type { Architecture, NodeKind, Workload } from "./types";

const kinds: NodeKind[] = ["server", "load-balancer", "database", "cache", "queue", "cdn", "rate-limiter"];

function makeWorkload(overrides: Partial<Workload> = {}): Workload {
  return {
    requestRate: 500,
    readRatio: 0.5,
    duration: 60,
    seed: 1,
    pattern: "steady",
    failure: "none",
    ...overrides,
  };
}

function makeArchitecture(overrides: Partial<Architecture> = {}): Architecture {
  return { nodes: [], edges: [], ...overrides };
}

describe("techCatalog", () => {
  it("has 5-8 options per node kind", () => {
    for (const kind of kinds) {
      const options = techCatalog.filter((option) => option.kind === kind);
      expect(options.length, `${kind} has ${options.length} options`).toBeGreaterThanOrEqual(5);
      expect(options.length, `${kind} has ${options.length} options`).toBeLessThanOrEqual(8);
    }
  });

  it("has a unique id for every option", () => {
    const ids = techCatalog.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every option a non-empty, non-marketing note", () => {
    for (const option of techCatalog) {
      expect(option.note.length, option.id).toBeGreaterThan(20);
      expect(option.note.toLowerCase(), option.id).not.toMatch(/best-in-class|industry-leading|revolutionary/);
    }
  });

  it("never lists the same trait in both fits and avoid", () => {
    for (const option of techCatalog) {
      const overlap = option.fits.filter((trait) => option.avoid.includes(trait));
      expect(overlap, option.id).toEqual([]);
    }
  });
});

describe("workloadTraits", () => {
  it("derives read-heavy from a high read ratio", () => {
    const traits = workloadTraits(makeWorkload({ readRatio: 0.9 }), makeArchitecture());
    expect(traits).toContain("read-heavy");
    expect(traits).not.toContain("write-heavy");
  });

  it("derives write-heavy from a low read ratio", () => {
    const traits = workloadTraits(makeWorkload({ readRatio: 0.2 }), makeArchitecture());
    expect(traits).toContain("write-heavy");
    expect(traits).not.toContain("read-heavy");
  });

  it("derives hot-keys from extreme key skew", () => {
    const traits = workloadTraits(makeWorkload({ keySkew: 0.9 }), makeArchitecture());
    expect(traits).toContain("hot-keys");
  });

  it("does not derive hot-keys from low key skew", () => {
    const traits = workloadTraits(makeWorkload({ keySkew: 0.2 }), makeArchitecture());
    expect(traits).not.toContain("hot-keys");
  });

  it("derives global from multi-region workloads", () => {
    const traits = workloadTraits(
      makeWorkload({ regions: [{ name: "us", share: 0.5 }, { name: "eu", share: 0.5 }] }),
      makeArchitecture(),
    );
    expect(traits).toContain("global");
  });

  it("derives streaming from the presence of a queue node", () => {
    const architecture = makeArchitecture({
      nodes: [
        { id: "q1", kind: "queue", label: "Queue", position: { x: 0, y: 0 }, capacity: 100, latency: 5, replicas: 1, cacheHitRate: 0, enabled: true, cost: 10 },
      ],
    });
    const traits = workloadTraits(makeWorkload(), architecture);
    expect(traits).toContain("streaming");
  });

  it("derives strong-consistency from a quorum database", () => {
    const architecture = makeArchitecture({
      nodes: [
        { id: "db1", kind: "database", label: "DB", position: { x: 0, y: 0 }, capacity: 100, latency: 5, replicas: 1, cacheHitRate: 0, enabled: true, cost: 10, dbMode: "quorum" },
      ],
    });
    const traits = workloadTraits(makeWorkload(), architecture);
    expect(traits).toContain("strong-consistency");
  });

  it("derives cost-sensitive from a low total architecture cost", () => {
    const architecture = makeArchitecture({
      nodes: [
        { id: "s1", kind: "server", label: "S", position: { x: 0, y: 0 }, capacity: 100, latency: 5, replicas: 1, cacheHitRate: 0, enabled: true, cost: 50 },
      ],
    });
    const traits = workloadTraits(makeWorkload(), architecture);
    expect(traits).toContain("cost-sensitive");
  });

  it("derives low-latency from a tight deadline", () => {
    const traits = workloadTraits(makeWorkload({ deadlineMs: 100 }), makeArchitecture());
    expect(traits).toContain("low-latency");
  });
});

describe("fitScore", () => {
  it("returns 0 with no traits", () => {
    const option = techCatalog.find((item) => item.id === "postgresql")!;
    expect(fitScore(option, [])).toBe(0);
  });

  it("scores positively when a fit trait matches and nothing is avoided", () => {
    const option = techCatalog.find((item) => item.id === "cassandra")!;
    const score = fitScore(option, ["write-heavy"]);
    expect(score).toBeGreaterThan(0);
  });

  it("scores negatively when an avoid trait matches", () => {
    const option = techCatalog.find((item) => item.id === "cassandra")!;
    const score = fitScore(option, ["strong-consistency"]);
    expect(score).toBeLessThan(0);
  });

  it("stays within [-1, 1]", () => {
    const traits: Trait[] = ["read-heavy", "write-heavy", "hot-keys", "strong-consistency", "analytics", "large-objects", "global", "streaming", "low-latency", "cost-sensitive"];
    for (const option of techCatalog) {
      const score = fitScore(option, traits);
      expect(score).toBeGreaterThanOrEqual(-1);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe("suggestFor", () => {
  it("ranks Cassandra above PostgreSQL for write-heavy + hot-keys workloads", () => {
    const ranked = suggestFor("database", ["write-heavy", "hot-keys"]);
    const cassandraIndex = ranked.findIndex((option) => option.id === "cassandra");
    const postgresIndex = ranked.findIndex((option) => option.id === "postgresql");
    expect(cassandraIndex).toBeGreaterThanOrEqual(0);
    expect(postgresIndex).toBeGreaterThanOrEqual(0);
    expect(cassandraIndex).toBeLessThan(postgresIndex);
  });

  it("ranks PostgreSQL and CockroachDB above Cassandra for strong-consistency workloads", () => {
    const ranked = suggestFor("database", ["strong-consistency"]);
    const cassandraIndex = ranked.findIndex((option) => option.id === "cassandra");
    const postgresIndex = ranked.findIndex((option) => option.id === "postgresql");
    const cockroachIndex = ranked.findIndex((option) => option.id === "cockroachdb");
    expect(postgresIndex).toBeLessThan(cassandraIndex);
    expect(cockroachIndex).toBeLessThan(cassandraIndex);
  });

  it("only returns options of the requested kind", () => {
    for (const kind of kinds) {
      const ranked = suggestFor(kind, ["read-heavy"]);
      expect(ranked.every((option) => option.kind === kind)).toBe(true);
    }
  });

  it("sorts strictly by descending fit score", () => {
    const ranked = suggestFor("cache", ["read-heavy", "low-latency"]);
    for (let i = 1; i < ranked.length; i++) {
      expect(fitScore(ranked[i - 1], ["read-heavy", "low-latency"])).toBeGreaterThanOrEqual(
        fitScore(ranked[i], ["read-heavy", "low-latency"]),
      );
    }
  });
});
