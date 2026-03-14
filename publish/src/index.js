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
/* eslint-disable no-await-in-loop */
/* eslint-disable quote-props */
/* eslint-disable comma-dangle */

const ADMIN_API_BASE = 'https://admin.hlx.page';
const MAIN_BRANCH = 'main';

export async function getApiKey(env, org, site) {
  try {
    if (!env || !env.SCHEDULER_KV) {
      throw new Error('KV binding is missing in the environment.');
    }
    const kvConfigKey = `${org}--${site}--apiKey`;
    const apiKey = await env.SCHEDULER_KV.get(kvConfigKey);
    if (!apiKey) {
      return null;
    }
    return apiKey;
  } catch (err) {
    console.error('Error getting API key from KV: ', org, site, err);
    return null;
  }
}

/**
 * Publish a snapshot by calling the AEM Admin API
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 * @param {string} snapshotId - The snapshot ID
 * @param {boolean} approved - Whether the snapshot is approved & published by the user
 * @returns {Promise<boolean>} - Success status
 */
async function publishSnapshot(env, org, site, snapshotId, approved) {
  try {
    const apiKey = await getApiKey(env, org, site);
    if (!apiKey) {
      console.log('Publish Snapshot Worker: No API token found');
      throw new Error('Org/Site not registered');
    }
    let res;
    if (approved) {
      console.log('Publish Snapshot Worker: approving snapshot', org, site, snapshotId);
      res = await fetch(
        `${ADMIN_API_BASE}/snapshot/${org}/${site}/${MAIN_BRANCH}/${snapshotId}?review=approve&keepResources=true`,
        {
          method: 'POST',
          headers: {
            Authorization: `token ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            'review': 'approve',
            'keepResources': 'true'
          }),
        },
      );
    } else {
      console.log('Publish Snapshot Worker: publishing snapshot', org, site, snapshotId);
      res = await fetch(
        `${ADMIN_API_BASE}/snapshot/${org}/${site}/${MAIN_BRANCH}/${snapshotId}?publish=true`,
        {
          method: 'POST',
          headers: {
            Authorization: `token ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            'publish': 'true'
          }),
        },
      );
    }

    if (res.status >= 400) {
      console.error('Publish Snapshot Worker: failed to publish snapshot', org, site, snapshotId, res.status, res.statusText);
      return false;
    }
    console.log('Publish Snapshot Worker: successfully published snapshot', org, site, snapshotId, res.status, res.statusText);
    return true;
  } catch (error) {
    console.error(`Failed to publish snapshot ${snapshotId}:`, error.message);
    return false;
  }
}

/**
 * Publish a page by calling the AEM Admin API
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 * @param {string} path - The page path
 * @returns {Promise<boolean>} - Success status
 */
async function publishPage(env, org, site, path) {
  try {
    const apiKey = await getApiKey(env, org, site);
    if (!apiKey) {
      console.log('Publish Page Worker: No API token found');
      throw new Error('Org/Site not registered');
    }
    console.log('Publish Page Worker: publishing page', org, site, path);
    const res = await fetch(`${ADMIN_API_BASE}/live/${org}/${site}/${MAIN_BRANCH}${path}`, {
      method: 'POST',
      headers: { Authorization: `token ${apiKey}` },
    });
    if (res.status >= 400) {
      console.error('Publish Page Worker: failed to publish page', org, site, path, res.status, res.statusText);
      return false;
    }
    console.log('Publish Page Worker: successfully published page', org, site, path, res.status, res.statusText);
    return true;
  } catch (error) {
    console.error(`Failed to publish page ${path}:`, error.message);
    return false;
  }
}

/**
 * Batch move completed snapshots to completed folder (single R2 write operation)
 * @param {Object} env - The environment object
 * @param {Array} snapshots - Array of {org, site, path, scheduledPublish, publishedAt}
 * @returns {Promise<void>}
 */
async function batchMoveToCompleted(env, snapshots) {
  const today = new Date().toISOString().split('T')[0];
  const completedFileName = `completed/${today}.json`;

  // Read existing completed data for today
  let completedSnapshots = [];
  try {
    const existingCompleted = await env.R2_BUCKET.get(completedFileName);
    if (existingCompleted) {
      completedSnapshots = await existingCompleted.json();
    }
  } catch (err) {
    console.log('No existing completed data for today, starting fresh');
  }

  // Add all new completed snapshots with their individual publishedAt times
  for (const snapshot of snapshots) {
    completedSnapshots.push({
      org: snapshot.org,
      site: snapshot.site,
      path: snapshot.path,
      scheduledPublish: snapshot.scheduledPublish,
      publishedAt: snapshot.publishedAt,
      publishedBy: snapshot.type === 'page' ? 'scheduled-page-publisher' : 'scheduled-snapshot-publisher',
    });
  }

  // Single write operation for all snapshots
  await env.R2_BUCKET.put(completedFileName, JSON.stringify(completedSnapshots, null, 2));
}

/**
 * Batch update scheduled.json to remove multiple published snapshots (single R2 read + write)
 * @param {Object} env - The environment object
 * @param {Array} snapshots - Array of {org, site, path}
 * @returns {Promise<void>}
 */
async function batchUpdateScheduledJson(env, snapshots) {
  try {
  // Read current schedule data (single read)
    const scheduleData = await env.R2_BUCKET.get('schedule.json');
    if (!scheduleData) {
      console.log('No schedule data found');
      throw new Error('Schedule data not found');
    }

    const schedule = await scheduleData.json();

    // Remove all published entries from schedule
    for (const snapshot of snapshots) {
      const orgSiteKey = `${snapshot.org}--${snapshot.site}`;

      if (schedule[orgSiteKey] && schedule[orgSiteKey][snapshot.path]) {
        delete schedule[orgSiteKey][snapshot.path];

        // If no more entries for this org-site, remove the entire entry
        if (Object.keys(schedule[orgSiteKey]).length === 0) {
          delete schedule[orgSiteKey];
        }
      } else {
        console.warn(`Entry ${snapshot.path} not found in scheduled.json for ${orgSiteKey}`);
      }
    }
    await env.R2_BUCKET.put('schedule.json', JSON.stringify(schedule, null, 2));
  } catch (err) {
    console.error('Failed to batch update scheduled.json:', err.message);
    throw err;
  }
}

/**
 * Check whether a schedule entry still exists in schedule.json.
 * Returns false if the entry was removed (e.g. via DELETE /schedule/page),
 * preventing publication of unscheduled items whose queue messages are
 * already in-flight.
 */
async function isStillScheduled(env, org, site, path) {
  try {
    const scheduleData = await env.R2_BUCKET.get('schedule.json');
    if (!scheduleData) return false;
    const schedule = await scheduleData.json();
    const orgSiteKey = `${org}--${site}`;
    return !!(schedule[orgSiteKey] && schedule[orgSiteKey][path]);
  } catch (err) {
    console.warn('Could not verify schedule entry, proceeding with publish:', err.message);
    return true;
  }
}

export default {
  async queue(batch, env) {
    const publishedSnapshots = [];
    // Step 1: Publish all snapshots/pages in the batch
    for (const msg of batch.messages) {
      console.log('Publish Worker: processing message');
      console.log(`Message retry count: ${msg.attempts || 0}`);
      const {
        org,
        site,
        scheduledPublish,
        approved = false,
        type = 'snapshot',
        userId,
      } = msg.body;
      // backward compat: support in-flight messages that still use snapshotId
      const path = msg.body.path ?? msg.body.snapshotId;

      try {
        // Guard: verify the entry hasn't been unscheduled while the message was in-flight
        const stillScheduled = await isStillScheduled(env, org, site, path);
        if (!stillScheduled) {
          console.log(`Skipping ${type} ${path} for ${org}/${site}: entry was unscheduled`);
          // eslint-disable-next-line no-continue
          continue;
        }

        // Publish the snapshot or page
        const publishSuccess = type === 'page'
          ? await publishPage(env, org, site, path)
          : await publishSnapshot(env, org, site, path, approved);

        if (!publishSuccess) {
          // Publish failed - throw error to trigger queue retry for entire batch
          const error = new Error(`Failed to publish ${type} ${path} for ${org}/${site}`);
          console.error(error.message);
          throw error;
        }

        // Track successfully published entry with publish timestamp
        publishedSnapshots.push({
          org,
          site,
          path,
          scheduledPublish,
          approved,
          type,
          userId,
          publishedAt: new Date().toISOString(), // Capture exact publish time
        });

        console.log(`Successfully published ${type} ${path} for ${org}/${site}`);
      } catch (err) {
        console.error(`Publish Worker failed (attempt ${msg.attempts || 1}):`, org, site, path, err.message);
        // Re-throw to signal failure and trigger automatic retry by Cloudflare Queues
        throw err;
      }
    }

    // Step 2: Batch update completed snapshots
    if (publishedSnapshots.length > 0) {
      try {
        await batchMoveToCompleted(env, publishedSnapshots);
        console.log(`Moved ${publishedSnapshots.length} snapshots to completed folder`);
      } catch (err) {
        console.error('Failed to batch move to completed:', err.message);
        throw err;
      }

      // Step 3: Batch update schedule.json
      try {
        await batchUpdateScheduledJson(env, publishedSnapshots);
        console.log(`Updated schedule.json, removed ${publishedSnapshots.length} snapshots`);
      } catch (err) {
        console.error('Failed to batch update schedule.json:', err.message);
        throw err;
      }
    }

    console.log(`Successfully processed ${publishedSnapshots.length} entries`);
  },
};
