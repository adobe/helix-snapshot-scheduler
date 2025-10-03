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

const ADMIN_API_BASE = 'https://admin.hlx.page';
const MAIN_BRANCH = 'main';

export async function getApiToken(env, org, site) {
  try {
    if (!env || !env.SCHEDULER_KV) {
      throw new Error('KV binding is missing in the environment.');
    }
    const kvConfigKey = `${org}--${site}--apiToken`;
    const apiToken = await env.SCHEDULER_KV.get(kvConfigKey);
    if (!apiToken) {
      return null;
    }
    return apiToken;
  } catch (err) {
    console.error('Error getting API token from KV: ', org, site, err);
    return null;
  }
}

/**
 * Publish a snapshot by calling the AEM Admin API
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 * @param {string} snapshotId - The snapshot ID
 * @returns {Promise<boolean>} - Success status
 */
async function publishSnapshot(env, org, site, snapshotId) {
  try {
    const apiToken = await getApiToken(env, org, site);
    if (!apiToken) {
      console.log('Publish Snapshot Worker: No API token found');
      throw new Error('Org/Site not registered');
    }
    console.log('Publish Snapshot Worker: publishing snapshot', org, site, snapshotId);
    const publishResponse = await fetch(
      `${ADMIN_API_BASE}/snapshot/${org}/${site}/${MAIN_BRANCH}/${snapshotId}?publish=true`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publish: true,
        }),
      },
    ).then((res) => res.json());
    console.log(publishResponse);
    console.log(`Successfully published snapshot ${snapshotId}`);
    return true;
  } catch (error) {
    console.error(`Failed to publish snapshot ${snapshotId}:`, error.message);
    return false;
  }
}

/**
 * Update scheduled.json to remove the published snapshot
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 * @param {string} snapshotId - The snapshot ID
 * @returns {Promise<boolean>} - Success status
 */
async function updateScheduledJson(env, org, site, snapshotId) {
  try {
    // Read current schedule data
    const scheduleData = await env.R2_BUCKET.get('schedule.json');
    if (!scheduleData) {
      console.log('No schedule data found');
      return false;
    }

    const schedule = await scheduleData.json();
    const orgSiteKey = `${org}--${site}`;

    if (schedule[orgSiteKey] && schedule[orgSiteKey][snapshotId]) {
      // Remove the snapshot from scheduled.json
      delete schedule[orgSiteKey][snapshotId];

      // If no more snapshots for this org-site, remove the entire entry
      if (Object.keys(schedule[orgSiteKey]).length === 0) {
        delete schedule[orgSiteKey];
      }

      // Update the schedule file
      await env.R2_BUCKET.put('schedule.json', JSON.stringify(schedule, null, 2));
      console.log(`Removed snapshot ${snapshotId} from scheduled.json for ${orgSiteKey}`);
      return true;
    } else {
      console.warn(`Snapshot ${snapshotId} not found in scheduled.json for ${orgSiteKey}`);
      return false;
    }
  } catch (error) {
    console.error(`Failed to update scheduled.json for ${org}/${site}/${snapshotId}:`, error);
    return false;
  }
}

/**
 * Move completed snapshot to completed folder with date-based JSON file
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 * @param {string} snapshotId - The snapshot ID
 * @param {string} scheduledPublish - The original scheduled publish time
 * @returns {Promise<boolean>} - Success status
 */
async function moveToCompleted(env, org, site, snapshotId, scheduledPublish) {
  try {
    const completedData = {
      org,
      site,
      snapshotId,
      scheduledPublish,
      publishedAt: new Date().toISOString(),
      publishedBy: 'scheduled-snapshot-publisher',
    };

    // Create date-based filename (YYYY-MM-DD.json)
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

    // Add the new completed snapshot
    completedSnapshots.push(completedData);

    // Store the updated completed data
    await env.R2_BUCKET.put(completedFileName, JSON.stringify(completedSnapshots, null, 2));
    console.log(`Moved snapshot ${snapshotId} to completed folder: ${completedFileName}`);
    return true;
  } catch (error) {
    console.error(`Failed to move snapshot ${snapshotId} to completed folder:`, error);
    return false;
  }
}

export default {
  async queue(batch, env) {
    // Process each message in the batch
    for (const msg of batch.messages) {
      console.log('Publish Snapshot Worker: processing message', msg.body);
      const {
        org,
        site,
        snapshotId,
        scheduledPublish,
      } = msg.body;

      try {
        // Step 1: Publish the snapshot
        const publishSuccess = await publishSnapshot(env, org, site, snapshotId);

        if (publishSuccess) {
          // Step 2: Move to completed folder
          await moveToCompleted(env, org, site, snapshotId, scheduledPublish);
          // Step 3: Update scheduled.json to remove the published snapshot
          await updateScheduledJson(env, org, site, snapshotId);
          console.log(`Successfully processed snapshot ${snapshotId} for ${org}/${site}`);
        } else {
          console.error(`Failed to publish snapshot ${snapshotId} for ${org}/${site}, not updating schedule`);
          // Note: We don't requeue here as the cron job will retry based on scheduled.json
        }
      } catch (err) {
        console.error('Publish Snapshot Worker failed: ', org, site, snapshotId, err);
        // Don't fail the entire process if one snapshot fails
      }
    }
  },
};
