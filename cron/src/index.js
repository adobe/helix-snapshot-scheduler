/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
/* eslint-disable no-console */

const LOOKAHEAD_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

/**
 * Read the scheduled.json file from R2 and return snapshots due for publishing
 * @param {Object} env - The environment object
 * @returns {Array} Array of snapshots to be published
 */
async function getScheduledSnapshots(env) {
  const scheduleData = await env.R2_BUCKET.get('schedule.json');
  if (!scheduleData) {
    console.log('No schedule data found');
    return [];
  }

  const schedule = await scheduleData.json();
  const now = Date.now();
  const lookaheadEnd = now + LOOKAHEAD_MS;
  const snapshotsToPublish = [];

  // Iterate through all org-site combinations
  for (const [orgSiteKey, snapshots] of Object.entries(schedule)) {
    const [org, site] = orgSiteKey.split('--');
    if (!org || !site) {
      console.warn(`Invalid org-site key: ${orgSiteKey}`);
      // eslint-disable-next-line no-continue
      continue;
    }

    // Check each snapshot for this org-site
    for (const [snapshotId, scheduledPublishStr] of Object.entries(snapshots)) {
      try {
        const scheduledPublish = new Date(scheduledPublishStr).getTime();
        // Check if this snapshot is due to be published in the next 5 minutes
        // or scheduled in the past (error publishing previously scheduled snapshots)
        if (scheduledPublish <= lookaheadEnd) {
          const delaySeconds = Math.max(0, Math.ceil((scheduledPublish - now) / 1000));
          snapshotsToPublish.push({
            org,
            site,
            snapshotId,
            scheduledPublish: scheduledPublishStr,
            delaySeconds, // Ensure non-negative delay
          });

          console.log(`Scheduling snapshot ${snapshotId} for ${org}/${site} with ${delaySeconds}s delay`);
        }
      } catch (err) {
        console.error(`Invalid scheduled publish date for ${orgSiteKey}/${snapshotId}: ${scheduledPublishStr}`, err);
      }
    }
  }

  return snapshotsToPublish;
}

export default {
  async scheduled(controller, env) {
    try {
      // Get snapshots scheduled for publishing in the next 5 minutes
      const snapshotsToPublish = await getScheduledSnapshots(env);
      if (snapshotsToPublish.length === 0) {
        console.log('No snapshots scheduled for publishing in the next 5 minutes');
        return true;
      }
      console.log(`Found ${snapshotsToPublish.length} snapshots to schedule for publishing`);
      // Queue each snapshot for publishing with the appropriate delay
      const queuePromises = snapshotsToPublish.map(async (snapshot) => {
        try {
          await env.PUBLISH_QUEUE.send(snapshot, {
            delaySeconds: snapshot.delaySeconds,
          });
          console.log(`Queued snapshot ${snapshot.snapshotId} for ${snapshot.org}/${snapshot.site} with ${snapshot.delaySeconds}s delay`);
          return { success: true, snapshot };
        } catch (error) {
          console.error(`Failed to queue snapshot ${snapshot.snapshotId} for ${snapshot.org}/${snapshot.site}:`, error);
          return { success: false, snapshot, error };
        }
      });

      const results = await Promise.all(queuePromises);
      const successCount = results.filter((r) => r.success).length;
      console.log(`Successfully queued ${successCount}/${snapshotsToPublish.length} snapshots for publishing`);
      return true;
    } catch (error) {
      console.error('Error in scheduled function:', error);
      return false;
    }
  },
};
