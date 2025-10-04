# Helix Snapshot Scheduler - Dead Letter Queue Consumer

This Cloudflare Worker consumes messages from the Dead Letter Queue (DLQ) that have failed after all retry attempts in the publish queue.

## Purpose

When snapshot publish operations fail after 5 retry attempts (within 1 hour), they are automatically sent to this DLQ consumer, which:

1. **Logs detailed failure information** for observability and alerting
2. **Stores failed messages in R2** (`failed/YYYY-MM-DD.json`) for investigation
3. **Prevents message loss** by ensuring all failures are captured

## Failure Storage

Failed messages are stored in R2 with the following structure:

```json
{
  "org": "example-org",
  "site": "example-site",
  "snapshotId": "snapshot-123",
  "scheduledPublish": "2025-10-04T09:15:00Z",
  "messageId": "abc123",
  "timestamp": 1696412100000,
  "failedAt": "2025-10-04T09:20:00Z",
  "reason": "exceeded-max-retries"
}
```

## Manual Recovery

To manually retry a failed snapshot:

1. Check the failed messages in R2: `failed/YYYY-MM-DD.json`
2. Identify the snapshot details (org, site, snapshotId)
3. Use the schedule API to re-schedule the snapshot
4. Or manually publish via AEM Admin API

## Monitoring

Monitor DLQ activity to detect:
- Repeated failures (indicate systemic issues)
- Specific org/site patterns (indicate configuration issues)
- API credential problems (indicate auth issues)

## Deployment

```bash
# Deploy production
npm run deploy

# Deploy CI
npm run deploy-ci
```

