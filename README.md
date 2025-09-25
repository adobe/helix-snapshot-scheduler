# Helix Snapshot Scheduler

A Cloudflare Workers-based system for scheduling and publishing AEM Edge Delivery snapshots automatically.

## Overview

This system consists of three main components that work together to manage scheduled snapshot publishing:

1. **Register** - Registers org/site combinations for snapshot scheduling and manages schedule data
2. **Cron** - Monitors schedule data and queues snapshots for publishing
3. **Publish Snapshot** - Publishes snapshots and updates manifests

## Register Service

The register service handles both registration and schedule management for org/site combinations.

### Registration

To register an org/site combination for snapshot scheduling:

```bash
curl -X POST https://helix-snapshot-scheduler-ci.adobeaem.workers.dev/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{"org": "your-org", "site": "your-site"}'
```

**Response:**
- `200 OK` - Registration successful or already registered
- `400 Bad Request` - Missing org or site in request body
- `401 Unauthorized` - Invalid or missing authorization token

### Schedule Management

#### Update Schedule

To schedule a snapshot for publishing at a specific time:

```bash
curl -X POST https://helix-snapshot-scheduler-ci.adobeaem.workers.dev/schedule \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{
    "org": "your-org",
    "site": "your-site",
    "snapshotId": "snapshot-123",
    "scheduledPublish": "2025-01-15T10:30:00Z"
  }'
```

**Response:**
- `200 OK` - Schedule updated successfully
- `400 Bad Request` - Missing required fields or invalid date format
- `401 Unauthorized` - Invalid or missing authorization token
- `404 Not Found` - Org/site not registered for scheduled publishing

#### Get Schedule

To retrieve schedule data for a specific org/site:

```bash
curl -X GET https://helix-snapshot-scheduler-ci.adobeaem.workers.dev/schedule/your-org/your-site \
  -H "Authorization: Bearer <your-token>"
```

**Response:**
```json
{
  "your-org--your-site": {
    "snapshot-123": "2025-01-15T10:30:00Z",
    "snapshot-456": "2025-01-16T14:00:00Z"
  }
}
```

#### Check Registration Status

To check if an org/site is registered:

```bash
curl -X GET https://helix-snapshot-scheduler-ci.adobeaem.workers.dev/register/your-org/your-site \
  -H "Authorization: Bearer <your-token>"
```

**Response:**
```json
{
  "registered": true
}
```

## How it works in the background

### 1. Cron Scheduler

The cron worker runs every 5 minutes and performs the following:

- **Reads schedule data**: Loads the centralized `schedule.json` from R2 bucket
- **Filters by timing**: Identifies snapshots scheduled for publishing in the next 5 minutes
- **Queues for publishing**: Adds eligible snapshots to the `publish-queue` with exact delay timing

### 2. Publish Snapshot

When the publish-queue processes a snapshot:

- **Publishes snapshot**: Calls the admin API to publish the snapshot
- **Updates manifest**: Removes the `scheduledPublish` metadata and adds:
  - `publishedAt`: Timestamp of publication
  - `publishedBy`: Set to 'scheduled-snapshot-publisher'
  - `status`: Set to 'published'
- **Handles failures**: Retries failed publications with delay

## Schedule Data Storage

The register service stores schedule data in R2 bucket as `schedule.json` with the following structure:

```json
{
  "org1--site1": {
    "snapshotId1": "2025-01-15T10:30:00Z",
    "snapshotId2": "2025-01-16T14:00:00Z"
  },
  "org1--site2": {
    "snapshotId1": "2025-01-17T09:15:00Z"
  },
  "org2--site1": {
    "snapshotId1": "2025-01-18T16:45:00Z"
  }
}
```

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│   Register  │    │     Cron     │    │ Publish Snapshot│
│             │    │              │    │                 │
│ POST /register│  │ Cron Trigger │    │ Queue Processor │
│ POST /schedule│  │ → schedule   │    │ → publish-queue │
│ GET /schedule │  │   data       │    │ → Admin API     │
│ Creates R2  │    │              │    │                 │
│ entries     │    │              │    │                 │
└─────────────┘    └──────────────┘    └─────────────────┘
       │                   │                      │
       │                   │                      │
       ▼                   ▼                      ▼
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│   R2 Bucket │    │ schedule.json│    │   -Update       │
│ registered/ │    │ GET schedule │    │   manifest      │
│ org--site   │    │ GET manifest │    │   -Update       │
│ .json files │    │ -> Publish Q │    │   metadata      │
│ schedule.json│   │              │    │                 │
└─────────────┘    └──────────────┘    └─────────────────┘
```

## Environment Variables
- `R2_BUCKET`: Cloudflare R2 bucket for storing registered tenants and schedule data (via wrangler.toml)
- `PUBLISH_QUEUE`: Cloudflare Queue for snapshot publishing (via wrangler.toml)

## Authorization

All register service endpoints require proper authorization:

- **Admin access** (for registration): Requires access to AEM Admin API site configuration
- **Basic author access** (for scheduling): Requires access to AEM Snapshot List API

The service validates authorization by making test calls to:
- `https://admin.hlx.page/config/{org}/sites/{site}.json` (for admin access)
- `https://admin.hlx.page/snapshot/{org}/{site}/main` (for snapshot access)

## Deployment

Each component is deployed as a separate Cloudflare Worker automatically via Github workflows

- `register/` - HTTP endpoint for registration
- `cron/` - Scheduled worker that reads schedule data and queues snapshots
- `publish-snapshot/` - Queue worker for publishing

See individual `wrangler.toml` files for deployment configuration.

## TODO
Edge cases to test:
- lookahead time needs to be longer than the cron frequency
- What if someone changes the scheduled publish time after the job is already added to the publish queue (need a final check before running it)

- if lookahead is higher than cron frequency, then we might publish same snapshot multiple times. is this a problem? can we avoid storing state in R2 for jobs that are done
- Do we need to log the completed publishes in R2 for historical purposes? It shows in audit log as a system generated thing as well as in snapshot metadata.