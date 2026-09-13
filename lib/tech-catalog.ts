import type { Architecture, NodeKind, Workload } from "./types";

export type Trait =
  | "read-heavy"
  | "write-heavy"
  | "hot-keys"
  | "strong-consistency"
  | "analytics"
  | "large-objects"
  | "global"
  | "streaming"
  | "low-latency"
  | "cost-sensitive";

export interface TechOption {
  id: string;
  name: string;
  kind: NodeKind;
  fits: Trait[];
  avoid: Trait[];
  /** One sentence: what it is good at and its main operational cost. */
  note: string;
}

export const techCatalog: TechOption[] = [
  // server
  {
    id: "node-express",
    name: "Node/Express",
    kind: "server",
    fits: ["low-latency", "streaming", "cost-sensitive"],
    avoid: [],
    note: "Single-threaded event loop is great for I/O-bound, low-latency request handling, but a CPU-heavy handler blocks the whole process.",
  },
  {
    id: "go-service",
    name: "Go service",
    kind: "server",
    fits: ["low-latency", "streaming", "cost-sensitive"],
    avoid: [],
    note: "Goroutines give cheap concurrency and predictable low tail latency, at the cost of a smaller library ecosystem than JVM/Node for niche integrations.",
  },
  {
    id: "jvm-spring",
    name: "JVM/Spring",
    kind: "server",
    fits: ["strong-consistency", "analytics"],
    avoid: ["cost-sensitive"],
    note: "Mature transactional and enterprise-integration tooling, but JVM warm-up and per-instance memory footprint raise baseline hosting cost.",
  },
  {
    id: "python-fastapi",
    name: "Python/FastAPI",
    kind: "server",
    fits: ["analytics"],
    avoid: ["low-latency"],
    note: "Fast to build and ideal for gluing in data/ML libraries, but the GIL caps single-process CPU-bound throughput.",
  },
  {
    id: "serverless-functions",
    name: "Serverless functions",
    kind: "server",
    fits: ["cost-sensitive", "global"],
    avoid: ["low-latency", "streaming"],
    note: "Scales to zero so idle traffic costs nothing, but cold starts add tail latency and long-lived connections (streaming) don't fit the model.",
  },
  {
    id: "rails",
    name: "Rails",
    kind: "server",
    fits: ["cost-sensitive"],
    avoid: ["low-latency"],
    note: "Convention-heavy framework that ships CRUD apps fast, but the interpreted runtime and ORM overhead limit per-instance throughput.",
  },

  // load-balancer
  {
    id: "nginx",
    name: "NGINX",
    kind: "load-balancer",
    fits: ["cost-sensitive", "low-latency"],
    avoid: [],
    note: "Lightweight reverse proxy and L7 load balancer with a huge deployment base, but dynamic reconfiguration (config reload) is coarser than newer proxies.",
  },
  {
    id: "haproxy",
    name: "HAProxy",
    kind: "load-balancer",
    fits: ["low-latency", "cost-sensitive"],
    avoid: [],
    note: "Extremely efficient L4/L7 balancer with fine-grained health checking, but its config language is more operational effort to template than cloud-native alternatives.",
  },
  {
    id: "envoy",
    name: "Envoy",
    kind: "load-balancer",
    fits: ["low-latency", "global", "streaming"],
    avoid: ["cost-sensitive"],
    note: "Programmable proxy with rich observability and service-mesh integration, at the cost of a steeper operational learning curve than NGINX/HAProxy.",
  },
  {
    id: "aws-alb",
    name: "AWS ALB",
    kind: "load-balancer",
    fits: ["cost-sensitive"],
    avoid: ["global"],
    note: "Fully managed L7 balancer that removes patching and scaling work, but it is regional so multi-region routing needs another layer on top.",
  },
  {
    id: "cloudflare-lb",
    name: "Cloudflare",
    kind: "load-balancer",
    fits: ["global", "low-latency"],
    avoid: [],
    note: "Anycast edge load balancing routes users to the nearest healthy region with no capacity planning, but deep request-level customization is more limited than a self-run proxy.",
  },

  // database
  {
    id: "postgresql",
    name: "PostgreSQL",
    kind: "database",
    fits: ["strong-consistency", "read-heavy"],
    avoid: ["hot-keys", "global"],
    note: "Rock-solid ACID relational store with rich indexing and joins, but write throughput on a single leader caps out and needs sharding work to scale further.",
  },
  {
    id: "mysql",
    name: "MySQL",
    kind: "database",
    fits: ["strong-consistency", "read-heavy", "cost-sensitive"],
    avoid: ["hot-keys", "global"],
    note: "Ubiquitous relational database with cheap managed hosting, but like Postgres it scales writes vertically until sharding or read replicas are added.",
  },
  {
    id: "cassandra",
    name: "Cassandra/ScyllaDB",
    kind: "database",
    fits: ["write-heavy", "hot-keys", "global"],
    avoid: ["strong-consistency"],
    note: "Leaderless, partitioned writes scale linearly and tolerate hot partitions better than a single-leader store, but only tunable eventual consistency and requires careful key design to avoid hot shards.",
  },
  {
    id: "dynamodb",
    name: "DynamoDB",
    kind: "database",
    fits: ["write-heavy", "global", "low-latency"],
    avoid: ["strong-consistency", "analytics"],
    note: "Fully managed key-value store with single-digit-millisecond latency at any scale, but ad-hoc queries and joins are unsupported and hot partition keys still throttle.",
  },
  {
    id: "mongodb",
    name: "MongoDB",
    kind: "database",
    fits: ["write-heavy", "large-objects"],
    avoid: ["strong-consistency"],
    note: "Flexible document model is convenient for evolving schemas and nested data, but multi-document transactions and cross-shard joins carry real performance cost.",
  },
  {
    id: "cockroachdb",
    name: "CockroachDB/Spanner",
    kind: "database",
    fits: ["strong-consistency", "global", "write-heavy"],
    avoid: ["cost-sensitive"],
    note: "Distributed SQL with strict serializability across regions, but cross-region consensus adds write latency and the operational/licensing cost is higher than a single-node database.",
  },
  {
    id: "clickhouse",
    name: "ClickHouse",
    kind: "database",
    fits: ["analytics", "read-heavy"],
    avoid: ["write-heavy", "strong-consistency"],
    note: "Columnar storage makes large aggregate scans extremely fast, but it is not built for high-frequency single-row transactional writes or updates.",
  },
  {
    id: "redis-store",
    name: "Redis-as-store",
    kind: "database",
    fits: ["low-latency", "hot-keys"],
    avoid: ["strong-consistency", "large-objects"],
    note: "In-memory data structures give sub-millisecond access for a primary store, but durability depends on snapshot/AOF tuning and total data size is bounded by RAM cost.",
  },

  // cache
  {
    id: "redis-cache",
    name: "Redis",
    kind: "cache",
    fits: ["read-heavy", "low-latency", "hot-keys"],
    avoid: [],
    note: "Rich data structures and optional persistence make it the default distributed cache, but a single hot key can still saturate one shard.",
  },
  {
    id: "memcached",
    name: "Memcached",
    kind: "cache",
    fits: ["read-heavy", "low-latency", "cost-sensitive"],
    avoid: ["large-objects"],
    note: "Simple multithreaded key-value cache with very low overhead per op, but it has no persistence or built-in replication so a restart loses everything.",
  },
  {
    id: "in-process-cache",
    name: "In-process/Caffeine",
    kind: "cache",
    fits: ["low-latency", "cost-sensitive"],
    avoid: ["global"],
    note: "Zero network hop makes it the fastest possible cache, but each replica has its own copy so invalidation across a fleet is not consistent.",
  },
  {
    id: "dynamodb-dax",
    name: "DynamoDB DAX",
    kind: "cache",
    fits: ["read-heavy", "low-latency", "hot-keys"],
    avoid: ["cost-sensitive"],
    note: "Write-through cache tier in front of DynamoDB removes cold-read latency with no application-level cache logic, but it only works for DynamoDB and adds a dedicated cluster to pay for.",
  },
  {
    id: "cdn-edge-cache",
    name: "CDN edge cache",
    kind: "cache",
    fits: ["read-heavy", "global", "large-objects", "cost-sensitive"],
    avoid: ["write-heavy"],
    note: "Caching responses at points of presence near the user cuts both latency and origin load for shareable content, but cache invalidation across edge nodes is slow and eventually consistent.",
  },

  // queue
  {
    id: "sqs",
    name: "SQS",
    kind: "queue",
    fits: ["cost-sensitive", "write-heavy"],
    avoid: ["streaming"],
    note: "Fully managed at-least-once queue that scales without operational effort, but no ordered multi-consumer replay so it fits task queues better than event streams.",
  },
  {
    id: "rabbitmq",
    name: "RabbitMQ",
    kind: "queue",
    fits: ["write-heavy"],
    avoid: ["streaming", "cost-sensitive"],
    note: "Flexible routing (exchanges, topics, priorities) suits complex task-distribution topologies, but clustering and quorum queues take real operational tuning to run at scale.",
  },
  {
    id: "kafka",
    name: "Kafka",
    kind: "queue",
    fits: ["streaming", "write-heavy", "analytics"],
    avoid: ["cost-sensitive"],
    note: "Durable, ordered log that many consumers can replay independently, but running and rebalancing brokers/partitions is significant operational overhead.",
  },
  {
    id: "pubsub",
    name: "Pub/Sub",
    kind: "queue",
    fits: ["streaming", "global", "cost-sensitive"],
    avoid: [],
    note: "Fully managed pub/sub messaging that scales globally with no broker management, but per-message pricing can get expensive at very high throughput.",
  },
  {
    id: "redis-streams",
    name: "Redis Streams",
    kind: "queue",
    fits: ["low-latency", "cost-sensitive"],
    avoid: ["streaming"],
    note: "Reuses an existing Redis deployment for lightweight streaming/queueing with very low latency, but durability and consumer-group semantics are weaker than a purpose-built log.",
  },

  // cdn
  {
    id: "cloudflare-cdn",
    name: "Cloudflare",
    kind: "cdn",
    fits: ["global", "cost-sensitive", "low-latency"],
    avoid: [],
    note: "Very large edge network with generous free tier for static assets, but advanced enterprise features (custom WAF rules, private network interconnects) sit behind paid plans.",
  },
  {
    id: "cloudfront",
    name: "CloudFront",
    kind: "cdn",
    fits: ["global", "large-objects"],
    avoid: ["cost-sensitive"],
    note: "Deep integration with S3/ALB origins simplifies AWS-native delivery, but data-transfer-out pricing is higher than specialist CDNs at large volume.",
  },
  {
    id: "fastly",
    name: "Fastly",
    kind: "cdn",
    fits: ["low-latency", "streaming"],
    avoid: ["cost-sensitive"],
    note: "Near-instant cache purge and programmable edge (VCL) suit fast-changing content and live streaming, but the pricing model favors high-volume customers over small ones.",
  },
  {
    id: "akamai",
    name: "Akamai",
    kind: "cdn",
    fits: ["global", "large-objects"],
    avoid: ["cost-sensitive"],
    note: "One of the largest, most mature edge footprints with strong enterprise security add-ons, but contracts and pricing are typically negotiated and costly at small scale.",
  },
  {
    id: "self-hosted-varnish",
    name: "Self-hosted Varnish",
    kind: "cdn",
    fits: ["cost-sensitive", "low-latency"],
    avoid: ["global"],
    note: "Running your own HTTP cache gives full control over caching rules with no per-request vendor fee, but you own capacity planning and it has no built-in global point-of-presence network.",
  },

  // rate-limiter
  {
    id: "envoy-ratelimit",
    name: "Envoy ratelimit",
    kind: "rate-limiter",
    fits: ["global", "low-latency"],
    avoid: ["cost-sensitive"],
    note: "Centralized gRPC rate-limit service integrates cleanly with an Envoy mesh for consistent multi-service limits, but it is another stateful service to run and keep available.",
  },
  {
    id: "nginx-limit-req",
    name: "NGINX limit_req",
    kind: "rate-limiter",
    fits: ["cost-sensitive", "low-latency"],
    avoid: ["global"],
    note: "Built into the proxy already handling traffic, so it costs nothing extra, but limits are per-instance (leaky bucket in shared memory) and don't coordinate across nodes.",
  },
  {
    id: "redis-token-bucket",
    name: "Redis token bucket",
    kind: "rate-limiter",
    fits: ["global", "hot-keys"],
    avoid: ["cost-sensitive"],
    note: "A shared counter gives accurate global limits across any number of stateless servers, but every request now costs a network round trip to Redis.",
  },
  {
    id: "api-gateway",
    name: "API gateway",
    kind: "rate-limiter",
    fits: ["global", "cost-sensitive"],
    avoid: ["low-latency"],
    note: "Managed gateway bundles auth, throttling and quotas with no infrastructure to run, but it adds an extra network hop and per-request cost to the critical path.",
  },
  {
    id: "in-memory-leaky-bucket",
    name: "In-memory leaky bucket",
    kind: "rate-limiter",
    fits: ["low-latency", "cost-sensitive"],
    avoid: ["global"],
    note: "A counter kept in application memory costs nothing extra and adds no latency, but each replica enforces its own limit so the effective global limit scales with replica count.",
  },

  // object-store
  {
    id: "s3",
    name: "Amazon S3",
    kind: "object-store",
    fits: ["large-objects", "global", "cost-sensitive"],
    avoid: ["low-latency"],
    note: "Eleven-nines durability and the deepest ecosystem of integrations for blob storage, but per-request pricing and typical tens-of-ms latency make it a poor fit for the hot request path.",
  },
  {
    id: "gcs",
    name: "Google Cloud Storage",
    kind: "object-store",
    fits: ["large-objects", "global", "cost-sensitive"],
    avoid: ["low-latency"],
    note: "Strong consistency on every operation and tight BigQuery/GCP integration, but cross-region egress and per-operation costs add up the same way S3's do.",
  },
  {
    id: "cloudflare-r2",
    name: "Cloudflare R2",
    kind: "object-store",
    fits: ["large-objects", "cost-sensitive"],
    avoid: ["low-latency"],
    note: "S3-compatible API with zero egress fees, which is the whole pitch for an egress-heavy media workload, but the feature set (lifecycle rules, replication) is thinner than S3's.",
  },
  {
    id: "azure-blob",
    name: "Azure Blob Storage",
    kind: "object-store",
    fits: ["large-objects", "global", "cost-sensitive"],
    avoid: ["low-latency"],
    note: "Tiered storage classes (hot/cool/archive) let you trade retrieval latency for lower storage cost, but moving between tiers and regions both carry their own fees to track.",
  },
  {
    id: "minio",
    name: "MinIO",
    kind: "object-store",
    fits: ["cost-sensitive", "low-latency"],
    avoid: ["global"],
    note: "Self-hosted, S3-compatible object storage keeps data and latency local with no per-request billing, but you own the drives, erasure coding, and capacity planning yourself.",
  },

  // stream
  {
    id: "kafka-stream",
    name: "Kafka",
    kind: "stream",
    fits: ["streaming", "write-heavy", "analytics"],
    avoid: ["cost-sensitive"],
    note: "The de facto standard partitioned log with a huge ecosystem of connectors and stream processors, but running brokers, ZooKeeper/KRaft, and partition rebalancing is real operational weight.",
  },
  {
    id: "kinesis",
    name: "Amazon Kinesis",
    kind: "stream",
    fits: ["streaming", "global", "cost-sensitive"],
    avoid: ["hot-keys"],
    note: "Fully managed shards with no brokers to run, but shard limits are fixed (1 MB/s or 1,000 records/s in) so a skewed key can throttle its shard well before the stream's total capacity is used.",
  },
  {
    id: "pulsar",
    name: "Apache Pulsar",
    kind: "stream",
    fits: ["streaming", "global", "write-heavy"],
    avoid: ["cost-sensitive"],
    note: "Separates serving from storage (BookKeeper) so partitions rebalance without moving data, and multi-tenant namespaces suit multi-region deployments, but it is a second distributed system's worth of operational surface beyond Kafka's.",
  },
  {
    id: "redpanda",
    name: "Redpanda",
    kind: "stream",
    fits: ["streaming", "low-latency", "write-heavy"],
    avoid: ["cost-sensitive"],
    note: "Kafka-API-compatible but written in C++ with no JVM or ZooKeeper, giving lower tail latency per broker, but the ecosystem of third-party tooling is younger than Kafka's.",
  },
  {
    id: "pubsub-stream",
    name: "Google Pub/Sub",
    kind: "stream",
    fits: ["streaming", "global", "cost-sensitive"],
    avoid: ["hot-keys"],
    note: "Fully managed with no partition management at all, but that also means no per-partition ordering guarantee unless you opt into ordering keys, which then behave like a hot key limit.",
  },
];

/** Derives the workload traits relevant to technology selection from a lesson's workload and architecture. */
export function workloadTraits(workload: Workload, architecture: Architecture): Trait[] {
  const traits = new Set<Trait>();

  if (workload.readRatio >= 0.65) traits.add("read-heavy");
  if (workload.readRatio <= 0.4) traits.add("write-heavy");

  if ((workload.keySkew ?? 0.6) >= 0.75) traits.add("hot-keys");

  const regionCount = workload.regions?.length ?? 1;
  if (regionCount > 1) traits.add("global");

  if (workload.requestRate >= 2000 || workload.pattern === "spike" || workload.pattern === "flash") {
    traits.add("low-latency");
  }

  if ((workload.deadlineMs ?? 5000) <= 300) traits.add("low-latency");

  const failureEvents = workload.failures ?? [];
  const hasRegionFailure = failureEvents.some((event) => event.kind === "region") || workload.failure === "database";
  if (hasRegionFailure) traits.add("strong-consistency");

  const databases = architecture.nodes.filter((node) => node.kind === "database" && node.enabled);
  for (const database of databases) {
    if (database.dbMode === "quorum" || database.consistency === "read-your-writes") traits.add("strong-consistency");
    if (database.dbMode === "sharded") traits.add("hot-keys");
  }

  const hasQueue = architecture.nodes.some((node) => node.kind === "queue" && node.enabled);
  if (hasQueue) traits.add("streaming");

  if (architecture.nodes.some((node) => node.kind === "cdn" && node.enabled)) traits.add("large-objects");
  if (architecture.nodes.some((node) => node.kind === "object-store" && node.enabled)) traits.add("large-objects");
  if (architecture.nodes.some((node) => node.kind === "stream" && node.enabled)) traits.add("streaming");

  const totalCost = architecture.nodes.filter((node) => node.enabled).reduce((sum, node) => sum + node.cost, 0);
  if (totalCost > 0 && totalCost <= 200) traits.add("cost-sensitive");

  return [...traits];
}

/** Score in [-1, 1]: +1/len(fits) per matched fit trait, -1/len(avoid) per matched avoid trait, clamped. */
export function fitScore(option: TechOption, traits: Trait[]): number {
  if (traits.length === 0) return 0;
  const traitSet = new Set(traits);
  let score = 0;
  if (option.fits.length > 0) {
    const matchedFits = option.fits.filter((trait) => traitSet.has(trait)).length;
    score += matchedFits / option.fits.length;
  }
  if (option.avoid.length > 0) {
    const matchedAvoids = option.avoid.filter((trait) => traitSet.has(trait)).length;
    score -= matchedAvoids / option.avoid.length;
  }
  return Math.max(-1, Math.min(1, score));
}

/** Options of the given kind, sorted best fit first (ties broken by catalog order). */
export function suggestFor(kind: NodeKind, traits: Trait[]): TechOption[] {
  return techCatalog
    .filter((option) => option.kind === kind)
    .map((option, index) => ({ option, index, score: fitScore(option, traits) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.option);
}
