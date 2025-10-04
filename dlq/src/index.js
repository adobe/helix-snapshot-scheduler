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
 * Dead Letter Queue (DLQ) Consumer
 * Handles messages that failed after all retry attempts in the publish queue.
 * Logs failures and stores them in R2 for investigation and potential manual recovery.
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
    }
    console.log(`DLQ Consumer processed ${batch.messages.length} failed messages`);
  },
};
