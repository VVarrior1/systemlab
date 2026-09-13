import { chapterTitles, defense, rubric, written, type ChapterFile } from "../shared";

/**
 * v2.3 additions to the Interview toolkit chapter (same title as 11-toolkit.ts).
 * Two Advanced written lessons: no simulation, no objectives.
 */
export const chapter: ChapterFile = {
  title: chapterTitles[10],
  lessons: [
    written({
      id: "security-and-tenancy",
      chapter: chapterTitles[10],
      title: "Secure the tenants",
      subtitle: "AuthN vs authZ, tokens, isolation, and per-tenant limits.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Security & multi-tenancy",
      brief:
        "A B2B SaaS product signs its hundredth customer, and the CISO of customer forty-one asks a blunt question: what stops a bug in your code from showing her data to customer forty-two? Interviewers ask this because most candidates can draw a login box but very few can explain, layer by layer, why a compromised token from one tenant cannot read another tenant's rows.",
      learning: [
        "Authentication answers who you are; authorization answers what you are allowed to do, and conflating them is the single most common security bug in an interview whiteboard. A request can be perfectly authenticated - a valid, unexpired token signed by the right issuer - and still be an authorization failure if it asks for a resource outside its tenant or role. State the split explicitly and check both on every request: authenticate once at the edge, then authorize per resource, per action, on the service that owns the data, not just at the gateway.",
        "Tokens come in two shapes with opposite tradeoffs. A JWT is self-contained and signed, so any service can verify it locally without a network call, which is fast and scales horizontally - the cost is that a JWT cannot be un-issued before it expires, so you keep access tokens short-lived, five to fifteen minutes, and accept a small blast radius. An opaque token is a random string the server looks up in a store on every request, which lets you revoke it instantly but adds a lookup on the hot path. The common production pattern is both: a short-lived JWT access token plus a long-lived opaque refresh token that can be revoked, which is exactly how OAuth 2.0's token pair works.",
        "Revocation is the question every interviewer eventually asks, because pure JWTs cannot answer it cleanly. Three real answers: keep access tokens short enough that waiting them out is acceptable, maintain a deny-list of revoked token IDs (the `jti` claim) checked at the edge, or store a per-user or per-session token version and bump it on logout so every JWT issued before that version fails verification. Rotating the signing key handles a compromised issuer but revokes every token at once, which is a blunt instrument you keep for a real incident, not routine logout.",
        "Tenant isolation has three levels with a cost and a blast-radius tradeoff at each. Row-level isolation - every table carries a `tenant_id` and every query filters on it - is cheapest to run and easiest to scale, but a single missing WHERE clause leaks across tenants; enforce it with a database feature like PostgreSQL row-level security so the filter cannot be forgotten in application code. Schema-per-tenant isolates further at the cost of migrations running N times. Database-per-tenant gives the strongest isolation and the cleanest story for a compliance audit, at the highest operational cost - you are running and backing up N databases. Most SaaS products start row-level and split out their largest or most regulated tenants later.",
        "Noisy neighbours are a resource problem, not a data problem, and they need a separate fix. A shared database or connection pool lets one tenant's expensive report or bulk import degrade latency for everyone else on the same row-level cluster. The mitigation is per-tenant resource limits: a connection-pool quota per tenant, a query-cost ceiling, or moving your largest tenants onto dedicated capacity - a hybrid of row-level for most tenants and database-per-tenant for the few whose contracts or size demand it. Naming this as a distinct failure mode from data leakage is what separates a candidate who has operated a real multi-tenant system from one who has only read about it.",
        "Encrypt in transit with TLS everywhere, including internal service-to-service calls, not just the public edge - mutual TLS if you need services to authenticate each other, not only the client. Encrypt at rest so a stolen disk or leaked backup is unreadable: whole-disk or database-level encryption handles the baseline, and per-tenant envelope encryption - each tenant's data encrypted with its own data key, itself encrypted by a master key in a key-management service - lets you cryptographically shred a tenant's data on offboarding by deleting one key, and satisfies enterprise contracts that specifically require it.",
        "Secrets - database passwords, API keys, signing keys - never belong in source control or plain environment variables in a shared config. Use a secrets manager (Vault, AWS Secrets Manager) that grants short-lived, scoped credentials to the service that needs them, rotates them automatically, and logs every access. Per-tenant rate limits and quotas prevent one tenant's traffic spike or bug from exhausting shared capacity: a token bucket keyed by tenant ID, sized from that tenant's contract, with a 429 and Retry-After rather than a silent queue. Audit logs - who did what, to which resource, when, from where - are a compliance requirement, not a debugging nicety; write them to an append-only, tenant-scoped store so a customer's own security team can review just their events, and so 'prove nobody but authorized staff accessed this tenant's data' has an answer.",
        "What this idealizes: real breaches usually come from a missing authorization check on one endpoint, not from a broken cryptographic primitive - the OWASP-documented pattern called broken object-level authorization, where an ID in a URL is trusted without checking the caller's tenant. No amount of TLS or envelope encryption fixes a query that forgot its `tenant_id` filter. Treat authorization as code that needs its own tests, centralize it in one place (a policy layer or middleware) rather than repeating the check in every handler, and assume the day you add a new endpoint is the day someone forgets it.",
      ],
      defense: defense({
        prompt:
          "Exercise. You are securing a multi-tenant SaaS API for a project-management product: each company (tenant) has users, projects and tasks, and companies must never see each other's data. Describe your authentication scheme (token type, lifetime, revocation), your tenant-isolation approach and why, how you encrypt data in transit and at rest, how secrets are managed, how you rate-limit and set quotas per tenant, and what you log for an audit trail. Be concrete about where each check runs.",
        followUps: [
          "A customer reports that an employee's laptop was stolen with a valid access token still in browser storage. Walk through exactly what happens from the moment IT reports it to the token being unusable, and how long each step takes.",
          "A tenant's own engineer discovers they can change a project ID in a URL and read another tenant's project. Name the exact class of bug, the one line of code most likely missing, and how you would have caught it before it shipped.",
          "An enterprise customer's compliance team demands a report of every person who accessed their data in the last ninety days, including which internal engineers. What did you need to have been logging since day one to answer this, and where is that log stored?",
        ],
        rubric: rubric([
          ["authn", "Specifies a concrete token scheme with lifetimes and at least one real revocation mechanism", 25],
          ["isolation", "Chooses a tenant-isolation level, defends it against the alternative, and enforces it at the database layer", 30],
          ["encryption", "States encryption in transit and at rest, including how a per-tenant key or scope is handled", 20],
          ["ops", "Covers per-tenant rate limits/quotas, secrets management, and an audit log design", 25],
        ]),
        modelAnswer:
          "Authentication: OAuth-style pair - a JWT access token, five minutes, signed with a rotating key, carrying `tenant_id`, `user_id` and `role`; a long-lived opaque refresh token stored server-side so it can be revoked, plus a per-user token version bumped on logout so a stolen access token is unusable within five minutes even without revocation. Isolation: row-level - every table carries `tenant_id`, enforced via PostgreSQL row-level security so no query can forget the filter, cheaper to run than schema-per-tenant and sufficient for a project-management workload; the handful of regulated enterprise tenants get dedicated databases per their contract. Authorization runs per-request in a shared middleware that checks `tenant_id` and role before the handler runs, never trusting an ID from the URL alone. Encryption: TLS everywhere including internal calls, database-level encryption at rest, and per-tenant envelope encryption so offboarding a tenant means deleting one key. Secrets live in a secrets manager issuing short-lived scoped credentials, never in config files. Rate limits: a token bucket per tenant sized from their plan, returning 429 with Retry-After. Audit log: append-only, tenant-scoped, recording actor, action, resource and timestamp for every write and every cross-tenant-sensitive read.",
      }),
      reflection: {
        question: "A service verifies every JWT's signature and expiry before processing a request, and the team considers authorization solved. What is missing?",
        options: [
          "The service still needs to check that the token's tenant and role are allowed to act on the specific resource requested, not just that the token is genuine",
          "Nothing - a validly signed, unexpired JWT is sufficient proof that the request is authorized",
          "The token needs to be encrypted, not just signed, before authorization can be considered complete",
          "Authorization is solved once the token is verified at the API gateway; downstream services can trust the gateway's check",
        ],
        answer: 0,
        explanation:
          "Signature and expiry checks are authentication - they prove who is asking. They say nothing about whether that identity may touch this particular project or task, which is authorization and must be checked per resource, typically against the tenant_id and role embedded in the token. A gateway-only check is exactly the broken object-level authorization pattern: a downstream service that trusts the gateway blindly will still leak data the moment a URL parameter is swapped, so the resource-level check has to run where the data lives.",
      },
    }),

    written({
      id: "schema-migration-and-versioning",
      chapter: chapterTitles[10],
      title: "Change the schema live",
      subtitle: "Expand/contract, backfills, dual writes, and versioned APIs.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Schema migration & versioning",
      brief:
        "A table taking 40,000 writes per second needs a new column, a changed type and eventually a split into two tables, and the business will not accept a maintenance window. This is the question that separates candidates who have only run `ALTER TABLE` on a laptop from ones who have shipped a change to a table nobody is allowed to lock, because the technique is always the same shape: never make a change that requires the old and new code to disagree about what is true.",
      learning: [
        "Expand/contract is the master pattern underneath almost every zero-downtime schema change: expand the schema to support both the old and new shape at once, migrate the data and the code while both are live, then contract by removing the old shape once nothing depends on it. Concretely: add the new column or table without removing the old one, deploy code that writes both, backfill history, deploy code that reads only the new shape, then drop the old column. Every step is independently safe and independently reversible, which is the entire point - a single big-bang migration has no safe rollback once it's halfway applied.",
        "Backfilling a live table means updating millions of existing rows without taking a lock that blocks production writes. Do it in small batches - a few thousand rows per transaction, selected by a stable range or an indexed cursor column, with a short sleep between batches - rather than one `UPDATE` touching the whole table, which would hold a lock for the duration and starve every other writer. Throttle to a target rate (rows per second) so the backfill yields to production load, checkpoint progress so a restart resumes rather than starting over, and monitor replication lag while it runs, since a fast backfill can itself become the incident by overwhelming a replica.",
        "Dual writes keep the old and new representations consistent during the migration window: application code writes to both the old and new location on every request, so reads from either stay correct while the backfill catches up on history. The risk is that two writes are not atomic - a crash between them leaves the two out of sync - which is why dual writes are usually paired with a periodic reconciliation job that diffs and repairs, or replaced entirely by the more robust outbox pattern: write the change and an event describing it in the same local transaction, then a separate process publishes that event and applies it to the new location asynchronously, guaranteeing the two never diverge from a partial failure.",
        "An index needed for the new query pattern has to be built without locking writes, which is what `CREATE INDEX CONCURRENTLY` in Postgres (and the equivalent online DDL in MySQL/InnoDB) exists for: it takes longer and scans the table twice, but it does not hold the exclusive lock a normal index build does. The same idea extends to any schema change - Postgres's `ALTER TABLE ... ADD COLUMN` with a constant default is metadata-only and instant since version 11, while adding a NOT NULL constraint with a non-constant default rewrites the table and needs the expand/contract treatment, so know which category your specific change falls into before promising it's safe.",
        "Feature flags decouple deploying code from turning on behavior, which is what makes expand/contract's phases independently controllable: ship the dual-write code behind a flag, verify it in production at low traffic, ramp it up, and only then start the backfill - if anything looks wrong, flip the flag off without a redeploy. The same mechanism lets you run the cutover as a percentage rollout rather than an all-at-once switch, watching error rates at 1%, then 10%, then 100% of traffic on the new path, which turns a risky migration into a series of small, reversible steps.",
        "API versioning applies the identical discipline to the contract clients depend on. A breaking change - removing a field, changing a type, renaming an endpoint - needs a new version (a path prefix or a date-based version header, Stripe's approach) so existing clients keep working unmodified while new clients opt in. Publish a deprecation window with a concrete sunset date, measure traffic per version so you know who is still calling the old one, and never remove a version while it still carries meaningful traffic - the same expand/contract shape, applied to a contract instead of a table.",
        "Backward compatibility means new server code still serves old clients; forward compatibility means old server code tolerates data or requests produced by new clients - both must hold simultaneously during any rolling deploy, because for the minutes it takes to roll out, some instances run the old code and some run the new code against the same database and the same traffic. This is precisely why expand/contract orders its steps the way it does: the new column must exist and be nullable before any instance writes to it, and old code must never fail simply because an unrecognized field showed up.",
        "What this idealizes: expand/contract assumes you can identify every reader and writer of the old shape before you drop it, and in practice there is always a forgotten batch job, an analytics query, or a partner integration still reading the old column - which is why the contract step happens last, gated on real traffic evidence (a metric showing zero reads for N days), not on a calendar date someone picked in a planning meeting. Treat the migration itself as a first-class piece of software: it needs a rollback plan for every step, not just the deploy, and the single most common real-world failure is not the migration failing outright but the backfill silently falling behind while everyone assumes it finished.",
      ],
      defense: defense({
        prompt:
          "Exercise. A `bookings` table takes 40,000 writes per second and needs to be split into `bookings` and `booking_payments` because payment fields are causing lock contention on unrelated booking updates, with zero downtime and no lost or duplicated data. Walk through your plan phase by phase using expand/contract: what you deploy first, how you backfill history, how you keep the two tables consistent during the transition (name the specific pattern), how you build any new index without blocking writes, how a feature flag controls the cutover, and the exact condition that tells you it's safe to drop the old payment columns.",
        followUps: [
          "Two weeks into the backfill, replication lag on the read replicas starts climbing and the backfill has only covered 60% of rows at the rate it's running. What do you do right now, and what would you have measured beforehand to catch this earlier?",
          "A partner integration is still calling an API endpoint that reads payment fields directly off the old `bookings` table, on API version 1, and you've already cut new traffic over to `booking_payments`. What does your versioning plan do for that client, and for how long?",
          "Halfway through the cutover - dual writes on, 40% of read traffic on the new path - you discover the outbox consumer has a bug that silently drops one message type. What is your rollback, and does it require reversing the schema change itself or just the traffic flag?",
        ],
        rubric: rubric([
          ["expand-contract", "Sequences the migration as expand, migrate/backfill, contract, with each phase independently safe", 30],
          ["consistency", "Names a concrete consistency mechanism (dual writes with reconciliation, or the outbox pattern) and explains why it doesn't diverge", 25],
          ["backfill", "Describes a batched, throttled backfill with checkpointing rather than a single locking update", 20],
          ["cutover", "Uses a feature flag or percentage rollout to control the cutover and states a concrete, evidence-based condition for the contract step", 25],
        ]),
        modelAnswer:
          "Expand: add the `booking_payments` table and a nullable foreign key on `bookings`, with a new index built via `CREATE INDEX CONCURRENTLY` so writes are never blocked. Deploy dual-write code behind a feature flag: every new booking writes its payment fields to both the old columns and the new table, using the outbox pattern - the write and an outbox event land in one local transaction, and a separate consumer applies the event to `booking_payments`, so a crash mid-write can never leave the two out of sync. Ramp the flag to 100% of write traffic, verify via reconciliation job that both sides agree, then backfill historical rows in batches of a few thousand by primary-key range, throttled to a target rate, checkpointing progress, while watching replica lag. Once the backfill finishes and reconciliation shows zero drift, flip a second flag to move reads to `booking_payments` at 1%, then 10%, then 100%, watching error rates at each step. Contract: only after read traffic has been 100% on the new path for a set window with zero errors and a metrics-confirmed zero reads on the old payment columns do I drop them - never on a calendar date alone.",
      }),
      reflection: {
        question: "A team migrates a hot column by writing an `UPDATE` that touches all 80 million rows in a single transaction, planned for a low-traffic window. What is the most likely failure?",
        options: [
          "The transaction holds a lock for its full duration, blocking concurrent writes and likely timing out or causing a pileup even in a low-traffic window",
          "Nothing - a single transaction is the safest way to guarantee the update is atomic and consistent",
          "The main risk is disk space from the write-ahead log, which has nothing to do with concurrent writers",
          "This is fine as long as it runs during the announced maintenance window, since users are expected to see errors then",
        ],
        answer: 0,
        explanation:
          "A single transaction over 80 million rows holds its locks until commit, so every concurrent writer to that table queues up behind it for the whole duration - at any real write rate this either times out or produces a lock-contention incident, window or not. The safe version is the batched, throttled backfill: many small transactions, each committing and releasing its locks quickly, so production traffic is never blocked for more than a moment at a time.",
      },
    }),
  ],
};
