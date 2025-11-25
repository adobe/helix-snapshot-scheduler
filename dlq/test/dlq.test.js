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
  let scheduleData;

  beforeEach(() => {
    // Reset console mocks
    console.log = () => {};
    console.error = () => {};

    storedData = {};
    scheduleData = {
      'org1--site1': {
        snapshot1: '2025-01-01T10:00:00Z',
      },
      'org2--site2': {
        snapshot2: '2025-01-01T11:00:00Z',
      },
    };

    // Mock R2 bucket
    mockEnv = {
      R2_BUCKET: {
        get: async (key) => {
          if (key.startsWith('failed/') && key.endsWith('.json')) {
            return null; // No existing failed messages
          }
          if (key === 'schedule.json') {
            return {
              json: async () => scheduleData,
            };
          }
          return null;
        },
        put: async (key, data) => {
          if (key === 'schedule.json') {
            scheduleData = JSON.parse(data);
          }
          storedData[key] = JSON.parse(data);
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

    // Verify message was stored - find the failed file key
    const failedFileKey = Object.keys(storedData).find((key) => key.startsWith('failed/'));
    assert(failedFileKey, 'Failed message file should be stored');
    assert(failedFileKey.startsWith('failed/'), 'Should be stored in failed/ folder');
    assert(failedFileKey.endsWith('.json'), 'Should be a JSON file');

    const failedData = storedData[failedFileKey];
    assert.strictEqual(failedData.length, 1, 'Should have one failed message');

    const failedMessage = failedData[0];
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
    const failedFileKey = Object.keys(storedData).find((key) => key.startsWith('failed/'));
    assert(failedFileKey, 'Failed messages should be stored');
    const failedData = storedData[failedFileKey];
    assert.strictEqual(failedData.length, 2, 'Should have two failed messages');
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
      if (key === 'schedule.json') {
        return {
          json: async () => scheduleData,
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
    const failedFileKey = Object.keys(storedData).find((key) => key.startsWith('failed/'));
    assert(failedFileKey, 'Failed messages should be stored');
    const failedData = storedData[failedFileKey];
    assert.strictEqual(failedData.length, 2, 'Should have previous + new message');
    assert.strictEqual(failedData[0].snapshotId, 'prev-snapshot', 'Previous message preserved');
    assert.strictEqual(failedData[1].snapshotId, 'snapshot1', 'New message added');
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

  it('should remove failed snapshot from schedule.json', async () => {
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

    // Verify snapshot was removed from schedule.json
    assert(!scheduleData['org1--site1'], 'org1--site1 entry should be removed when no snapshots remain');
    assert(scheduleData['org2--site2'], 'org2--site2 entry should remain');
    assert.strictEqual(scheduleData['org2--site2'].snapshot2, '2025-01-01T11:00:00Z');
  });

  it('should remove only failed snapshot from schedule.json, keeping others', async () => {
    // Add another snapshot to org1--site1
    scheduleData['org1--site1'].snapshot3 = '2025-01-01T12:00:00Z';

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

    // Verify only snapshot1 was removed, snapshot3 remains
    assert(scheduleData['org1--site1'], 'org1--site1 entry should remain');
    assert(!scheduleData['org1--site1'].snapshot1, 'snapshot1 should be removed');
    assert.strictEqual(scheduleData['org1--site1'].snapshot3, '2025-01-01T12:00:00Z', 'snapshot3 should remain');
  });

  it('should remove multiple failed snapshots from schedule.json', async () => {
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

    // Verify both snapshots were removed from schedule.json
    assert(!scheduleData['org1--site1'], 'org1--site1 entry should be removed');
    assert(!scheduleData['org2--site2'], 'org2--site2 entry should be removed');
    assert.strictEqual(Object.keys(scheduleData).length, 0, 'schedule.json should be empty');
  });

  it('should not throw error if schedule.json does not exist', async () => {
    mockEnv.R2_BUCKET.get = async (key) => {
      if (key === 'schedule.json') {
        return null; // schedule.json doesn't exist
      }
      if (key.startsWith('failed/') && key.endsWith('.json')) {
        return null;
      }
      return null;
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

  it('should not throw error if schedule.json removal fails', async () => {
    let putCallCount = 0;
    mockEnv.R2_BUCKET.put = async (key, data) => {
      putCallCount += 1;
      if (key === 'schedule.json') {
        throw new Error('Failed to update schedule.json');
      }
      storedData[key] = JSON.parse(data);
      return true;
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

    // Verify failed message was still stored despite schedule.json error
    const failedFileKey = Object.keys(storedData).find((key) => key.startsWith('failed/'));
    assert(failedFileKey, 'Failed message should be stored');
    assert(failedFileKey.startsWith('failed/'), 'Should be stored in failed/ folder');
  });
});
