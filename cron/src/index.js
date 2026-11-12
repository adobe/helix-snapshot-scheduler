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
// Entries queued more recently than this are still in flight; older ones are treated as stuck.
// Must stay longer than all publish retries (about 15.5 min),
// or an entry that is still retrying gets queued twice.
export const REQUEUE_AFTER_MS = 20 * 60 * 1000;

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

    // Check each snapshot/page for this org-site
    for (const [path, snapshotData] of Object.entries(snapshots)) {
      try {
        const {
          scheduledPublish: scheduledPublishStr,
          approved = false,
          type = 'snapshot',
          userId = null,
          queuedAt,
        } = snapshotData;
        const scheduledPublish = new Date(scheduledPublishStr).getTime();
        const queuedAge = queuedAt ? now - new Date(queuedAt).getTime() : NaN;
        if (queuedAge >= 0 && queuedAge < REQUEUE_AFTER_MS) {
          console.log(`Skipping ${type} ${path} for ${org}/${site}: already queued at ${queuedAt}`);
        } else if (scheduledPublish <= lookaheadEnd) {
          // Check if this entry is due to be published in the next 5 minutes
          const delaySeconds = Math.max(0, Math.ceil((scheduledPublish - now) / 1000));
          snapshotsToPublish.push({
            org,
            site,
            path,
            scheduledPublish: scheduledPublishStr,
            approved,
            type,
            userId,
            delaySeconds, // Ensure non-negative delay
          });

          console.log(`Scheduling ${type} ${path} for ${org}/${site} with ${delaySeconds}s delay`);
        }
      } catch (err) {
        console.error(`Invalid scheduled publish date for ${orgSiteKey}/${path}:`, snapshotData, err);
      }
    }
  }

  return snapshotsToPublish;
}

/**
 * Mark queued entries with queuedAt in schedule.json (single R2 read + write).
 * Re-reads schedule.json so changes made while queuing are kept, and only marks
 * entries whose scheduledPublish is unchanged.
 */
async function markQueued(env, queued, queuedAt) {
  const scheduleData = await env.R2_BUCKET.get('schedule.json');
  if (!scheduleData) return;
  const schedule = await scheduleData.json();
  let changed = false;
  for (const {
    org, site, path, scheduledPublish,
  } of queued) {
    const entry = schedule[`${org}--${site}`]?.[path];
    if (entry && entry.scheduledPublish === scheduledPublish) {
      entry.queuedAt = queuedAt;
      changed = true;
    }
  }
  if (changed) {
    await env.R2_BUCKET.put('schedule.json', JSON.stringify(schedule, null, 2));
  }
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
      console.log(`Found ${snapshotsToPublish.length} entries to schedule for publishing`);
      // Queue each snapshot for publishing with the appropriate delay
      const queuePromises = snapshotsToPublish.map(async (snapshot) => {
        try {
          await env.PUBLISH_QUEUE.send(snapshot, {
            delaySeconds: snapshot.delaySeconds,
          });
          console.log(`Queued ${snapshot.type} ${snapshot.path} for ${snapshot.org}/${snapshot.site} with ${snapshot.delaySeconds}s delay`);
          return { success: true, snapshot };
        } catch (error) {
          console.error(`Failed to queue ${snapshot.type} ${snapshot.path} for ${snapshot.org}/${snapshot.site}:`, error);
          return { success: false, snapshot, error };
        }
      });

      const results = await Promise.all(queuePromises);
      const queued = results.filter((r) => r.success).map((r) => r.snapshot);
      console.log(`Successfully queued ${queued.length}/${snapshotsToPublish.length} entries for publishing`);
      if (queued.length > 0) {
        try {
          await markQueued(env, queued, new Date(Date.now()).toISOString());
        } catch (err) {
          console.error('Failed to mark queued entries in schedule.json:', err);
        }
      }
      return true;
    } catch (error) {
      console.error('Error in scheduled function:', error);
      return false;
    }
  },
};
