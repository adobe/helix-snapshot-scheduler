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

import { logScheduledPublish } from '../../shared/admin.js';
import { appendToDailyFile, removeFromSchedule } from '../../shared/schedule-store.js';

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
        scheduledPublish,
        type = 'snapshot',
        userId,
      } = msg.body;
      // backward compat: support in-flight messages that still use snapshotId
      const path = msg.body.path ?? msg.body.snapshotId;

      console.error('='.repeat(80));
      console.error('FAILED MESSAGE - Exceeded max retries');
      console.error('='.repeat(80));
      console.error(`Org: ${org}`);
      console.error(`Site: ${site}`);
      console.error(`Path: ${path}`);
      console.error(`Type: ${type}`);
      console.error(`Scheduled Publish: ${scheduledPublish}`);
      console.error(`Message ID: ${msg.id}`);
      console.error(`Timestamp: ${msg.timestamp}`);
      console.error('='.repeat(80));

      failedMessages.push({
        org,
        site,
        path,
        scheduledPublish,
        type,
        userId,
        messageId: msg.id,
        timestamp: msg.timestamp,
      });
    }

    if (failedMessages.length > 0) {
      try {
        const failedAt = new Date().toISOString();
        await appendToDailyFile(env, 'failed', failedMessages.map((msg) => ({
          ...msg,
          failedAt,
          reason: 'exceeded-max-retries',
        })));
        console.log(`Stored ${failedMessages.length} failed messages in failed/`);
      } catch (err) {
        console.error('Failed to store DLQ messages in R2:', err);
        // Don't throw - we don't want DLQ messages to fail and retry
      }

      try {
        await removeFromSchedule(env, failedMessages);
        console.log(`Removed ${failedMessages.length} failed snapshots from schedule.json`);
      } catch (err) {
        console.error('Failed to remove failed snapshots from schedule.json:', err);
        // Don't throw - we don't want DLQ messages to fail and retry
      }

      await Promise.all(failedMessages.map((m) => logScheduledPublish(env, m, {
        status: 'failed',
      })));
    }
    console.log(`DLQ Consumer processed ${batch.messages.length} failed messages`);
  },
};
