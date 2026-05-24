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

- A different layer. Canopy is the **drive / portal** that can sit **on top of** MinIO — point a
  connector at its S3 endpoint — adding files, versions, sharing, plugins, and a UI.
- They're complementary, not either/or.

## Pick MinIO if

You need self-hosted, S3-compatible storage. Run Canopy in front of it for a drive experience.

[← Back to the comparison overview](how-it-compares)
