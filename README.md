# Helix Snapshot Scheduler

A Cloudflare Workers-based system for scheduling and publishing AEM Edge Delivery snapshots automatically

## Overview

This system consists of four main components that work together to manage scheduled snapshot publishing:

1. **Register** - Registers org/site combinations for snapshot scheduling and manages schedule data
2. **Cron** - Monitors schedule data and queues snapshots for publishing
3. **Publish** - Publishes snapshots and manages completion tracking
4. **DLQ** - Handles failed snapshots for investigation and recovery

## Register Service

The register service handles both registration and schedule management for org/site combinations.

### Registration

To register an org/site combination for snapshot scheduling:

```bash
curl -X POST https://helix-snapshot-scheduler-ci.adobeaem.workers.dev/register \
  -H "Content-Type: application/json" \
  -H "Authorization: token <your-token>" \
  -d '{"org": "your-org", "site": "your-site", "apiKey": "your-api-key"}'
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
  -H "Authorization: token <your-token>" \
  -d '{
    "org": "your-org",
    "site": "your-site",
    "snapshotId": "snapshot-123"
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
  -H "Authorization: token <your-token>"
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
  -H "Authorization: token <your-token>"
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

### 2. Publish Worker

When the publish-queue processes a batch of snapshots:

- **Publishes snapshots**: Calls the AEM Admin API to publish each snapshot in the batch
- **Batch optimization**: Updates schedule and completed data once per batch (not per snapshot)
- **Updates schedule**: Removes all published snapshots from `schedule.json` in a single operation
- **Tracks completion**: Moves completed snapshot data to `completed/YYYY-MM-DD.json` for audit trail
- **Retry mechanism**: Automatically retries failed publishes (5 attempts with exponential backoff)
- **Dead Letter Queue**: After max retries, failed snapshots are sent to DLQ for investigation

### 3. Dead Letter Queue (DLQ) Worker

When snapshots fail after all retry attempts:

- **Logs failures**: Records detailed error information for each failed snapshot
- **Stores for investigation**: Saves failed snapshot data to `failed/YYYY-MM-DD.json` in R2
- **Enables recovery**: Failed snapshots can be manually retried or investigated
- **Prevents message loss**: Ensures no snapshots are silently dropped

## Data Storage

### Schedule Data (`schedule.json`)

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

### Completed Snapshots (`completed/YYYY-MM-DD.json`)

The publish worker tracks completed snapshots in date-based JSON files:

```json
[
  {
    "org": "org1",
    "site": "site1",
    "snapshotId": "snapshot-123",
    "scheduledPublish": "2025-01-15T10:30:00Z",
    "publishedAt": "2025-01-15T10:30:15Z",
    "publishedBy": "scheduled-snapshot-publisher"
  }
]
```

### Failed Snapshots (`failed/YYYY-MM-DD.json`)

The DLQ worker stores failed snapshots for investigation:

```json
[
  {
    "org": "org1",
    "site": "site1",
    "snapshotId": "snapshot-456",
    "scheduledPublish": "2025-01-15T10:30:00Z",
    "messageId": "abc-123",
    "timestamp": 1696412100000,
    "failedAt": "2025-01-15T10:35:45Z",
    "reason": "exceeded-max-retries"
  }
]
```

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐    ┌─────────────┐
│   Register  │    │     Cron     │    │     Publish     │    │     DLQ     │
│             │    │              │    │                 │    │             │
│ POST /      │    │ Every 5 min  │    │ Queue Consumer  │    │ Failed Msgs │
│  register   │    │ → Read       │    │ → Batch Process │    │ → Log &     │
│ POST /      │    │   schedule   │    │ → Retry 5x      │    │   Store     │
│  schedule   │    │ → Queue      │    │ → Admin API     │    │   Failures  │
│ GET /       │    │   snapshots  │    │ → Update R2     │    │             │
│  schedule   │    │              │    │                 │    │             │
└─────────────┘    └──────────────┘    └─────────────────┘    └─────────────┘
       │                   │                      │                    ▲
       │                   │                      │                    │
       ▼                   ▼                      ▼                    │ (max retries)
┌───────────────────────────────────────────────────────────┐         │
│                    R2 Bucket Storage                       │         │
│  • schedule.json      - Current scheduled snapshots        │         │
│  • completed/YYYY-MM-DD.json - Successfully published      │         │
│  • failed/YYYY-MM-DD.json    - Failed after retries  ◄─────┘         │
└───────────────────────────────────────────────────────────┘
```

## Environment Variables
- `R2_BUCKET`: Cloudflare R2 bucket for storing schedule data, completed snapshots, and failed snapshots
- `SCHEDULER_KV`: Cloudflare KV namespace for storing API tokens
- `PUBLISH_QUEUE`: Cloudflare Queue for snapshot publishing with retry mechanism
- `DLQ`: Dead Letter Queue for failed snapshots after max retries

## Authorization

All register service endpoints require proper authorization:

- **Admin access** (for registration): Requires access to AEM Admin API site configuration
- **Basic author access** (for scheduling): Requires access to AEM Snapshot List API

The service validates authorization by making test calls to:
- `https://admin.hlx.page/config/{org}/sites/{site}.json` (for admin access)
- `https://admin.hlx.page/snapshot/{org}/{site}/main` (for snapshot access)

## Deployment

Each component is deployed as a separate Cloudflare Worker automatically via Github workflows

- `register/` - HTTP endpoint for registration and schedule management
- `cron/` - Scheduled worker (runs every 5 minutes) that reads schedule data and queues snapshots
- `publish/` - Queue worker for publishing with automatic retry mechanism
- `dlq/` - Dead Letter Queue consumer for handling permanently failed snapshots

See individual `wrangler.toml` files for deployment configuration.

## Key Features

### Simplified Architecture
- **Centralized Schedule Management**: All scheduled snapshots are stored in a single `schedule.json` file
- **No Duplicate Publishing**: Published snapshots are immediately removed from the schedule to prevent re-publishing
- **Batch Optimization**: R2 operations are batched per queue batch for optimal performance
- **Automatic Retry**: Failed publishes are automatically retried up to 5 times with exponential backoff
- **Dead Letter Queue**: Permanently failed snapshots are captured in DLQ for investigation
- **Audit Trail**: Completed and failed snapshots are tracked in date-based JSON files
- **Fault Tolerance**: System recovers gracefully from transient failures

### Data Flow
1. **Registration**: Org/site combinations are registered for scheduled publishing
2. **Scheduling**: Snapshots are scheduled with specific publish times via API
3. **Monitoring**: Cron job monitors schedule every 5 minutes for upcoming publishes (including past-due)
4. **Publishing**: Queue worker publishes snapshots at the scheduled time with batch optimization
5. **Retry Logic**: Failed publishes are automatically retried (5 attempts over ~1 hour)
6. **DLQ Handling**: Permanently failed snapshots are logged and stored for manual recovery
7. **Cleanup**: Successfully published snapshots are removed from schedule and archived

