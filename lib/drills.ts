/**
 * Estimation gym: randomized back-of-envelope drills with a seeded generator and a
 * tolerance-based checker. Spec: docs/superpowers/specs/2026-09-10-systemlab-v2-design.md §9.
 */

export interface DrillTemplate {
  id: string;
  title: string;
  topic: string;
  kind: "numeric" | "choice";
  generate(seed: number): DrillInstance;
}

export interface DrillInstance {
  prompt: string;
  unit: string;
  /** Numeric templates: the correct value. Choice templates: the index of the correct choice. */
  answer: number;
  /** Absolute allowed deviation from `answer` for numeric templates. 0 for choice templates (exact match). */
  tolerance: number;
  choices?: string[];
  explanation: string;
  working: string;
}

// ---------------------------------------------------------------------------
// Seeded RNG (xorshift32, same construction as lib/simulation/index.ts) — never Math.random.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function randRange(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min);
}
function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(randRange(rand, min, max + 1));
}
function pickOne<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}
function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
function fmt(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}
/** Absolute tolerance as a fraction of the answer's magnitude, with a floor so it's never zero. */
function relTol(value: number, rel = 0.2, floor = 0.01): number {
  return Math.max(Math.abs(value) * rel, floor);
}

// A distinct salt per template keeps parameters from lining up across templates that share a seed.
let saltCounter = 1;
function nextSalt(): number {
  saltCounter += 0x9e3779b1;
  return saltCounter;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const avgQpsSalt = nextSalt();
const avgQps: DrillTemplate = {
  id: "avg-qps",
  title: "Average QPS from DAU",
  topic: "Traffic estimation",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ avgQpsSalt);
    const dau = randInt(rand, 100_000, 5_000_000);
    const requestsPerUser = randInt(rand, 5, 50);
    const answer = round((dau * requestsPerUser) / 86_400, 2);
    return {
      prompt: `A service has ${fmt(dau)} daily active users, each making ${requestsPerUser} requests/day on average. What is the average QPS?`,
      unit: "req/s",
      answer,
      tolerance: relTol(answer),
      explanation: `Average QPS = DAU x requests/user/day / seconds/day.`,
      working: `${fmt(dau)} x ${requestsPerUser} / 86,400 = ${fmt(answer)} req/s.`,
    };
  },
};

const peakQpsSalt = nextSalt();
const peakQps: DrillTemplate = {
  id: "peak-qps",
  title: "Peak QPS from average QPS",
  topic: "Traffic estimation",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ peakQpsSalt);
    const avg = randInt(rand, 50, 50_000);
    const peakFactor = round(randRange(rand, 2, 5), 1);
    const answer = round(avg * peakFactor, 2);
    return {
      prompt: `Average traffic is ${fmt(avg)} req/s. During peak hours traffic runs at ${peakFactor}x average. What is the peak QPS?`,
      unit: "req/s",
      answer,
      tolerance: relTol(answer),
      explanation: `Peak QPS = average QPS x peak factor.`,
      working: `${fmt(avg)} x ${peakFactor} = ${fmt(answer)} req/s.`,
    };
  },
};

const storageSalt = nextSalt();
const storagePerYear: DrillTemplate = {
  id: "storage-per-year",
  title: "Storage growth per year",
  topic: "Capacity estimation",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ storageSalt);
    const writesPerDay = randInt(rand, 100_000, 10_000_000);
    const sizeKB = round(randRange(rand, 0.5, 50), 2);
    const bytesPerYear = writesPerDay * sizeKB * 1000 * 365;
    const answer = round(bytesPerYear / 1e9, 2);
    return {
      prompt: `The system records ${fmt(writesPerDay)} writes/day, each averaging ${sizeKB} KB. How much storage (GB) does a year of writes need?`,
      unit: "GB/year",
      answer,
      tolerance: relTol(answer),
      explanation: `Yearly storage = writes/day x size x 365 days, converted to GB (1 KB = 1,000 B, 1 GB = 1e9 B).`,
      working: `${fmt(writesPerDay)} x ${sizeKB} KB x 365 = ${fmt(round(bytesPerYear))} B = ${fmt(answer)} GB.`,
    };
  },
};

const bandwidthSalt = nextSalt();
const bandwidth: DrillTemplate = {
  id: "bandwidth",
  title: "Bandwidth from QPS and payload size",
  topic: "Capacity estimation",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ bandwidthSalt);
    const qps = randInt(rand, 100, 50_000);
    const payloadKB = round(randRange(rand, 1, 500), 2);
    const bytesPerSec = qps * payloadKB * 1000;
    const answer = round((bytesPerSec * 8) / 1e6, 2);
    return {
      prompt: `Traffic is ${fmt(qps)} req/s with an average payload of ${payloadKB} KB. What bandwidth (Mbps) does that need?`,
      unit: "Mbps",
      answer,
      tolerance: relTol(answer),
      explanation: `Bandwidth = QPS x payload size x 8 bits/byte, converted to Mbps.`,
      working: `${fmt(qps)} x ${payloadKB} KB x 1,000 B/KB x 8 bits / 1e6 = ${fmt(answer)} Mbps.`,
    };
  },
};

const serversSalt = nextSalt();
const serversNeeded: DrillTemplate = {
  id: "servers-needed",
  title: "Servers needed with headroom",
  topic: "Capacity estimation",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ serversSalt);
    const qps = randInt(rand, 100, 20_000);
    const capacityPerServer = randInt(rand, 50, 500);
    const raw = (qps / capacityPerServer) * 1.3;
    const answer = Math.ceil(raw);
    return {
      prompt: `Traffic is ${fmt(qps)} req/s and one server handles ${capacityPerServer} req/s. Sizing for 30% headroom, how many servers are needed?`,
      unit: "servers",
      answer,
      tolerance: relTol(answer, 0.2, 1),
      explanation: `Servers = ceil(QPS / capacity per server x 1.3 headroom).`,
      working: `ceil(${fmt(qps)} / ${capacityPerServer} x 1.3) = ceil(${round(raw, 2)}) = ${answer} servers.`,
    };
  },
};

const cacheSalt = nextSalt();
const cacheHotSize: DrillTemplate = {
  id: "cache-hot-size",
  title: "Cache size for the hot dataset",
  topic: "Capacity estimation",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ cacheSalt);
    const datasetGB = randInt(rand, 10, 5000);
    const hotFraction = round(randRange(rand, 0.1, 0.3), 2);
    const answer = round(datasetGB * hotFraction, 2);
    return {
      prompt: `The dataset is ${fmt(datasetGB)} GB and ${Math.round(hotFraction * 100)}% of it accounts for most reads (hot set). How big should the cache be to hold the hot set?`,
      unit: "GB",
      answer,
      tolerance: relTol(answer),
      explanation: `Cache size = dataset size x hot fraction.`,
      working: `${fmt(datasetGB)} GB x ${hotFraction} = ${fmt(answer)} GB.`,
    };
  },
};

const littlesQueueSalt = nextSalt();
const littlesLawQueueDepth: DrillTemplate = {
  id: "littles-law-queue-depth",
  title: "Little's law: queue depth",
  topic: "Queueing theory",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ littlesQueueSalt);
    const arrivalRate = randInt(rand, 10, 5000);
    const waitMs = randInt(rand, 5, 500);
    const answer = round(arrivalRate * (waitMs / 1000), 2);
    return {
      prompt: `Requests arrive at ${fmt(arrivalRate)} req/s and each spends ${waitMs} ms in the system on average. By Little's law, what's the average number of requests in the system (queue depth)?`,
      unit: "requests",
      answer,
      tolerance: relTol(answer),
      explanation: `Little's law: L = lambda x W (arrival rate x average time in system).`,
      working: `${fmt(arrivalRate)} req/s x ${waitMs} ms (${waitMs / 1000} s) = ${fmt(answer)} requests.`,
    };
  },
};

const littlesWaitSalt = nextSalt();
const littlesLawWaitTime: DrillTemplate = {
  id: "littles-law-wait-time",
  title: "Little's law: wait time",
  topic: "Queueing theory",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ littlesWaitSalt);
    const queueDepth = randInt(rand, 1, 500);
    const arrivalRate = randInt(rand, 10, 2000);
    const answer = round((queueDepth / arrivalRate) * 1000, 2);
    return {
      prompt: `On average there are ${fmt(queueDepth)} requests in the system and requests arrive at ${fmt(arrivalRate)} req/s. By Little's law, what's the average time (ms) each request spends in the system?`,
      unit: "ms",
      answer,
      tolerance: relTol(answer),
      explanation: `Little's law: W = L / lambda (queue depth / arrival rate), converted to ms.`,
      working: `${fmt(queueDepth)} / ${fmt(arrivalRate)} req/s = ${round(queueDepth / arrivalRate, 4)} s = ${fmt(answer)} ms.`,
    };
  },
};

const rpoSalt = nextSalt();
const rpoFromReplicationLag: DrillTemplate = {
  id: "rpo-from-replication-lag",
  title: "RPO from replication lag",
  topic: "Reliability",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ rpoSalt);
    const lagMs = randInt(rand, 50, 5000);
    const answer = round(lagMs / 1000, 2);
    return {
      prompt: `An async replica lags the primary by ${fmt(lagMs)} ms on average. If the primary fails and you fail over to the replica, what's the recovery point objective (RPO) in seconds — the worst-case data you could lose?`,
      unit: "s",
      answer,
      tolerance: relTol(answer),
      explanation: `With async replication, RPO is bounded by the replication lag: data written but not yet replicated can be lost.`,
      working: `${fmt(lagMs)} ms / 1,000 = ${fmt(answer)} s.`,
    };
  },
};

const dbLoadSalt = nextSalt();
const dbLoadAfterCache: DrillTemplate = {
  id: "db-load-after-cache",
  title: "DB load after adding a cache",
  topic: "Caching",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ dbLoadSalt);
    const readsQps = randInt(rand, 100, 10_000);
    const writesQps = randInt(rand, 50, 3000);
    const hitRate = round(randRange(rand, 0.5, 0.95), 2);
    const answer = round(readsQps * (1 - hitRate) + writesQps, 2);
    return {
      prompt: `Reads run at ${fmt(readsQps)} req/s and writes at ${fmt(writesQps)} req/s. A cache in front of reads has a ${Math.round(hitRate * 100)}% hit rate and writes always go straight to the DB. What's the resulting load on the database (req/s)?`,
      unit: "req/s",
      answer,
      tolerance: relTol(answer),
      explanation: `DB load = reads x (1 - hit rate) + writes (cache misses plus all writes).`,
      working: `${fmt(readsQps)} x (1 - ${hitRate}) + ${fmt(writesQps)} = ${fmt(round(readsQps * (1 - hitRate), 2))} + ${fmt(writesQps)} = ${fmt(answer)} req/s.`,
    };
  },
};

const shardSalt = nextSalt();
const shardCount: DrillTemplate = {
  id: "shard-count",
  title: "Shard count from write QPS",
  topic: "Capacity estimation",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ shardSalt);
    const writeQps = randInt(rand, 1000, 200_000);
    const perShardCapacity = randInt(rand, 500, 5000);
    const answer = Math.ceil(writeQps / perShardCapacity);
    return {
      prompt: `Write traffic is ${fmt(writeQps)} req/s and one shard can sustain ${fmt(perShardCapacity)} writes/s. How many shards are needed?`,
      unit: "shards",
      answer,
      tolerance: relTol(answer, 0.2, 1),
      explanation: `Shard count = ceil(write QPS / per-shard write capacity).`,
      working: `ceil(${fmt(writeQps)} / ${fmt(perShardCapacity)}) = ${answer} shards.`,
    };
  },
};

const retrySalt = nextSalt();
const retryAmplification: DrillTemplate = {
  id: "retry-amplification",
  title: "Retry amplification",
  topic: "Reliability",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ retrySalt);
    const baseQps = randInt(rand, 100, 5000);
    const failureRate = round(randRange(rand, 0.01, 0.3), 2);
    const retries = randInt(rand, 1, 3);
    let multiplier = 0;
    for (let k = 0; k <= retries; k++) multiplier += failureRate ** k;
    const answer = round(baseQps * multiplier, 2);
    return {
      prompt: `A downstream call runs at ${fmt(baseQps)} req/s, fails ${Math.round(failureRate * 100)}% of the time, and callers retry up to ${retries} time(s) on failure. What's the actual call rate the downstream receives (req/s), counting retries?`,
      unit: "req/s",
      answer,
      tolerance: relTol(answer),
      explanation: `Expected calls per request = sum of f^k for k = 0..retries (each retry only happens if the prior attempt failed). Amplified rate = base rate x that sum.`,
      working: `sum_{k=0}^{${retries}} ${failureRate}^k = ${round(multiplier, 4)}; ${fmt(baseQps)} x ${round(multiplier, 4)} = ${fmt(answer)} req/s.`,
    };
  },
};

const availabilityPool = [99.5, 99.9, 99.95, 99.99, 99.999];
const availabilitySalt = nextSalt();
const availabilityFromSerialDeps: DrillTemplate = {
  id: "availability-serial-deps",
  title: "Availability of serial dependencies",
  topic: "Reliability",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ availabilitySalt);
    const count = randInt(rand, 3, 5);
    const deps: number[] = [];
    for (let i = 0; i < count; i++) deps.push(pickOne(rand, availabilityPool));
    const product = deps.reduce((acc, d) => acc * (d / 100), 1);
    const answer = round(product * 100, 3);
    return {
      prompt: `A request must succeed through ${count} services in series, each with availability ${deps.map((d) => `${d}%`).join(", ")}. If any one fails the request fails, what's the overall availability (%)?`,
      unit: "%",
      answer,
      tolerance: 0.1,
      explanation: `Serial (dependent) availability is the product of each component's availability: one failure fails the whole chain.`,
      working: `${deps.map((d) => (d / 100).toFixed(5)).join(" x ")} = ${round(product, 6)} = ${fmt(answer)}%.`,
    };
  },
};

const crossRegionSalt = nextSalt();
const crossRegionRoundTrips: DrillTemplate = {
  id: "cross-region-round-trips",
  title: "Cross-region round trip latency",
  topic: "Latency",
  kind: "numeric",
  generate(seed) {
    const rand = makeRng(seed ^ crossRegionSalt);
    const roundTrips = randInt(rand, 1, 6);
    const rttMs = pickOne(rand, [80, 120, 150, 200, 250]);
    const answer = roundTrips * rttMs;
    return {
      prompt: `A request needs ${roundTrips} sequential round trip(s) to a service in another region, where the round-trip time is ${rttMs} ms. How much latency (ms) does that add?`,
      unit: "ms",
      answer,
      tolerance: relTol(answer, 0.2, 1),
      explanation: `Sequential cross-region latency = number of round trips x RTT per round trip.`,
      working: `${roundTrips} x ${rttMs} ms = ${answer} ms.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Latency numbers quiz (choice)
// ---------------------------------------------------------------------------

interface LatencyFact {
  question: string;
  answerLabel: string;
}
const latencyFacts: LatencyFact[] = [
  { question: "an L1 cache reference", answerLabel: "~1 ns" },
  { question: "a main memory reference", answerLabel: "~100 ns" },
  { question: "a random read from SSD", answerLabel: "~100 µs" },
  { question: "a disk seek on a spinning HDD", answerLabel: "~10 ms" },
  { question: "a round trip within the same datacenter", answerLabel: "~0.5 ms" },
  { question: "a round trip across continents (e.g. US to Europe)", answerLabel: "~150 ms" },
  { question: "sending 1 MB over a 1 Gbps link", answerLabel: "~10 ms" },
];
const latencyChoicePool = ["~1 ns", "~100 ns", "~100 µs", "~10 ms", "~0.5 ms", "~150 ms"];

function shuffle<T>(rand: () => number, arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const latencySalt = nextSalt();
const latencyNumbersQuiz: DrillTemplate = {
  id: "latency-numbers-quiz",
  title: "Latency numbers every engineer should know",
  topic: "Latency",
  kind: "choice",
  generate(seed) {
    const rand = makeRng(seed ^ latencySalt);
    const fact = pickOne(rand, latencyFacts);
    const wrongPool = latencyChoicePool.filter((label) => label !== fact.answerLabel);
    const wrong = shuffle(rand, wrongPool).slice(0, 3);
    const choices = shuffle(rand, [fact.answerLabel, ...wrong]);
    const answer = choices.indexOf(fact.answerLabel);
    return {
      prompt: `Roughly how long does ${fact.question} take?`,
      unit: "",
      answer,
      tolerance: 0,
      choices,
      explanation: `${fact.question[0].toUpperCase()}${fact.question.slice(1)} is on the order of ${fact.answerLabel}.`,
      working: `Correct choice: "${fact.answerLabel}" (index ${answer}).`,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const drills: DrillTemplate[] = [
  avgQps,
  peakQps,
  storagePerYear,
  bandwidth,
  serversNeeded,
  cacheHotSize,
  littlesLawQueueDepth,
  littlesLawWaitTime,
  rpoFromReplicationLag,
  dbLoadAfterCache,
  shardCount,
  retryAmplification,
  availabilityFromSerialDeps,
  crossRegionRoundTrips,
  latencyNumbersQuiz,
];

export function checkDrill(
  template: DrillTemplate,
  seed: number,
  answer: number
): { correct: boolean; expected: number; explanation: string } {
  const instance = template.generate(seed);
  const correct =
    template.kind === "choice"
      ? answer === instance.answer
      : Number.isFinite(answer) && Math.abs(answer - instance.answer) <= instance.tolerance + 1e-9;
  return { correct, expected: instance.answer, explanation: instance.explanation };
}

export function pickDrill(seed: number): { template: DrillTemplate; instance: DrillInstance } {
  const rand = makeRng(seed ^ 0xc0ffee);
  // xorshift32's first draw correlates too strongly across nearby seeds; warm it up before using it.
  rand();
  rand();
  const index = Math.floor(rand() * drills.length) % drills.length;
  const template = drills[index];
  return { template, instance: template.generate(seed) };
}
