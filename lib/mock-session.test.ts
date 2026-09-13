import { describe, expect, it } from "vitest";
import type { Architecture } from "./types";
import {
  BASE_PHASE_MINUTES,
  DRIFT_SECONDS,
  FULL_SESSION_MINUTES,
  MOCK_PHASES,
  apiTranscript,
  createMockSession,
  currentPhase,
  endSession,
  formatClock,
  hasSubstance,
  needsInterrupt,
  nextPhase,
  noteInterrupt,
  phaseAt,
  phaseBudget,
  phaseOvertime,
  phasePlan,
  phaseRemaining,
  recordUtterance,
  sessionRemaining,
  sessionSeconds,
  summarizeCanvas,
  summarizeRun,
  tick,
  type MockPhase,
} from "./mock-session";

function advance(session: ReturnType<typeof createMockSession>, seconds: number) {
  let next = session;
  for (let i = 0; i < seconds; i++) next = tick(next);
  return next;
}

describe("phasePlan", () => {
  it("gives the 45-minute session the documented budgets", () => {
    const plan = phasePlan(45);
    expect(plan.map((slot) => slot.phase)).toEqual([...MOCK_PHASES]);
    expect(plan.map((slot) => slot.seconds)).toEqual([300, 300, 1200, 600, 300]);
    expect(plan[plan.length - 1]!.endSeconds).toBe(2700);
  });

  it("defaults to the full session length", () => {
    expect(phasePlan()).toEqual(phasePlan(FULL_SESSION_MINUTES));
  });

  it("scales proportionally to a 30-minute session and still tiles it exactly", () => {
    const plan = phasePlan(30);
    expect(plan.map((slot) => slot.seconds)).toEqual([200, 200, 800, 400, 200]);
    expect(plan.reduce((sum, slot) => sum + slot.seconds, 0)).toBe(sessionSeconds(30));
  });

  it("keeps slots contiguous and sums to the session for every length", () => {
    for (const minutes of [20, 30, 40, 45, 60, 90]) {
      const plan = phasePlan(minutes);
      expect(plan[0]!.startSeconds).toBe(0);
      for (let i = 1; i < plan.length; i++) {
        expect(plan[i]!.startSeconds).toBe(plan[i - 1]!.endSeconds);
      }
      expect(plan.reduce((sum, slot) => sum + slot.seconds, 0)).toBe(sessionSeconds(minutes));
      expect(plan[plan.length - 1]!.endSeconds).toBe(sessionSeconds(minutes));
      for (const slot of plan) expect(slot.seconds).toBeGreaterThan(0);
    }
  });

  it("keeps the relative weight of each phase when it scales", () => {
    const full = phasePlan(45);
    const half = phasePlan(30);
    MOCK_PHASES.forEach((phase, index) => {
      const expected = (BASE_PHASE_MINUTES[phase] * 60 * 30) / 45;
      expect(Math.abs(half[index]!.seconds - expected)).toBeLessThanOrEqual(1);
      expect(half[index]!.seconds).toBeLessThan(full[index]!.seconds);
    });
  });
});

describe("phaseAt", () => {
  it("maps session seconds onto the phase that owns them", () => {
    const plan = phasePlan(45);
    const expected: [number, MockPhase][] = [
      [0, "clarify"],
      [299, "clarify"],
      [300, "estimate"],
      [600, "design"],
      [1799, "design"],
      [1800, "deep-dive"],
      [2400, "wrap"],
      [2699, "wrap"],
      [9999, "wrap"],
    ];
    for (const [seconds, phase] of expected) expect(phaseAt(plan, seconds)).toBe(phase);
  });
});

describe("session clocks", () => {
  it("starts in clarify with the full budget", () => {
    const session = createMockSession("lesson", 45);
    expect(currentPhase(session)).toBe("clarify");
    expect(phaseBudget(session)).toBe(300);
    expect(phaseRemaining(session)).toBe(300);
    expect(sessionRemaining(session)).toBe(2700);
    expect(session.ended).toBe(false);
  });

  it("advances both clocks and books the time against the current phase", () => {
    const session = advance(createMockSession("lesson", 45), 90);
    expect(session.elapsedSeconds).toBe(90);
    expect(session.phaseElapsedSeconds).toBe(90);
    expect(session.phaseSeconds.clarify).toBe(90);
    expect(session.phaseSeconds.design).toBe(0);
    expect(phaseRemaining(session)).toBe(210);
  });

  it("counts phase overtime instead of moving on by itself", () => {
    const session = tick(createMockSession("lesson", 45), 360);
    expect(currentPhase(session)).toBe("clarify");
    expect(phaseRemaining(session)).toBe(0);
    expect(phaseOvertime(session)).toBe(60);
    expect(session.ended).toBe(false);
  });

  it("ends when the session clock is spent", () => {
    const session = tick(createMockSession("lesson", 30), 1800);
    expect(session.ended).toBe(true);
    expect(sessionRemaining(session)).toBe(0);
    expect(tick(session, 60).elapsedSeconds).toBe(1800);
  });

  it("ignores non-positive ticks", () => {
    const session = createMockSession("lesson", 45);
    expect(tick(session, 0)).toBe(session);
    expect(tick(session, -5)).toBe(session);
  });
});

describe("phase transitions", () => {
  it("walks the five phases in order and ends after wrap", () => {
    let session = createMockSession("lesson", 45);
    const seen: MockPhase[] = [currentPhase(session)];
    for (let i = 0; i < 4; i++) {
      session = nextPhase(session);
      seen.push(currentPhase(session));
      expect(session.ended).toBe(false);
    }
    expect(seen).toEqual(["clarify", "estimate", "design", "deep-dive", "wrap"]);
    session = nextPhase(session);
    expect(session.ended).toBe(true);
    expect(currentPhase(session)).toBe("wrap");
  });

  it("resets the phase clock but keeps the session clock and the time already booked", () => {
    const started = advance(createMockSession("lesson", 45), 120);
    const moved = nextPhase(started);
    expect(moved.phaseElapsedSeconds).toBe(0);
    expect(moved.elapsedSeconds).toBe(120);
    expect(moved.phaseSeconds.clarify).toBe(120);
    expect(currentPhase(moved)).toBe("estimate");
    expect(phaseBudget(moved)).toBe(300);
  });

  it("books later ticks against the new phase", () => {
    const session = advance(nextPhase(advance(createMockSession("lesson", 45), 60)), 45);
    expect(session.phaseSeconds).toMatchObject({ clarify: 60, estimate: 45, design: 0 });
    expect(session.elapsedSeconds).toBe(105);
  });

  it("scales the phase budgets a 30-minute session moves through", () => {
    let session = createMockSession("lesson", 30);
    const budgets: number[] = [];
    for (let i = 0; i < MOCK_PHASES.length; i++) {
      budgets.push(phaseBudget(session));
      session = nextPhase(session);
    }
    expect(budgets).toEqual([200, 200, 800, 400, 200]);
  });

  it("never advances once the session has ended", () => {
    const ended = endSession(createMockSession("lesson", 45));
    expect(nextPhase(ended)).toBe(ended);
    expect(endSession(ended)).toBe(ended);
  });
});

describe("transcript", () => {
  it("stamps every entry with the phase and the session clock", () => {
    let session = advance(createMockSession("lesson", 45), 30);
    session = recordUtterance(session, "interviewer", "Design a URL shortener.", { intent: "probe" });
    session = nextPhase(advance(session, 10));
    session = recordUtterance(session, "candidate", "About 500 writes per second.");
    expect(session.transcript).toEqual([
      { role: "interviewer", text: "Design a URL shortener.", phase: "clarify", at: 30, intent: "probe" },
      { role: "candidate", text: "About 500 writes per second.", phase: "estimate", at: 40 },
    ]);
  });

  it("drops blank utterances and trims the rest", () => {
    let session = createMockSession("lesson", 45);
    session = recordUtterance(session, "candidate", "   ");
    expect(session.transcript).toHaveLength(0);
    session = recordUtterance(session, "candidate", "  hello  ");
    expect(session.transcript[0]!.text).toBe("hello");
  });

  it("hands the API the last entries as role/text pairs", () => {
    let session = createMockSession("lesson", 45);
    for (let i = 0; i < 5; i++) session = recordUtterance(session, "candidate", `line ${i}`);
    expect(apiTranscript(session, 2)).toEqual([
      { role: "candidate", text: "line 3" },
      { role: "candidate", text: "line 4" },
    ]);
  });
});

describe("interruption bookkeeping", () => {
  it("recognises numbers and decisions as substance", () => {
    expect(hasSubstance("about 500 writes per second")).toBe(true);
    expect(hasSubstance("I'll shard on user id")).toBe(true);
    expect(hasSubstance("so it is kind of like, you know, a thing")).toBe(false);
  });

  it("interrupts once when the phase clock runs out", () => {
    let session = tick(createMockSession("lesson", 45), 300);
    expect(needsInterrupt(session)).toBe("phase-over");
    session = noteInterrupt(session, "phase-over");
    expect(needsInterrupt(session)).toBe(null);
    // The next phase re-arms it.
    session = tick(nextPhase(session), 300);
    expect(needsInterrupt(session)).toBe("phase-over");
  });

  it("interrupts after 90 seconds of candidate speech with no number and no decision", () => {
    let session = createMockSession("lesson", 45);
    session = recordUtterance(advance(session, 10), "candidate", "so, thinking about it broadly, the users would want a good experience");
    expect(session.driftSince).toBe(10);
    expect(needsInterrupt(advance(session, DRIFT_SECONDS - 1))).toBe(null);
    const drifted = advance(session, DRIFT_SECONDS);
    expect(needsInterrupt(drifted)).toBe("drift");
    expect(needsInterrupt(noteInterrupt(drifted, "drift"))).toBe(null);
  });

  it("does not drift while the candidate is silent, and a number clears the drift clock", () => {
    const idle = advance(createMockSession("lesson", 45), DRIFT_SECONDS + 30);
    expect(idle.driftSince).toBe(null);
    expect(needsInterrupt(idle)).toBe(null);
    let session = recordUtterance(advance(createMockSession("lesson", 45), 5), "candidate", "well, it depends really");
    session = recordUtterance(advance(session, 20), "candidate", "about 500 writes per second");
    expect(session.driftSince).toBe(null);
    expect(session.lastSubstanceAt).toBe(25);
    expect(needsInterrupt(advance(session, DRIFT_SECONDS + 10))).toBe(null);
  });

  it("counts interviewer interruptions and remembers when the last one landed", () => {
    let session = advance(createMockSession("lesson", 45), 200);
    session = recordUtterance(session, "interviewer", "Hold on - what is the write rate?", { intent: "pushback", interrupt: true });
    expect(session.interruptions).toBe(1);
    expect(session.lastInterruptAt).toBe(200);
    expect(session.transcript[0]!.interrupt).toBe(true);
    session = recordUtterance(session, "interviewer", "And the read path?", { intent: "probe" });
    expect(session.interruptions).toBe(1);
  });

  it("never interrupts a finished session", () => {
    const session = tick(createMockSession("lesson", 30), 1800);
    expect(needsInterrupt(session)).toBe(null);
  });
});

describe("canvas snapshot", () => {
  const architecture: Architecture = {
    nodes: [
      { id: "traffic", kind: "traffic", label: "Incoming traffic", position: { x: 0, y: 0 }, capacity: 10000, latency: 0, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
      { id: "app", kind: "server", label: "App", position: { x: 1, y: 0 }, capacity: 200, latency: 15, replicas: 3, cacheHitRate: 0, enabled: true, cost: 1, timeoutMs: 500, retries: 2 },
      { id: "db", kind: "database", label: "Orders DB", position: { x: 2, y: 0 }, capacity: 150, latency: 25, replicas: 3, cacheHitRate: 0, enabled: true, cost: 4, dbMode: "leader-follower", election: "consensus", replicationLagMs: 200 },
      { id: "blobs", kind: "object-store", label: "Media", position: { x: 3, y: 0 }, capacity: 3000, latency: 40, replicas: 1, cacheHitRate: 0, enabled: false, cost: 1, storedGb: 400 },
      { id: "log", kind: "stream", label: "Events", position: { x: 4, y: 0 }, capacity: 20000, latency: 2, replicas: 1, cacheHitRate: 0, enabled: true, cost: 2, partitions: 12, consumerGroups: 2, retentionSeconds: 86400 },
    ],
    edges: [
      { id: "e1", source: "traffic", target: "app" },
      { id: "e2", source: "app", target: "db" },
      { id: "e3", source: "app", target: "log" },
    ],
  };

  it("writes one line per node with capacity, replicas, settings and edges", () => {
    const lines = summarizeCanvas(architecture).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("Incoming traffic (traffic); -> App");
    expect(lines[1]).toBe("App (server); 200 cap x 3 replicas; timeout 500ms, 2 retries; -> Orders DB, Events");
    expect(lines[2]).toContain("leader-follower, consensus election, 200ms replication lag");
    expect(lines[2]).toContain("-> nothing");
    expect(lines[3]).toContain("object-store, disabled");
    expect(lines[3]).toContain("400 GB stored");
    expect(lines[4]).toContain("12 partitions, 2 consumer groups, 24h retention");
  });

  it("handles an empty canvas", () => {
    expect(summarizeCanvas({ nodes: [], edges: [] })).toBe("Empty canvas.");
  });
});

describe("run summary and clock formatting", () => {
  it("renders the headline numbers", () => {
    expect(summarizeRun(null)).toBe("No run yet.");
    expect(summarizeRun({ p95: 212.6, p99: 480, throughput: 198.44, errorRate: 0.0123, rejectedRate: 0, cost: 12.5 }))
      .toBe("p95 213ms, p99 480ms, throughput 198.4 req/s, error rate 1.23%, rejected 0.00%, cost $12.50/h");
  });

  it("formats clocks as mm:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(2700)).toBe("45:00");
    expect(formatClock(-10)).toBe("0:00");
  });
});
