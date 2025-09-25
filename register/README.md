# Helix Snapshot Scheduler - Register Service

## Description
This service handles registration and scheduling of snapshots for scheduled publishing in Adobe Experience Manager (AEM) Edge Delivery Services.

## Features

### Registration
- **POST /register** - Register an org/site for scheduled publishing
- **GET /register/:org/:site** - Check if an org/site is registered

### Schedule Management
- **POST /schedule** - Update schedule for a snapshot
- **GET /schedule/:org/:site** - Get schedule for specific org/site

## API Endpoints

### Register Org/Site
```bash
POST /register
Content-Type: application/json
Authorization: Bearer <token>

{
  "org": "your-org",
  "site": "your-site"
}
```

### Update Schedule
```bash
POST /schedule
Content-Type: application/json
Authorization: Bearer <token>

{
  "org": "your-org",
  "site": "your-site", 
  "snapshotId": "snapshot-123",
  "scheduledPublish": "2025-01-15T10:30:00Z"
}
```

### Get Schedule
```bash
# Get specific org/site schedule
GET /schedule/your-org/your-site
Authorization: Bearer <token>
```

## Schedule Data Structure

The schedule data is stored in R2 as `schedule.json` with the following structure:

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

## Development

Install the [wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) and run:

```bash
# Start local development server
wrangler dev --remote

# Run tests
npm test

# Deploy to production
npm run deploy
```

## CI/CD & Testing Changes
Push to a branch to get this deployed on a CI branch for testing; push to main to get this deployed to production.