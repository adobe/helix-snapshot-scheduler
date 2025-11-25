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

/**
 * Batch update scheduled.json to remove multiple failed snapshots
 * @param {Object} env - The environment object
 * @param {Array} snapshots - Array of {org, site, snapshotId}
 * @returns {Promise<void>}
 */
async function batchRemoveFromScheduledJson(env, snapshots) {
  try {
    // Read current schedule data
    const scheduleData = await env.R2_BUCKET.get('schedule.json');
    if (!scheduleData) {
      console.log('No schedule data found');
      return;
    }

    const schedule = await scheduleData.json();

    // Remove all failed snapshots from schedule
    for (const snapshot of snapshots) {
      const orgSiteKey = `${snapshot.org}--${snapshot.site}`;

      if (schedule[orgSiteKey] && schedule[orgSiteKey][snapshot.snapshotId]) {
        delete schedule[orgSiteKey][snapshot.snapshotId];

        // If no more snapshots for this org-site, remove the entire entry
        if (Object.keys(schedule[orgSiteKey]).length === 0) {
          delete schedule[orgSiteKey];
        }

        console.log(`Removed failed snapshot ${snapshot.snapshotId} from schedule.json for ${orgSiteKey}`);
      } else {
        console.warn(`Snapshot ${snapshot.snapshotId} not found in schedule.json for ${orgSiteKey}`);
      }
    }

    // Write updated schedule back to R2
    await env.R2_BUCKET.put('schedule.json', JSON.stringify(schedule, null, 2));
    console.log(`Removed ${snapshots.length} failed snapshots from schedule.json`);
  } catch (err) {
    console.error('Failed to batch update schedule.json:', err.message);
    // Don't throw - we don't want DLQ messages to fail and retry
  }
}

/**
 * Dead Letter Queue (DLQ) Consumer
 * Handles messages that failed after all retry attempts in the publish queue.
 * Logs failures and stores them in R2 for investigation and potential manual recovery.
 * Also removes failed entries from schedule.json to prevent further processing.
 */

export default {
  async queue(batch, env) {
    console.log(`DLQ Consumer processing ${batch.messages.length} failed messages`);

    const failedMessages = [];

    // Log all failed messages
    for (const msg of batch.messages) {
      const {
        org,
        site,
        snapshotId,
        scheduledPublish,
      } = msg.body;

      console.error('='.repeat(80));
      console.error('FAILED MESSAGE - Exceeded max retries');
      console.error('='.repeat(80));
      console.error(`Org: ${org}`);
      console.error(`Site: ${site}`);
      console.error(`Snapshot ID: ${snapshotId}`);
      console.error(`Scheduled Publish: ${scheduledPublish}`);
      console.error(`Message ID: ${msg.id}`);
      console.error(`Timestamp: ${msg.timestamp}`);
      console.error('='.repeat(80));

      failedMessages.push({
        org,
        site,
        snapshotId,
        scheduledPublish,
        messageId: msg.id,
        timestamp: msg.timestamp,
      });
    }

    // Batch store all failed messages in single R2 write
    if (failedMessages.length > 0) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const failedFileName = `failed/${today}.json`;

        // Read existing failed messages for today
        let existingFailed = [];
        try {
          const existing = await env.R2_BUCKET.get(failedFileName);
          if (existing) {
            existingFailed = await existing.json();
          }
        } catch (err) {
          console.log('No existing failed messages for today, starting fresh');
        }

        // Add all new failed messages with metadata
        const failedAt = new Date().toISOString();
        for (const msg of failedMessages) {
          existingFailed.push({
            ...msg,
            failedAt,
            reason: 'exceeded-max-retries',
          });
        }

        // Single write operation for all failed messages
        await env.R2_BUCKET.put(failedFileName, JSON.stringify(existingFailed, null, 2));
        console.log(`Stored ${failedMessages.length} failed messages in ${failedFileName}`);
      } catch (err) {
        console.error('Failed to store DLQ messages in R2:', err);
        // Don't throw - we don't want DLQ messages to fail and retry
      }

      // Remove failed snapshots from schedule.json
      try {
        await batchRemoveFromScheduledJson(env, failedMessages);
      } catch (err) {
        console.error('Failed to remove failed snapshots from schedule.json:', err);
        // Don't throw - we don't want DLQ messages to fail and retry
      }
    }
    console.log(`DLQ Consumer processed ${batch.messages.length} failed messages`);
  },
};
