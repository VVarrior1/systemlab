import type { Reading } from "../types";

/** Curated by the v2.2 readings agent. Every URL WebFetch-verified: loads without login/paywall and matches its claim (2026-09-12). */
export const readings: Record<string, Reading[]> = {
  "payments-ledger": [
    {
      title: "Idempotent requests",
      url: "https://docs.stripe.com/api/idempotent_requests",
      source: "Stripe docs",
      why: "Explains idempotency keys so retried payment writes never double-charge.",
      minutes: 8,
    },
    {
      title: "Books: An immutable double-entry accounting database service",
      url: "https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/",
      source: "Square engineering",
      why: "Shows how double-entry journal entries keep a ledger balanced at scale.",
      minutes: 12,
    },
    {
      title: "Rate limiters",
      url: "https://stripe.com/blog/rate-limiters",
      source: "Stripe engineering",
      why: "Covers protecting a payments API from overload with layered limiters.",
      minutes: 10,
    },
  ],
  "ride-matching": [
    {
      title: "H3: Uber's Hexagonal Hierarchical Spatial Index",
      url: "https://www.uber.com/blog/h3/",
      source: "Uber engineering",
      why: "Explains the hex grid Uber uses to index supply and demand geographically.",
      minutes: 10,
    },
    {
      title: "Reinforcement Learning for Modeling Marketplace Balance",
      url: "https://www.uber.com/blog/reinforcement-learning-for-modeling-marketplace-balance/",
      source: "Uber engineering",
      why: "Describes how Uber values driver states to match riders and drivers well.",
      minutes: 12,
    },
  ],
  "collaborative-editing": [
    {
      title: "How Figma's multiplayer technology works",
      url: "https://www.figma.com/blog/how-figmas-multiplayer-technology-works/",
      source: "Figma engineering",
      why: "Details a CRDT-inspired sync model with a central server as authority.",
      minutes: 14,
    },
    {
      title: "Differential Synchronization",
      url: "https://neil.fraser.name/writing/sync/",
      source: "Neil Fraser (Google)",
      why: "Lays out the diff-and-patch algorithm behind real-time document sync.",
      minutes: 15,
    },
  ],
  "log-search": [
    {
      title: "Loki architecture",
      url: "https://grafana.com/docs/loki/latest/get-started/architecture/",
      source: "Grafana Loki docs",
      why: "Shows how distributors, ingesters, and object storage handle log search.",
      minutes: 10,
    },
    {
      title: "Documents and indices",
      url: "https://www.elastic.co/guide/en/elasticsearch/reference/current/documents-indices.html",
      source: "Elasticsearch docs",
      why: "Explains how indices, shards, and documents make full-text search scale.",
      minutes: 8,
    },
  ],
  "video-upload-pipeline": [
    {
      title: "Upload files directly",
      url: "https://www.mux.com/docs/guides/video/upload-files-directly",
      source: "Mux docs",
      why: "Walks through signed, resumable direct uploads that skip app servers.",
      minutes: 8,
    },
    {
      title: "The developer's guide to video encoding for streaming",
      url: "https://www.mux.com/articles/video-encoding-for-streaming-developers-guide",
      source: "Mux engineering",
      why: "Maps the ingest-encode-package-store-serve pipeline stage by stage.",
      minutes: 14,
    },
  ],
  leaderboard: [
    {
      title: "Sorted sets",
      url: "https://redis.io/docs/latest/develop/data-types/sorted-sets/",
      source: "Redis docs",
      why: "Shows ranked score operations that power real-time leaderboard ranking.",
      minutes: 9,
    },
  ],
  "rate-limiter-service": [
    {
      title: "Counting things: a lot of different things",
      url: "https://blog.cloudflare.com/counting-things-a-lot-of-different-things/",
      source: "Cloudflare engineering",
      why: "Compares fixed-window, leaky-bucket, and sliding-window limiter accuracy.",
      minutes: 12,
    },
    {
      title: "Rate limiters",
      url: "https://stripe.com/blog/rate-limiters",
      source: "Stripe engineering",
      why: "Describes token-bucket rate limiting layered with load shedding in production.",
      minutes: 10,
    },
  ],
  "ad-click-aggregation": [
    {
      title: "Windows",
      url: "https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/operators/windows/",
      source: "Apache Flink docs",
      why: "Explains tumbling and sliding windows for aggregating unbounded event streams.",
      minutes: 12,
    },
    {
      title: "Aggregating",
      url: "https://docs.confluent.io/platform/current/streams/developer-guide/dsl-api.html",
      source: "Confluent (Kafka Streams) docs",
      why: "Shows grouped count, reduce, and aggregate operations on keyed streams.",
      minutes: 10,
    },
    {
      title: "The Dataflow Model",
      url: "https://research.google/pubs/the-dataflow-model-a-practical-approach-to-balancing-correctness-latency-and-cost-in-massive-scale-unbounded-out-of-order-data-processing/",
      source: "Google Research (VLDB 2015)",
      why: "Introduces windowing and watermarks for correct out-of-order click aggregation.",
      minutes: 20,
    },
  ],
};
