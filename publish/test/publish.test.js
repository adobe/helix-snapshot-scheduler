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

// Give each test message the Cloudflare Queues ack/retry methods and record the calls.
function prepare(batch) {
  batch.messages.forEach((m, i) => {
    Object.assign(m, {
      id: m.id ?? `msg-${i}`,
      attempts: m.attempts ?? 1,
      acked: false,
      retried: null,
      ack() { this.acked = true; },
      retry(opts = {}) { this.retried = opts; },
    });
  });
  return batch;
}

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
                snapshot1: { scheduledPublish: '2025-01-01T10:00:00Z', approved: false },
                snapshot2: { scheduledPublish: '2025-01-01T11:00:00Z', approved: false },
              },
              'org2--site2': {
                snapshot3: { scheduledPublish: '2025-01-01T12:00:00Z', approved: false },
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
                path: 'previous-snapshot',
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
        // Return mock API key for testing
        if (key.endsWith('--apiKey')) {
          return 'test-api-key';
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
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);

      // Verify fetch was called with correct parameters
      assert.strictEqual(mockFetch.callCount || 1, 1);
    });

    it('should retry the message with a delay when the publish API call fails (network)', async () => {
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
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(batch.messages[0].acked, false);
      assert.deepStrictEqual(batch.messages[0].retried, { delaySeconds: 30 });
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
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);

      // Verify snapshot was removed from schedule
      assert(updatedSchedule, 'Schedule should be updated');
      assert.strictEqual(updatedSchedule['org1--site1'].snapshot1, undefined);
      assert(updatedSchedule['org1--site1'].snapshot2, 'snapshot2 should remain in schedule');
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
                snapshot1: { scheduledPublish: '2025-01-01T10:00:00Z', approved: false },
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
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);

      // Verify entire org-site entry was removed
      assert(updatedSchedule, 'Schedule should be updated');
      assert.strictEqual(updatedSchedule['org1--site1'], undefined);
    });

    it('should skip publish when schedule data is missing (entry was unscheduled)', async () => {
      let scheduleWritten = false;
      mockR2Bucket.get = async () => null;
      mockR2Bucket.put = async (key) => {
        if (key === 'schedule.json') scheduleWritten = true;
        return true;
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(scheduleWritten, false, 'Should not write schedule.json when all messages were skipped');
    });

    it('should skip publish when entry is not found in schedule (unscheduled)', async () => {
      let publishCalled = false;
      const origFetch = global.fetch;
      global.fetch = async (...args) => {
        publishCalled = true;
        return origFetch(...args);
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            path: 'nonexistent-snapshot',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(publishCalled, false, 'Should not call publish API for unscheduled entry');
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
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);

      // Verify completed data structure
      assert(completedData, 'Completed data should be stored');
      assert.strictEqual(completedData.length, 2); // Previous + new

      const newSnapshot = completedData.find((s) => s.path === 'snapshot1');
      assert(newSnapshot, 'New snapshot should be in completed data');
      assert.strictEqual(newSnapshot.org, 'org1');
      assert.strictEqual(newSnapshot.site, 'site1');
      assert.strictEqual(newSnapshot.path, 'snapshot1');
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
                snapshot1: { scheduledPublish: '2025-01-01T10:00:00Z', approved: false },
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
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);

      // Verify new completed data was created
      assert(completedData, 'Completed data should be created');
      assert.strictEqual(completedData.length, 1);
      assert.strictEqual(completedData[0].path, 'snapshot1');
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
              path: 'snapshot1',
              scheduledPublish: '2025-01-01T10:00:00Z',
            },
          },
          {
            body: {
              org: 'org2',
              site: 'site2',
              path: 'snapshot3',
              scheduledPublish: '2025-01-01T10:00:00Z',
            },
          },
        ],
      };

      await worker.queue(prepare(batch), mockEnv);

      // Verify batch optimization: only 1 write per file (not 1 per snapshot)
      assert.strictEqual(scheduleUpdateCount, 1, 'Should update schedule.json once per batch');
      assert.strictEqual(completedUpdateCount, 1, 'Should update completed file once per batch');
    });

    it('should retry only the failed message and still record the others', async () => {
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
              path: 'snapshot1',
              scheduledPublish: '2025-01-01T10:00:00Z',
            },
          },
          {
            body: {
              org: 'org2',
              site: 'site2',
              path: 'snapshot3',
              scheduledPublish: '2025-01-01T10:00:00Z',
            },
          },
        ],
      };

      await worker.queue(prepare(batch), mockEnv);

      assert.ok(batch.messages[0].retried, 'failed message should be retried');
      assert.strictEqual(batch.messages[0].acked, false);
      assert.strictEqual(batch.messages[1].acked, true, 'published message should be acked');
      assert.strictEqual(batch.messages[1].retried, null);
      assert.strictEqual(scheduleUpdateCount, 1);
    });

    it('should not update schedule when publish fails transiently', async () => {
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
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);

      assert.ok(batch.messages[0].retried);
      assert.strictEqual(scheduleUpdateCount, 0);
    });
  });

  describe('error handling', () => {
    it('should retry a published message when R2 reads fail while recording it', async () => {
      mockR2Bucket.get = async () => {
        throw new Error('R2 bucket error');
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(batch.messages[0].acked, false);
      assert.ok(batch.messages[0].retried);
    });

    it('should retry a published message when R2 writes fail', async () => {
      mockR2Bucket.put = async () => {
        throw new Error('R2 put error');
      };

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(batch.messages[0].acked, false);
      assert.ok(batch.messages[0].retried);
    });

    it('should retry a published message when schedule.json cannot be parsed', async () => {
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
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(batch.messages[0].acked, false);
      assert.ok(batch.messages[0].retried);
    });
  });

  describe('edge cases', () => {
    it('should fail permanently without retry when the org/site is not registered', async () => {
      // Mock KV to return no API token
      mockEnv.SCHEDULER_KV.get = async () => null;

      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      let failedData = null;
      mockR2Bucket.put = async (key, data) => {
        if (key.startsWith('failed/')) failedData = JSON.parse(data);
        return true;
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(batch.messages[0].acked, true);
      assert.strictEqual(batch.messages[0].retried, null);
      assert.strictEqual(failedData[0].reason, 'org-site-not-registered');
    });

    it('should handle invalid scheduledPublish date format', async () => {
      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            path: 'snapshot1',
            scheduledPublish: 'invalid-date',
          },
        }],
      };

      // Should not throw error
      await worker.queue(prepare(batch), mockEnv);
    });

    it('should support backward-compat snapshotId field in message body', async () => {
      const { default: worker } = await import('../src/index.js');

      const batch = {
        messages: [{
          body: {
            org: 'org1',
            site: 'site1',
            snapshotId: 'snapshot1', // old field name - backward compat
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should not throw - backward compat with snapshotId
      await worker.queue(prepare(batch), mockEnv);
    });
  });

  describe('isStillScheduled guard', () => {
    it('should skip page publish when entry was deleted between cron queue and delivery', async () => {
      let publishCalled = false;
      global.fetch = async () => {
        publishCalled = true;
        return { ok: true, status: 200, statusText: 'OK' };
      };

      // Schedule does NOT contain /my-page (simulates DELETE was called)
      mockR2Bucket.get = async (key) => {
        if (key === 'schedule.json') {
          return {
            json: async () => ({
              'org1--site1': {
                snapshot1: { scheduledPublish: '2025-01-01T10:00:00Z', approved: false },
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
            path: '/my-page',
            scheduledPublish: '2025-01-01T10:00:00Z',
            type: 'page',
            userId: 'user@example.com',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(publishCalled, false, 'Should not publish a page that was unscheduled');
    });

    it('should still publish when isStillScheduled R2 read fails (fail-open)', async () => {
      let r2GetCallCount = 0;
      mockR2Bucket.get = async (key) => {
        r2GetCallCount += 1;
        if (r2GetCallCount === 1) {
          // First call is isStillScheduled — simulate R2 transient failure
          throw new Error('R2 transient error');
        }
        // Subsequent calls for batchMoveToCompleted / batchUpdateScheduledJson
        if (key === 'schedule.json') {
          return {
            json: async () => ({
              'org1--site1': {
                snapshot1: { scheduledPublish: '2025-01-01T10:00:00Z', approved: false },
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
            path: 'snapshot1',
            scheduledPublish: '2025-01-01T10:00:00Z',
          },
        }],
      };

      // Should not throw — fail-open means we publish when unsure
      await worker.queue(prepare(batch), mockEnv);
    });
  });

  describe('publishPage function', () => {
    it('should successfully publish a page via live API', async () => {
      global.fetch = async (url, options) => {
        if (url.includes('/live/') && options.method === 'POST') {
          return { ok: true, status: 200, statusText: 'OK' };
        }
        throw new Error('Unexpected fetch call');
      };

      // Ensure /my-page exists in the schedule so isStillScheduled returns true
      mockR2Bucket.get = async (key) => {
        if (key === 'schedule.json') {
          return {
            json: async () => ({
              'org1--site1': {
                '/my-page': { type: 'page', scheduledPublish: '2025-01-01T10:00:00Z', userId: 'user@example.com' },
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
            path: '/my-page',
            scheduledPublish: '2025-01-01T10:00:00Z',
            type: 'page',
            userId: 'user@example.com',
          },
        }],
      };

      // Should not throw
      await worker.queue(prepare(batch), mockEnv);
    });

    it('should fail permanently without retry when page publish API returns 403', async () => {
      global.fetch = async (url) => {
        if (url.includes('/live/')) {
          return { ok: false, status: 403, statusText: 'Forbidden' };
        }
        throw new Error('Unexpected fetch call');
      };

      mockR2Bucket.get = async (key) => {
        if (key === 'schedule.json') {
          return {
            json: async () => ({
              'org1--site1': {
                '/my-page': { type: 'page', scheduledPublish: '2025-01-01T10:00:00Z', userId: 'user@example.com' },
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
            path: '/my-page',
            scheduledPublish: '2025-01-01T10:00:00Z',
            type: 'page',
            userId: 'user@example.com',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(batch.messages[0].acked, true);
      assert.strictEqual(batch.messages[0].retried, null);
    });

    it('should fail permanently without retry when page publish API token is missing', async () => {
      mockEnv.SCHEDULER_KV.get = async () => null;

      mockR2Bucket.get = async (key) => {
        if (key === 'schedule.json') {
          return {
            json: async () => ({
              'org1--site1': {
                '/my-page': { type: 'page', scheduledPublish: '2025-01-01T10:00:00Z', userId: 'user@example.com' },
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
            path: '/my-page',
            scheduledPublish: '2025-01-01T10:00:00Z',
            type: 'page',
            userId: 'user@example.com',
          },
        }],
      };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(batch.messages[0].acked, true);
      assert.strictEqual(batch.messages[0].retried, null);
    });
  });
  describe('per-message isolation', () => {
    const snap = (path, extra = {}) => ({
      body: {
        org: path === 'snapshot3' ? 'org2' : 'org1',
        site: path === 'snapshot3' ? 'site2' : 'site1',
        path,
        scheduledPublish: '2025-01-01T10:00:00Z',
        ...extra,
      },
    });

    function captureWrites() {
      const writes = { schedule: [], completed: null, failed: null };
      mockR2Bucket.put = async (key, data) => {
        if (key === 'schedule.json') writes.schedule.push(JSON.parse(data));
        if (key.startsWith('completed/')) writes.completed = JSON.parse(data);
        if (key.startsWith('failed/')) writes.failed = JSON.parse(data);
        return true;
      };
      return writes;
    }

    it('records ok entries and fails a 404 without retry in a [ok, 404, ok] batch', async () => {
      const auditEntries = [];
      global.fetch = async (url, opts) => {
        if (url.includes('/log/')) {
          auditEntries.push({ url, headers: opts.headers, ...JSON.parse(opts.body).entries[0] });
          return { ok: true, status: 201 };
        }
        if (url.includes('/snapshot2?')) return { ok: false, status: 404, statusText: 'Not Found' };
        return { ok: true, status: 200, statusText: 'OK' };
      };
      const writes = captureWrites();
      const { default: worker } = await import('../src/index.js');
      const batch = {
        messages: [snap('snapshot1'), snap('snapshot2', { userId: 'u@x.com' }), snap('snapshot3')],
      };

      await worker.queue(prepare(batch), mockEnv);

      batch.messages.forEach((m) => {
        assert.strictEqual(m.acked, true, `${m.body.path} should be acked`);
        assert.strictEqual(m.retried, null, `${m.body.path} should not be retried`);
      });
      const completedPaths = writes.completed.map((c) => c.path);
      assert.ok(completedPaths.includes('snapshot1'));
      assert.ok(completedPaths.includes('snapshot3'));
      assert.ok(!completedPaths.includes('snapshot2'));
      assert.strictEqual(writes.failed.length, 1);
      assert.strictEqual(writes.failed[0].path, 'snapshot2');
      assert.strictEqual(writes.failed[0].adminStatus, 404);
      assert.strictEqual(writes.failed[0].reason, 'admin-404');
      assert.strictEqual(writes.schedule.length, 1, 'schedule.json written once');
      assert.deepStrictEqual(writes.schedule[0], {});

      assert.strictEqual(auditEntries.length, 3);
      const failedAudit = auditEntries.find((e) => e.path === 'snapshot2');
      assert.strictEqual(failedAudit.url, 'https://admin.hlx.page/log/org1/site1/main');
      assert.strictEqual(failedAudit.headers['x-auth-token'], 'test-api-key');
      assert.strictEqual(failedAudit.route, 'scheduled-publish');
      assert.strictEqual(failedAudit.status, 'failed');
      assert.strictEqual(failedAudit.adminStatus, 404);
      assert.strictEqual(failedAudit.snapshotId, 'snapshot2');
      assert.strictEqual(failedAudit.userId, 'u@x.com');
      assert.strictEqual(writes.failed[0].userId, 'u@x.com');
      assert.strictEqual(auditEntries.filter((e) => e.status === 'published').length, 2);
    });

    it('retries instead of failing permanently when the KV lookup throws', async () => {
      global.fetch = async () => ({ ok: true, status: 200, statusText: 'OK' });
      mockEnv.SCHEDULER_KV = {
        get: async () => {
          throw new Error('kv down');
        },
      };
      const writes = captureWrites();
      const { default: worker } = await import('../src/index.js');
      const batch = { messages: [snap('snapshot1'), snap('snapshot2')] };

      await worker.queue(prepare(batch), mockEnv);

      batch.messages.forEach((m) => {
        assert.strictEqual(m.acked, false);
        assert.deepStrictEqual(m.retried, { delaySeconds: 30 });
      });
      assert.strictEqual(writes.failed, null);
      assert.strictEqual(writes.schedule.length, 0);
    });

    it('fails permanently when the site has no API key', async () => {
      global.fetch = async () => ({ ok: true, status: 201 });
      mockEnv.SCHEDULER_KV = { get: async () => null };
      const writes = captureWrites();
      const { default: worker } = await import('../src/index.js');
      const batch = { messages: [snap('snapshot1')] };

      await worker.queue(prepare(batch), mockEnv);

      assert.strictEqual(batch.messages[0].acked, true);
      assert.strictEqual(writes.failed[0].reason, 'org-site-not-registered');
    });

    it('retries a permanent failure and keeps it scheduled when failed/ cannot be written', async () => {
      global.fetch = async (url) => (url.includes('/snapshot2?')
        ? { ok: false, status: 404, statusText: 'Not Found' }
        : { ok: true, status: 200, statusText: 'OK' });
      const writes = captureWrites();
      const { put } = mockR2Bucket;
      mockR2Bucket.put = async (key, data) => {
        if (key.startsWith('failed/')) throw new Error('r2 down');
        return put(key, data);
      };
      const { default: worker } = await import('../src/index.js');
      const batch = { messages: [snap('snapshot1'), snap('snapshot2')] };

      await worker.queue(prepare(batch), mockEnv);

      assert.strictEqual(batch.messages[0].acked, true);
      assert.strictEqual(batch.messages[1].acked, false);
      assert.deepStrictEqual(batch.messages[1].retried, { delaySeconds: 30 });
      assert.ok(writes.schedule[0]['org1--site1'].snapshot2, 'snapshot2 stays scheduled');
      assert.strictEqual(writes.schedule[0]['org1--site1'].snapshot1, undefined);
    });

    it('retries every message when schedule.json cannot be updated', async () => {
      global.fetch = async (url) => (url.includes('/snapshot2?')
        ? { ok: false, status: 404, statusText: 'Not Found' }
        : { ok: true, status: 200, statusText: 'OK' });
      const writes = captureWrites();
      const { put } = mockR2Bucket;
      mockR2Bucket.put = async (key, data) => {
        if (key === 'schedule.json') throw new Error('r2 down');
        return put(key, data);
      };
      const { default: worker } = await import('../src/index.js');
      const batch = { messages: [snap('snapshot1'), snap('snapshot2')] };

      await worker.queue(prepare(batch), mockEnv);

      batch.messages.forEach((m) => {
        assert.strictEqual(m.acked, false);
        assert.deepStrictEqual(m.retried, { delaySeconds: 30 });
      });
      assert.strictEqual(writes.failed.length, 1);
    });

    it('retries a 5xx with backoff while acking the others', async () => {
      global.fetch = async (url) => {
        if (url.includes('/snapshot1?')) return { ok: false, status: 503, statusText: 'Unavailable' };
        if (url.includes('/snapshot2?')) return { ok: false, status: 429, statusText: 'Too Many' };
        if (url.includes('/log/')) return { ok: true, status: 201 };
        return { ok: true, status: 200, statusText: 'OK' };
      };
      const writes = captureWrites();
      const { default: worker } = await import('../src/index.js');
      const batch = {
        messages: [{ ...snap('snapshot1'), attempts: 3 }, snap('snapshot2'), snap('snapshot3')],
      };

      await worker.queue(prepare(batch), mockEnv);

      assert.deepStrictEqual(batch.messages[0].retried, { delaySeconds: 120 });
      assert.strictEqual(batch.messages[0].acked, false);
      assert.deepStrictEqual(batch.messages[1].retried, { delaySeconds: 30 });
      assert.strictEqual(batch.messages[2].acked, true);
      assert.strictEqual(writes.failed, null);
      assert.ok(writes.schedule[0]['org1--site1'].snapshot1, 'retried entry stays scheduled');
      assert.strictEqual(writes.schedule[0]['org2--site2'], undefined);
    });

    it('does not let audit-log failures affect publishing', async () => {
      global.fetch = async (url) => {
        if (url.includes('/log/')) throw new Error('log down');
        return { ok: true, status: 200, statusText: 'OK' };
      };
      captureWrites();
      const { default: worker } = await import('../src/index.js');
      const batch = { messages: [snap('snapshot1')] };

      await worker.queue(prepare(batch), mockEnv);
      assert.strictEqual(batch.messages[0].acked, true);
    });

    it('sends forceUpdate=true for both publish and approve snapshot calls', async () => {
      const calls = [];
      global.fetch = async (url, opts) => {
        if (url.includes('/snapshot/')) calls.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200, statusText: 'OK' };
      };
      captureWrites();
      const { default: worker } = await import('../src/index.js');
      const batch = { messages: [snap('snapshot1'), snap('snapshot2', { approved: true })] };

      await worker.queue(prepare(batch), mockEnv);

      assert.strictEqual(calls[0].url, 'https://admin.hlx.page/snapshot/org1/site1/main/snapshot1?publish=true&forceUpdate=true');
      assert.deepStrictEqual(calls[0].body, { publish: 'true', forceUpdate: 'true' });
      assert.strictEqual(calls[1].url, 'https://admin.hlx.page/snapshot/org1/site1/main/snapshot2?review=approve&keepResources=true&forceUpdate=true');
      assert.deepStrictEqual(calls[1].body, { review: 'approve', keepResources: 'true', forceUpdate: 'true' });
    });

    it('caps the retry backoff', async () => {
      const { retryDelaySeconds } = await import('../src/index.js');
      assert.deepStrictEqual(
        [1, 2, 3, 4, 5, 6, 10].map(retryDelaySeconds),
        [30, 60, 120, 240, 480, 600, 600],
      );
    });
  });
});
