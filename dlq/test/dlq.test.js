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

import {
  describe, it, beforeEach, afterEach,
} from 'node:test';
import assert from 'node:assert';

// Mock console methods to avoid noise in tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

describe('DLQ Consumer Tests', () => {
  let mockEnv;
  let storedData;

  beforeEach(() => {
    // Reset console mocks
    console.log = () => {};
    console.error = () => {};

    storedData = null;

    // Mock R2 bucket
    mockEnv = {
      R2_BUCKET: {
        get: async (key) => {
          if (key.startsWith('failed/') && key.endsWith('.json')) {
            return null; // No existing failed messages
          }
          return null;
        },
        put: async (key, data) => {
          storedData = { key, data: JSON.parse(data) };
          return true;
        },
      },
    };
  });

  afterEach(() => {
    // Restore console methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('should process failed messages and store in R2', async () => {
    const { default: worker } = await import('../src/index.js');

    const batch = {
      messages: [
        {
          id: 'msg-123',
          timestamp: 1696412100000,
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        },
      ],
    };

    await worker.queue(batch, mockEnv);

    // Verify message was stored
    assert(storedData, 'Failed message should be stored');
    assert(storedData.key.startsWith('failed/'), 'Should be stored in failed/ folder');
    assert(storedData.key.endsWith('.json'), 'Should be a JSON file');
    assert.strictEqual(storedData.data.length, 1, 'Should have one failed message');

    const failedMessage = storedData.data[0];
    assert.strictEqual(failedMessage.org, 'org1');
    assert.strictEqual(failedMessage.site, 'site1');
    assert.strictEqual(failedMessage.snapshotId, 'snapshot1');
    assert.strictEqual(failedMessage.scheduledPublish, '2025-01-01T10:00:00Z');
    assert.strictEqual(failedMessage.messageId, 'msg-123');
    assert.strictEqual(failedMessage.reason, 'exceeded-max-retries');
    assert(failedMessage.failedAt, 'Should have failedAt timestamp');
  });

  it('should process multiple failed messages in batch', async () => {
    const { default: worker } = await import('../src/index.js');

    const batch = {
      messages: [
        {
          id: 'msg-1',
          timestamp: 1696412100000,
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        },
        {
          id: 'msg-2',
          timestamp: 1696412200000,
          body: {
            org: 'org2',
            site: 'site2',
            snapshotId: 'snapshot2',
            scheduledPublish: '2025-01-01T11:00:00Z',
          },
        },
      ],
    };

    await worker.queue(batch, mockEnv);

    // Verify both messages were stored
    assert(storedData, 'Failed messages should be stored');
    assert.strictEqual(storedData.data.length, 2, 'Should have two failed messages');
  });

  it('should append to existing failed messages', async () => {
    // Mock existing failed messages
    mockEnv.R2_BUCKET.get = async (key) => {
      if (key.startsWith('failed/') && key.endsWith('.json')) {
        return {
          json: async () => [
            {
              org: 'prev-org',
              site: 'prev-site',
              snapshotId: 'prev-snapshot',
              scheduledPublish: '2025-01-01T09:00:00Z',
              failedAt: '2025-01-01T09:05:00Z',
              reason: 'exceeded-max-retries',
            },
          ],
        };
      }
      return null;
    };

    const { default: worker } = await import('../src/index.js');

    const batch = {
      messages: [
        {
          id: 'msg-new',
          timestamp: 1696412100000,
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        },
      ],
    };

    await worker.queue(batch, mockEnv);

    // Verify new message was appended
    assert(storedData, 'Failed messages should be stored');
    assert.strictEqual(storedData.data.length, 2, 'Should have previous + new message');
    assert.strictEqual(storedData.data[0].snapshotId, 'prev-snapshot', 'Previous message preserved');
    assert.strictEqual(storedData.data[1].snapshotId, 'snapshot1', 'New message added');
  });

  it('should not throw error if R2 storage fails', async () => {
    // Mock R2 to fail
    mockEnv.R2_BUCKET.put = async () => {
      throw new Error('R2 storage failed');
    };

    const { default: worker } = await import('../src/index.js');

    const batch = {
      messages: [
        {
          id: 'msg-123',
          timestamp: 1696412100000,
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        },
      ],
    };

    // Should not throw - DLQ consumer should be resilient
    await worker.queue(batch, mockEnv);
  });
});
