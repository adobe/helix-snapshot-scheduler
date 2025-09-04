# Helix Snapshot Scheduler

A Cloudflare Workers-based system for scheduling and publishing AEM Edge Delivery snapshots automatically.

## Overview

This system consists of three main components that work together to manage scheduled snapshot publishing:

1. **Register** - Registers org/site combinations for snapshot scheduling
2. **Tenant Poll** - Monitors registered tenants and queues snapshots for publishing
3. **Publish Snapshot** - Publishes snapshots and updates manifests

## How to Register

To register an org/site combination for snapshot scheduling:

```bash
curl -X POST https://helix-snapshot-scheduler-register-ci.adobeaem.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{"org": "your-org", "site": "your-site"}'
```

**Response:**
- `200 OK` - Registration successful or already registered
- `400 Bad Request` - Missing org or site in request body
- `405 Method Not Allowed` - Only POST requests are accepted

## How it works in the background

### 1. Tenant Poll Scheduler

The tenant-poll worker runs on a cron schedule (currently 10 mins) and performs the following:

- **Scans registered tenants**: Looks up all registered org/site combinations from the R2 bucket
- **Queues tenant processing**: Adds each registered tenant to the `tenant-poll-queue` for processing
- **Handles failures**: Retries failed operations with exponential backoff

### 2. Tenant Poll Processing

When the tenant-poll-queue processes a tenant:

- **Fetches snapshots**: Calls the snapshot API to get all snapshots for the org/site
- **Checks scheduling**: Examines each snapshot's manifest for `scheduledPublish` metadata
- **Filters by timing**: Only processes snapshots scheduled within the next 10 minutes
- **Queues for publishing**: Adds eligible snapshots to the `publish-queue` with appropriate delay

### 3. Publish Snapshot

When the publish-queue processes a snapshot:

- **Publishes snapshot**: Calls the admin API to publish the snapshot
- **Updates manifest**: Removes the `scheduledPublish` metadata and adds:
  - `publishedAt`: Timestamp of publication
  - `publishedBy`: Set to 'scheduled-snapshot-publisher'
  - `status`: Set to 'published'
- **Handles failures**: Retries failed publications with delay

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│   Register  │    │ Tenant Poll  │    │ Publish Snapshot│
│             │    │              │    │                 │
│ POST /register│  │ Cron Trigger │    │ Queue Processor │
│ Creates R2  │    │ → tenant-    │    │ → publish-queue │
│ entries     │    │   poll-queue │    │ → Admin API     │
└─────────────┘    └──────────────┘    └─────────────────┘
       │                   │                      │
       │                   │                      │
       ▼                   ▼                      ▼
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│   R2 Bucket │    │ Snapshot API │    │   -Update       │
│ registered/ │    │ GET snapshots│    │   manifest      │
│ org--site   │    │ GET manifest │    │   -Update       │
│ .json files │    │ -> Publish Q │    │   metadata      │
└─────────────┘    └──────────────┘    └─────────────────┘
```

## Environment Variables
- `ADMIN_API_TOKEN`: Token for authenticating with the AEM admin API
- `R2_BUCKET`: Cloudflare R2 bucket for storing registered tenants (via wrangler.toml)
- `TENANT_POLL_QUEUE`: Cloudflare Queue for tenant processing (via wrangler.toml)
- `PUBLISH_QUEUE`: Cloudflare Queue for snapshot publishing (via wrangler.toml)

## Deployment

Each component is deployed as a separate Cloudflare Worker automatically via Github workflows

- `register/` - HTTP endpoint for registration
- `tenant-poll/` - Scheduled worker with queue processing
- `publish-snapshot/` - Queue worker for publishing

See individual `wrangler.toml` files for deployment configuration.

## TODO
Edge cases to test:
- lookahead time needs to be longer than the cron frequency
- What if someone changes the scheduled publish time after the job is already added to the publish queue (need a final check before running it)

- if lookahead is higher than cron frequency, then we might publish same snapshot multiple times. is this a problem? can we avoid storing state in R2 for jobs that are done
- Do we need to log the completed publishes in R2 for historical purposes? It shows in audit log as a system generated thing as well as in snapshot metadata.