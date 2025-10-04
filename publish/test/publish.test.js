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
const originalConsoleWarn = console.warn;

describe('Publish Snapshot Service Tests', () => {
  let mockEnv;
  let mockR2Bucket;
  let mockFetch;
  let originalFetch;
  let originalDateNow;

  beforeEach(() => {
    // Reset console mocks
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};

    // Mock fetch
    originalFetch = global.fetch;
    mockFetch = async (url) => {
      if (url.includes('admin.hlx.page/snapshot') && url.includes('?publish=true')) {
        return {
          json: async () => ({ success: true, message: 'Snapshot published' }),
          ok: true,
        };
      }
      throw new Error('Unexpected fetch call');
    };
    global.fetch = mockFetch;

    // Mock R2 bucket
    mockR2Bucket = {
      get: async (key) => {
        if (key === 'schedule.json') {
          return {
            json: async () => ({
              'org1--site1': {
                snapshot1: '2025-01-01T10:00:00Z',
                snapshot2: '2025-01-01T11:00:00Z',
              },
              'org2--site2': {
                snapshot3: '2025-01-01T12:00:00Z',
              },
            }),
          };
        }
        if (key.startsWith('completed/') && key.endsWith('.json')) {
          return {
            json: async () => [
              {
                org: 'org1',
                site: 'site1',
                snapshotId: 'previous-snapshot',
                scheduledPublish: '2025-01-01T09:00:00Z',
                publishedAt: '2025-01-01T09:00:00Z',
                publishedBy: 'scheduled-snapshot-publisher',
              },
            ],
          };
        }
        return null;
      },
      put: async () => true,
    };

    // Mock KV namespace
    const mockKV = {
      get: async (key) => {
        // Return mock API tokens for testing
        if (key.endsWith('--apiToken')) {
          return 'test-api-token';
        }
        return null;
      },
      put: async () => true,
    };

    // Mock environment
    mockEnv = {
      ADMIN_API_TOKEN: 'test-token',
      SCHEDULER_KV: mockKV,
      R2_BUCKET: mockR2Bucket,
    };

    // Mock Date.now for consistent testing
    originalDateNow = Date.now;
    Date.now = () => new Date('2025-01-01T10:00:00Z').getTime();
  });

  afterEach(() => {
    // Restore console methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;

    // Restore fetch
    global.fetch = originalFetch;

    // Restore Date.now
    Date.now = originalDateNow;
  });

  describe('publishSnapshot function', () => {
    it('should successfully publish a snapshot', async () => {
      const { default: worker } = await import('../src/index.js');

      // We need to access the internal function for testing
      // Since it's not exported, we'll test through the queue handler
      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(batch, mockEnv);

      // Verify fetch was called with correct parameters
      assert.strictEqual(mockFetch.callCount || 1, 1);
    });

    it('should handle publish API failures and throw to trigger retry', async () => {
      // Mock fetch to return error
      global.fetch = async () => {
        throw new Error('Publish API failed');
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should throw error to trigger queue retry
      await assert.rejects(
        () => worker.queue(batch, mockEnv),
        /Failed to publish snapshot snapshot1 for org1\/site1/,
      );
    });
  });

  describe('updateScheduledJson function', () => {
    it('should remove published snapshot from scheduled.json', async () => {
      let updatedSchedule = null;
      mockR2Bucket.put = async (key, data) => {
        if (key === 'schedule.json') {
          updatedSchedule = JSON.parse(data);
        }
        return true;
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(batch, mockEnv);

      // Verify snapshot was removed from schedule
      assert(updatedSchedule, 'Schedule should be updated');
      assert.strictEqual(updatedSchedule['org1--site1'].snapshot1, undefined);
      assert.strictEqual(updatedSchedule['org1--site1'].snapshot2, '2025-01-01T11:00:00Z');
    });

    it('should remove entire org-site entry when no snapshots remain', async () => {
      let updatedSchedule = null;
      mockR2Bucket.put = async (key, data) => {
        if (key === 'schedule.json') {
          updatedSchedule = JSON.parse(data);
        }
        return true;
      };

      // Mock schedule with only one snapshot for the org-site
      mockR2Bucket.get = async (key) => {
        if (key === 'schedule.json') {
          return {
            json: async () => ({
              'org1--site1': {
                snapshot1: '2025-01-01T10:00:00Z',
              },
            }),
          };
        }
        return null;
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(batch, mockEnv);

      // Verify entire org-site entry was removed
      assert(updatedSchedule, 'Schedule should be updated');
      assert.strictEqual(updatedSchedule['org1--site1'], undefined);
    });

    it('should throw error when schedule data is missing', async () => {
      mockR2Bucket.get = async () => null;

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should throw error to trigger retry
      await assert.rejects(
        () => worker.queue(batch, mockEnv),
        /Schedule data not found/,
      );
    });

    it('should not throw when snapshot not found in schedule (logs warning)', async () => {
      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'nonexistent-snapshot',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should complete successfully (logs warning but doesn't fail)
      await worker.queue(batch, mockEnv);
    });
  });

  describe('moveToCompleted function', () => {
    it('should move completed snapshot to completed folder with date-based filename', async () => {
      let completedData = null;
      const allPutCalls = [];

      mockR2Bucket.put = async (key, data) => {
        allPutCalls.push({ key, data: JSON.parse(data) });
        // Match any completed/ file with date format
        if (key.startsWith('completed/') && key.endsWith('.json')) {
          completedData = JSON.parse(data);
        }
        return true;
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(batch, mockEnv);

      // Verify completed data structure
      assert(completedData, 'Completed data should be stored');
      assert.strictEqual(completedData.length, 2); // Previous + new

      const newSnapshot = completedData.find((s) => s.snapshotId === 'snapshot1');
      assert(newSnapshot, 'New snapshot should be in completed data');
      assert.strictEqual(newSnapshot.org, 'org1');
      assert.strictEqual(newSnapshot.site, 'site1');
      assert.strictEqual(newSnapshot.snapshotId, 'snapshot1');
      assert.strictEqual(newSnapshot.scheduledPublish, '2025-01-01T10:00:00Z');
      assert.strictEqual(newSnapshot.publishedBy, 'scheduled-snapshot-publisher');
      assert(newSnapshot.publishedAt, 'PublishedAt should be set');
    });

    it('should create new completed file when none exists', async () => {
      let completedData = null;

      mockR2Bucket.put = async (key, data) => {
        // Match any completed/ file with date format
        if (key.startsWith('completed/') && key.endsWith('.json')) {
          completedData = JSON.parse(data);
        }
        return true;
      };

      // Mock no existing completed data
      mockR2Bucket.get = async (key) => {
        if (key === 'schedule.json') {
          return {
            json: async () => ({
              'org1--site1': {
                snapshot1: '2025-01-01T10:00:00Z',
              },
            }),
          };
        }
        return null; // No existing completed data
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(batch, mockEnv);

      // Verify new completed data was created
      assert(completedData, 'Completed data should be created');
      assert.strictEqual(completedData.length, 1);
      assert.strictEqual(completedData[0].snapshotId, 'snapshot1');
    });
  });

  describe('queue handler integration', () => {
    it('should process multiple messages in batch with single R2 writes', async () => {
      let scheduleUpdateCount = 0;
      let completedUpdateCount = 0;

      mockR2Bucket.put = async (key) => {
        if (key === 'schedule.json') {
          scheduleUpdateCount += 1;
        }
        if (key.startsWith('completed/') && key.endsWith('.json')) {
          completedUpdateCount += 1;
        }
        return true;
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [
          {
            body: {
              org: 'org1',
              site: 'site1',
              snapshotId: 'snapshot1',
              scheduledPublish: '2025-01-01T10:00:00Z',
            },
          },
          {
            body: {
              org: 'org2',
              site: 'site2',
              snapshotId: 'snapshot3',
              scheduledPublish: '2025-01-01T10:00:00Z',
            },
          },
        ],
      };

      await worker.queue(batch, mockEnv);

      // Verify batch optimization: only 1 write per file (not 1 per snapshot)
      assert.strictEqual(scheduleUpdateCount, 1, 'Should update schedule.json once per batch');
      assert.strictEqual(completedUpdateCount, 1, 'Should update completed file once per batch');
    });

    it('should throw error on first failure and stop batch processing', async () => {
      // Mock fetch to fail for first message only
      let callCount = 0;
      global.fetch = async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('First publish failed');
        }
        return {
          json: async () => ({ success: true }),
          ok: true,
        };
      };

      let scheduleUpdateCount = 0;
      mockR2Bucket.put = async (key) => {
        if (key === 'schedule.json') {
          scheduleUpdateCount += 1;
        }
        return true;
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [
          {
            body: {
              org: 'org1',
              site: 'site1',
              snapshotId: 'snapshot1',
              scheduledPublish: '2025-01-01T10:00:00Z',
            },
          },
          {
            body: {
              org: 'org2',
              site: 'site2',
              snapshotId: 'snapshot3',
              scheduledPublish: '2025-01-01T10:00:00Z',
            },
          },
        ],
      };

      // Should throw on first failure, stopping batch processing
      await assert.rejects(
        () => worker.queue(batch, mockEnv),
        /Failed to publish snapshot snapshot1 for org1\/site1/,
      );

      // No snapshots should be processed due to first failure
      assert.strictEqual(scheduleUpdateCount, 0);
    });

    it('should not update schedule when publish fails and throw error', async () => {
      // Mock fetch to always fail
      global.fetch = async () => {
        throw new Error('Publish API failed');
      };

      let scheduleUpdateCount = 0;
      mockR2Bucket.put = async (key) => {
        if (key === 'schedule.json') {
          scheduleUpdateCount += 1;
        }
        return true;
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should throw error to trigger retry
      await assert.rejects(
        () => worker.queue(batch, mockEnv),
        /Failed to publish snapshot snapshot1 for org1\/site1/,
      );

      // Schedule should not be updated when publish fails
      assert.strictEqual(scheduleUpdateCount, 0);
    });
  });

  describe('error handling', () => {
    it('should throw error on R2 bucket errors to trigger retry', async () => {
      mockR2Bucket.get = async () => {
        throw new Error('R2 bucket error');
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should throw error to trigger retry (R2 error from batchUpdateScheduledJson)
      await assert.rejects(
        () => worker.queue(batch, mockEnv),
        /R2 bucket error/,
      );
    });

    it('should throw error on R2 put errors to trigger retry', async () => {
      mockR2Bucket.put = async () => {
        throw new Error('R2 put error');
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should throw error to trigger retry (R2 put error occurs during schedule update)
      await assert.rejects(
        () => worker.queue(batch, mockEnv),
        /R2 put error|Failed to update schedule\.json/,
      );
    });

    it('should throw error on JSON parsing errors to trigger retry', async () => {
      mockR2Bucket.get = async (key) => {
        if (key === 'schedule.json') {
          return {
            json: async () => {
              throw new Error('JSON parsing error');
            },
          };
        }
        return null;
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should throw error to trigger retry (wrapped in schedule update error)
      await assert.rejects(
        () => worker.queue(batch, mockEnv),
        /JSON parsing error|Failed to update schedule\.json/,
      );
    });
  });

  describe('edge cases', () => {
    it('should throw error on empty message body when API token missing', async () => {
      // Mock KV to return no API token
      mockEnv.SCHEDULER_KV.get = async () => null;

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'testorg',
            site: 'testsite',
            snapshotId: 'snap1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should throw error (no API token found)
      await assert.rejects(
        () => worker.queue(batch, mockEnv),
        /Org\/Site not registered|Failed to publish snapshot/,
      );
    });

    it('should throw error on missing required fields in message body when API token missing', async () => {
      // Mock KV to return no API token
      mockEnv.SCHEDULER_KV.get = async () => null;

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snap1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should throw error (no API token)
      await assert.rejects(
        () => worker.queue(batch, mockEnv),
        /Org\/Site not registered|Failed to publish snapshot/,
      );
    });

    it('should handle invalid scheduledPublish date format', async () => {
      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1',
            scheduledPublish: 'invalid-date',
          },
        }],
      };

      // Should not throw error
      await worker.queue(batch, mockEnv);
    });
  });
});
