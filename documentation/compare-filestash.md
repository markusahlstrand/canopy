# Filestash

> A web UI that fronts storage you already have — the nearest cousin to one Canopy idea.

## What it is

A lightweight self-hosted web file manager that connects to many backends (S3, SFTP / FTP, WebDAV,
Git, and more), with viewers / editors for common file types and an admin console. It's a
front-end over your existing storage, not a storage system itself.

## Where it beats Canopy

- More storage backends supported out of the box today.
- Simple and single-purpose; easy to point at an existing share.

## Where Canopy differs

- Canopy adds a **managed, deduplicated drive** (versions, trash, content-addressing), a
  **relation-tuple sharing graph** (files / folders / spaces, email invites), and a **plugin
  platform** (Calendar, Tasks, Document AI, sandboxed viewers / UI).
- Edge-serverless deployment (a single Worker) and bring-your-own identity (OIDC).

## Pick Filestash if

You mainly want a clean web UI over an existing bucket or SFTP server, without a platform around it.

[← Back to the comparison overview](how-it-compares)
