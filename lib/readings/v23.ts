import type { Reading } from "../types";

/**
 * Curated by the v2.3 readings agent for the five new lesson ids added in the
 * v2.3 addendum. Every URL below was fetched with WebFetch and verified to
 * load without login/paywall, with content checked against the stated claim.
 */
export const readings: Record<string, Reading[]> = {
  "object-storage-and-egress": [
    {
      title: "Understanding and managing Amazon S3 storage classes",
      url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html",
      source: "AWS S3 docs",
      why: "Explains the storage-class tradeoffs behind the storedGb cost this lesson bills per GB-month.",
      minutes: 8,
    },
    {
      title: "Amazon S3 pricing",
      url: "https://aws.amazon.com/s3/pricing/",
      source: "AWS pricing page",
      why: "Shows real per-GB storage and internet egress rates, including the free inbound / paid outbound asymmetry.",
      minutes: 6,
    },
    {
      title: "Cloudflare R2 pricing",
      url: "https://developers.cloudflare.com/r2/pricing/",
      source: "Cloudflare R2 docs",
      why: "Contrasts S3-style egress billing with R2's zero-egress model, clarifying why egress dominates video and image serving costs.",
      minutes: 5,
    },
  ],

  "partitioned-streams": [
    {
      title: "Kafka partitions explained",
      url: "https://developer.confluent.io/courses/apache-kafka/partitions/",
      source: "Confluent Developer",
      why: "Shows why ordering only holds within a single partition and how keyed messages route consistently.",
      minutes: 7,
    },
    {
      title: "Kafka consumer groups and rebalancing",
      url: "https://docs.confluent.io/platform/current/clients/consumer.html",
      source: "Confluent docs",
      why: "Describes how a consumer group divides partitions among members, matching the lesson's per-partition consumer model.",
      minutes: 9,
    },
    {
      title: "Kafka message delivery semantics",
      url: "https://docs.confluent.io/kafka/design/delivery-semantics.html",
      source: "Confluent (Kafka) docs",
      why: "Covers replay-on-restart and offset commits, explaining why a slow consumer backs up only its own partition's lag.",
      minutes: 6,
    },
  ],

  "split-brain": [
    {
      title: "In Search of an Understandable Consensus Algorithm (Raft)",
      url: "https://raft.github.io/raft.pdf",
      source: "Ongaro & Ousterhout, Raft paper",
      why: "Defines the majority-vote rule that makes consensus election unable to elect two leaders during a partition.",
      minutes: 20,
    },
    {
      title: "The Raft Consensus Algorithm",
      url: "https://raft.github.io/",
      source: "raft.github.io",
      why: "Gives an accessible overview of leader election and term numbers before reading the full paper.",
      minutes: 6,
    },
    {
      title: "Jepsen: Elasticsearch",
      url: "https://aphyr.com/posts/317-call-me-maybe-elasticsearch",
      source: "Jepsen analysis (Kyle Kingsbury)",
      why: "Documents a real heartbeat-style election producing two simultaneous primaries and hundreds of lost writes during a partition.",
      minutes: 15,
    },
  ],

  "security-and-tenancy": [
    {
      title: "OWASP Authorization Cheat Sheet",
      url: "https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html",
      source: "OWASP",
      why: "Argues RBAC alone is a poor fit for multi-tenant isolation and recommends per-request, deny-by-default checks.",
      minutes: 10,
    },
    {
      title: "OWASP Multifactor Authentication Cheat Sheet",
      url: "https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html",
      source: "OWASP",
      why: "Covers token and factor choices that ground the authN half of the lesson's authN/authZ split.",
      minutes: 8,
    },
    {
      title: "Google SRE Workbook: table of contents",
      url: "https://sre.google/workbook/table-of-contents/",
      source: "Google SRE Workbook",
      why: "Points to the rate-limiting and reliability practices this lesson expects per-tenant, not just globally.",
      minutes: 4,
    },
  ],

  "schema-migration-and-versioning": [
    {
      title: "Online migrations at Stripe",
      url: "https://stripe.com/blog/online-migrations",
      source: "Stripe engineering blog",
      why: "Walks through dual writing and a lazy backfill used to move a live table without downtime.",
      minutes: 12,
    },
    {
      title: "PostgreSQL: ALTER TABLE",
      url: "https://www.postgresql.org/docs/current/sql-altertable.html",
      source: "PostgreSQL docs",
      why: "Lists which ALTER TABLE forms take a full table lock versus a lighter one, explaining why some changes need expand/contract.",
      minutes: 10,
    },
    {
      title: "Stripe's API versioning",
      url: "https://stripe.com/blog/api-versioning",
      source: "Stripe engineering blog",
      why: "Shows rolling, date-based API versions with backward-compatibility shims as an alternative to breaking changes.",
      minutes: 9,
    },
    {
      title: "AIP-185: API versioning",
      url: "https://google.aip.dev/185",
      source: "Google API Improvement Proposals",
      why: "Lays out channel-based versioning as the deprecation-friendly alternative to incrementing major versions.",
      minutes: 7,
    },
  ],
};
