# MinIO

> High-performance, S3-compatible object storage — a backend, not a competitor.

## What it is

A self-hosted, S3-compatible object storage server, with a console for buckets and policies. It's
a **storage layer**, not a drive UI or sharing platform — the kind of thing applications store
bytes in.

## Where it beats Canopy

- It's a serious object store: performance, erasure coding, replication, the S3 API.
- The right tool for *storing bytes* at scale.

## Where Canopy differs

- A different layer. Canopy is a **web drive** with files, versions, sharing, and a UI. A MinIO connector for the current vertical is future work.
- They're complementary, not either/or.

## Pick MinIO if

You need self-hosted, S3-compatible storage. A Canopy connection to it depends on the storage connector migration.

[← Back to the comparison overview](10-how-it-compares.md)
