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

describe('Cron Service Tests', () => {
  let mockEnv;
  let mockPublishQueue;
  let queuedMessages;

  beforeEach(() => {
    // Reset console mocks
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};

    // Reset queued messages
    queuedMessages = [];

    // Mock publish queue
    mockPublishQueue = {
      send: async (message, options) => {
        queuedMessages.push({ message, options });
        return true;
      },
    };

    // Mock environment
    mockEnv = {
      R2_BUCKET: {
        get: async (key) => {
          if (key === 'schedule.json') {
            return {
              json: async () => ({
                'org1--site1': {
                  snapshot1: '2025-01-01T09:56:00Z',
                  snapshot2: '2025-01-01T09:58:00Z',
                  snapshot3: '2025-01-01T10:00:00Z',
                },
              }),
            };
          }
          return null;
        },
      },
      PUBLISH_QUEUE: mockPublishQueue,
    };
  });

  afterEach(() => {
    // Restore console methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  describe('getScheduledSnapshots', () => {
    it('should return empty array when no schedule data exists', async () => {
      mockEnv.R2_BUCKET.get = async () => null;

      const { default: worker } = await import('../src/index.js');
      const result = await worker.scheduled({}, mockEnv);

      assert.strictEqual(result, true);
      assert.strictEqual(queuedMessages.length, 0);
    });

    it('should return empty array when schedule data is empty', async () => {
      mockEnv.R2_BUCKET.get = async () => ({
        json: async () => ({}),
      });

      const { default: worker } = await import('../src/index.js');
      const result = await worker.scheduled({}, mockEnv);

      assert.strictEqual(result, true);
      assert.strictEqual(queuedMessages.length, 0);
    });

    it('should handle invalid org-site keys gracefully', async () => {
      mockEnv.R2_BUCKET.get = async () => ({
        json: async () => ({
          'invalid-key': {
            snapshot1: '2025-01-01T10:00:00Z',
          },
        }),
      });

      const { default: worker } = await import('../src/index.js');
      const result = await worker.scheduled({}, mockEnv);

      assert.strictEqual(result, true);
      assert.strictEqual(queuedMessages.length, 0);
    });

    it('should handle invalid scheduled publish dates gracefully', async () => {
      mockEnv.R2_BUCKET.get = async () => ({
        json: async () => ({
          'org1--site1': {
            snapshot1: 'invalid-date',
            snapshot2: '2025-01-01T10:00:00Z',
          },
        }),
      });

      // Mock current time to be 5 minutes before the valid snapshot
      const originalDateNow = Date.now;
      Date.now = () => new Date('2025-01-01T09:55:00Z').getTime();

      try {
        const { default: worker } = await import('../src/index.js');
        const result = await worker.scheduled({}, mockEnv);

        assert.strictEqual(result, true);
        assert.strictEqual(queuedMessages.length, 1);
        assert.strictEqual(queuedMessages[0].message.snapshotId, 'snapshot2');
      } finally {
        Date.now = originalDateNow;
      }
    });
  });

  describe('scheduled function', () => {
    it('should queue snapshots due for publishing in the next 5 minutes', async () => {
      // Mock current time to be 5 minutes before the scheduled time
      const originalDateNow = Date.now;
      Date.now = () => new Date('2025-01-01T09:55:00Z').getTime();

      try {
        const { default: worker } = await import('../src/index.js');
        const result = await worker.scheduled({}, mockEnv);

        assert.strictEqual(result, true);
        assert.strictEqual(queuedMessages.length, 3);

        // Check that all snapshots were queued with correct delays
        const snapshot1 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot1');
        const snapshot2 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot2');
        const snapshot3 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot3');

        assert(snapshot1, 'snapshot1 should be queued');
        assert(snapshot2, 'snapshot2 should be queued');
        assert(snapshot3, 'snapshot3 should be queued');

        // Check delay calculations (5 minutes = 300 seconds)
        assert.strictEqual(snapshot1.options.delaySeconds, 60); // 1 minute
        assert.strictEqual(snapshot2.options.delaySeconds, 180); // 3 minutes
        assert.strictEqual(snapshot3.options.delaySeconds, 300); // 5 minutes

        // Check message structure
        assert.strictEqual(snapshot1.message.org, 'org1');
        assert.strictEqual(snapshot1.message.site, 'site1');
        assert.strictEqual(snapshot1.message.snapshotId, 'snapshot1');
        assert.strictEqual(snapshot1.message.scheduledPublish, '2025-01-01T09:56:00Z');
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should not queue snapshots that are not due in the next 5 minutes', async () => {
      // Mock current time to be 10 minutes before the scheduled time
      const originalDateNow = Date.now;
      Date.now = () => new Date('2025-01-01T09:50:00Z').getTime();

      try {
        const { default: worker } = await import('../src/index.js');
        const result = await worker.scheduled({}, mockEnv);

        assert.strictEqual(result, true);
        assert.strictEqual(queuedMessages.length, 0);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should queue past-due snapshots immediately with zero delay', async () => {
      // Mock current time to be after all scheduled times (10:10 > 10:00, 9:58, 9:56)
      const originalDateNow = Date.now;
      Date.now = () => new Date('2025-01-01T10:10:00Z').getTime();

      try {
        const { default: worker } = await import('../src/index.js');
        const result = await worker.scheduled({}, mockEnv);

        assert.strictEqual(result, true);
        // All 3 snapshots should be queued since they're all past due
        assert.strictEqual(queuedMessages.length, 3);

        // Verify all snapshots have delaySeconds: 0 (immediate execution)
        const snapshot1 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot1');
        const snapshot2 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot2');
        const snapshot3 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot3');

        assert(snapshot1, 'snapshot1 should be queued');
        assert(snapshot2, 'snapshot2 should be queued');
        assert(snapshot3, 'snapshot3 should be queued');

        assert.strictEqual(snapshot1.options.delaySeconds, 0);
        assert.strictEqual(snapshot2.options.delaySeconds, 0);
        assert.strictEqual(snapshot3.options.delaySeconds, 0);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should handle queue send failures gracefully', async () => {
      // Mock current time to be 5 minutes before the scheduled time
      const originalDateNow = Date.now;
      Date.now = () => new Date('2025-01-01T09:55:00Z').getTime();

      // Mock queue to throw error for first message
      let callCount = 0;
      mockPublishQueue.send = async (message, options) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('Queue send failed');
        }
        queuedMessages.push({ message, options });
        return true;
      };

      try {
        const { default: worker } = await import('../src/index.js');
        const result = await worker.scheduled({}, mockEnv);

        assert.strictEqual(result, true);
        // Should still queue the remaining snapshots
        assert.strictEqual(queuedMessages.length, 2);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should handle R2 bucket errors gracefully', async () => {
      mockEnv.R2_BUCKET.get = async () => {
        throw new Error('R2 bucket error');
      };

      const { default: worker } = await import('../src/index.js');
      const result = await worker.scheduled({}, mockEnv);

      assert.strictEqual(result, false);
      assert.strictEqual(queuedMessages.length, 0);
    });

    it('should handle JSON parsing errors gracefully', async () => {
      mockEnv.R2_BUCKET.get = async () => ({
        json: async () => {
          throw new Error('JSON parsing error');
        },
      });

      const { default: worker } = await import('../src/index.js');
      const result = await worker.scheduled({}, mockEnv);

      assert.strictEqual(result, false);
      assert.strictEqual(queuedMessages.length, 0);
    });
  });

  describe('edge cases', () => {
    it('should handle snapshots scheduled exactly at the current time', async () => {
      const originalDateNow = Date.now;
      Date.now = () => new Date('2025-01-01T10:00:00Z').getTime();

      try {
        const { default: worker } = await import('../src/index.js');
        const result = await worker.scheduled({}, mockEnv);

        assert.strictEqual(result, true);
        // All 3 snapshots should be queued (snapshot1 and snapshot2 are past due, snapshot3 is now)
        assert.strictEqual(queuedMessages.length, 3);

        // Find all snapshots
        const snapshot1 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot1');
        const snapshot2 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot2');
        const snapshot3 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot3');

        assert(snapshot1, 'snapshot1 should be queued');
        assert(snapshot2, 'snapshot2 should be queued');
        assert(snapshot3, 'snapshot3 should be queued');

        // All should have delaySeconds: 0 since they're all at or before current time
        assert.strictEqual(snapshot1.options.delaySeconds, 0);
        assert.strictEqual(snapshot2.options.delaySeconds, 0);
        assert.strictEqual(snapshot3.options.delaySeconds, 0);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should handle snapshots scheduled exactly at the 5-minute boundary', async () => {
      const originalDateNow = Date.now;
      Date.now = () => new Date('2025-01-01T09:55:00Z').getTime();

      try {
        const { default: worker } = await import('../src/index.js');
        const result = await worker.scheduled({}, mockEnv);

        assert.strictEqual(result, true);
        assert.strictEqual(queuedMessages.length, 3);

        // Check delays: 5 minutes = 300 seconds
        const snapshot1 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot1');
        const snapshot2 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot2');
        const snapshot3 = queuedMessages.find((m) => m.message.snapshotId === 'snapshot3');

        assert.strictEqual(snapshot1.options.delaySeconds, 60); // 1 minute
        assert.strictEqual(snapshot2.options.delaySeconds, 180); // 3 minutes
        assert.strictEqual(snapshot3.options.delaySeconds, 300); // 5 minutes
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should handle empty snapshot objects', async () => {
      mockEnv.R2_BUCKET.get = async () => ({
        json: async () => ({
          'org1--site1': {},
          'org2--site2': {
            snapshot1: '2025-01-01T10:00:00Z',
          },
        }),
      });

      const originalDateNow = Date.now;
      Date.now = () => new Date('2025-01-01T09:55:00Z').getTime();

      try {
        const { default: worker } = await import('../src/index.js');
        const result = await worker.scheduled({}, mockEnv);

        assert.strictEqual(result, true);
        assert.strictEqual(queuedMessages.length, 1);
        assert.strictEqual(queuedMessages[0].message.snapshotId, 'snapshot1');
      } finally {
        Date.now = originalDateNow;
      }
    });
  });
});
