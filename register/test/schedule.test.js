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

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Mock environment for testing
const mockEnv = {
  R2_BUCKET: {
    get: async (key) => {
      if (key === 'registered/org1--site1.json') {
        return { json: async () => ({ org: 'org1', site: 'site1' }) };
      }
      if (key === 'schedule.json') {
        return { json: async () => ({ 'org1--site1': { snapshot1: '2025-01-01T10:00:00Z' } }) };
      }
      return null;
    },
    put: async (key, value) => {
      console.log(`Mock R2 put: ${key} = ${value}`);
      return true;
    },
  },
  SCHEDULER_KV: {
    get: async (key) => {
      if (key === 'org1--site1--apiKey') {
        return 'test-api-key';
      }
      return null;
    },
    put: async (key, value) => {
      console.log(`Mock KV put: ${key} = ${value}`);
      return true;
    },
  },
};

// Mock fetch for authorization and snapshot manifest
global.fetch = async (url) => {
  if (url.includes('admin.hlx.page/config')) {
    return { ok: true };
  }
  if (url.includes('admin.hlx.page/snapshot') && url.includes('/snapshot1')) {
    return {
      ok: true,
      json: async () => ({
        manifest: {
          metadata: {
            scheduledPublish: '2025-01-02T15:30:00Z',
          },
        },
      }),
    };
  }
  if (url.includes('admin.hlx.page/snapshot') && url.includes('/invalid-snapshot')) {
    return {
      ok: true,
      json: async () => ({
        manifest: {
          metadata: {
            scheduledPublish: 'invalid-date',
          },
        },
      }),
    };
  }
  if (url.includes('admin.hlx.page/snapshot') && url.includes('/main') && url.endsWith('/main')) {
    // This is the snapshot list API call for non-admin authorization
    return { ok: true };
  }
  return { ok: false };
};

describe('Schedule API Tests', () => {
  it('should update schedule successfully', async () => {
    const { updateSchedule } = await import('../src/index.js');

    // Create a valid future date (10 minutes from now)
    const validFutureDate = new Date(Date.now() + 10 * 60 * 1000);

    // Mock fetch to return a valid future date
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('admin.hlx.page/config')) {
        return { ok: true };
      }
      if (url.includes('admin.hlx.page/snapshot')) {
        return {
          ok: true,
          json: async () => ({
            manifest: {
              metadata: {
                scheduledPublish: validFutureDate.toISOString(),
              },
            },
          }),
        };
      }
      return { ok: false };
    };

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    const responseData = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(responseData.success, true);
    assert.strictEqual(responseData.snapshotId, 'snapshot1');

    // Restore original fetch
    global.fetch = originalFetch;
  });

  it('should return 400 for missing required fields', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        // missing snapshotId
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    assert.strictEqual(response.status, 400);
  });

  it('should return 404 for unregistered org/site (no API token)', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'unregistered',
        site: 'site',
        snapshotId: 'snapshot1',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    assert.strictEqual(response.status, 404); // Returns 404 when no API key found in KV
  });

  it('should return 400 for null request body', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const request = {
      json: async () => null,
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    assert.strictEqual(response.status, 400);
  });

  it('should handle R2 read errors gracefully', async () => {
    const { updateSchedule } = await import('../src/index.js');

    // Create a valid future date (10 minutes from now)
    const validFutureDate = new Date(Date.now() + 10 * 60 * 1000);

    // Mock fetch to return a valid future date
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('admin.hlx.page/config')) {
        return { ok: true };
      }
      if (url.includes('admin.hlx.page/snapshot')) {
        return {
          ok: true,
          json: async () => ({
            manifest: {
              metadata: {
                scheduledPublish: validFutureDate.toISOString(),
              },
            },
          }),
        };
      }
      return { ok: false };
    };

    const mockEnvWithError = {
      R2_BUCKET: {
        get: async (key) => {
          if (key === 'schedule.json') {
            throw new Error('R2 read error');
          }
          return null;
        },
        put: async (key, value) => {
          console.log(`Mock R2 put: ${key} = ${value}`);
          return true;
        },
      },
      SCHEDULER_KV: {
        get: async (key) => {
          if (key === 'org1--site1--apiKey') {
            return 'test-api-key';
          }
          return null;
        },
        put: async (key, value) => {
          console.log(`Mock KV put: ${key} = ${value}`);
          return true;
        },
      },
    };

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnvWithError);
    const responseData = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(responseData.success, true);

    // Restore original fetch
    global.fetch = originalFetch;
  });
});

describe('Register API Tests', () => {
  it('should register org/site successfully', async () => {
    const { registerRequest } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org2',
        site: 'site2',
        apiKey: 'test-api-key',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await registerRequest(request, mockEnv);
    assert.strictEqual(response.status, 200);
  });

  it('should return 200 for already registered org/site', async () => {
    const { registerRequest } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        apiKey: 'test-api-key',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await registerRequest(request, mockEnv);
    assert.strictEqual(response.status, 200);
  });

  it('should return 400 for missing org/site', async () => {
    const { registerRequest } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org1',
        // missing site and apiKey
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await registerRequest(request, mockEnv);
    assert.strictEqual(response.status, 400);
  });

  it('should return 400 for missing authorization in register', async () => {
    const { registerRequest } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        // missing apiKey
      }),
      headers: {
        get: () => null,
      },
    };

    const response = await registerRequest(request, mockEnv);
    assert.strictEqual(response.status, 400); // Returns 400 for missing apiKey first
  });

  it('should return 400 for null request body in register', async () => {
    const { registerRequest } = await import('../src/index.js');

    const request = {
      json: async () => null,
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await registerRequest(request, mockEnv);
    assert.strictEqual(response.status, 400);
  });
});

describe('IsRegistered API Tests', () => {
  it('should return true for registered org/site', async () => {
    const { isRegistered } = await import('../src/index.js');

    const request = {
      params: { org: 'org1', site: 'site1' },
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await isRegistered(request, mockEnv);
    const responseData = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(responseData.registered, true);
  });

  it('should return false for unregistered org/site', async () => {
    const { isRegistered } = await import('../src/index.js');

    const request = {
      params: { org: 'unregistered', site: 'site' },
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await isRegistered(request, mockEnv);
    const responseData = await response.json();

    assert.strictEqual(response.status, 404);
    assert.strictEqual(responseData.registered, false);
  });

  it('should return 400 for missing org/site params', async () => {
    const { isRegistered } = await import('../src/index.js');

    const request = {
      params: { org: 'org1' }, // missing site
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await isRegistered(request, mockEnv);
    const errorHeader = response.headers.get('X-Error');

    assert.strictEqual(response.status, 400);
    assert.strictEqual(errorHeader, 'Invalid org or site');
  });
});

// GetSchedule API Tests removed - function is commented out in implementation

describe('Schedule Time Validation Tests', () => {
  it('should return 400 for scheduled publish less than 5 minutes in the future', async () => {
    const { updateSchedule } = await import('../src/index.js');

    // Create a date that's only 3 minutes in the future
    const futureDate = new Date(Date.now() + 3 * 60 * 1000);

    // Mock fetch to return this near-future date
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('admin.hlx.page/config')) {
        return { ok: true };
      }
      if (url.includes('admin.hlx.page/snapshot')) {
        return {
          ok: true,
          json: async () => ({
            manifest: {
              metadata: {
                scheduledPublish: futureDate.toISOString(),
              },
            },
          }),
        };
      }
      return { ok: false };
    };

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    const errorHeader = response.headers.get('X-Error');

    assert.strictEqual(response.status, 400);
    assert.strictEqual(errorHeader, 'Scheduled publish must be at least 5 minutes in the future');

    // Restore original fetch
    global.fetch = originalFetch;
  });

  it('should return 400 for scheduled publish exactly in the past', async () => {
    const { updateSchedule } = await import('../src/index.js');

    // Create a date that's 1 minute in the past
    const pastDate = new Date(Date.now() - 1 * 60 * 1000);

    // Mock fetch to return this past date
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('admin.hlx.page/config')) {
        return { ok: true };
      }
      if (url.includes('admin.hlx.page/snapshot')) {
        return {
          ok: true,
          json: async () => ({
            manifest: {
              metadata: {
                scheduledPublish: pastDate.toISOString(),
              },
            },
          }),
        };
      }
      return { ok: false };
    };

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    const errorHeader = response.headers.get('X-Error');

    assert.strictEqual(response.status, 400);
    assert.strictEqual(errorHeader, 'Scheduled publish is in the past');

    // Restore original fetch
    global.fetch = originalFetch;
  });

  it('should succeed for scheduled publish exactly 5 minutes in the future', async () => {
    const { updateSchedule } = await import('../src/index.js');

    // Create a date slightly more than 5 minutes in the future to avoid edge case timing issues
    const validDate = new Date(Date.now() + (5 * 60 * 1000) + 1000); // 5 minutes + 1 second

    // Mock fetch to return this valid date
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('admin.hlx.page/config')) {
        return { ok: true };
      }
      if (url.includes('admin.hlx.page/snapshot')) {
        return {
          ok: true,
          json: async () => ({
            manifest: {
              metadata: {
                scheduledPublish: validDate.toISOString(),
              },
            },
          }),
        };
      }
      return { ok: false };
    };

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    const responseData = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(responseData.success, true);

    // Restore original fetch
    global.fetch = originalFetch;
  });

  it('should succeed for scheduled publish well in the future', async () => {
    const { updateSchedule } = await import('../src/index.js');

    // Create a date that's 30 minutes in the future
    const validDate = new Date(Date.now() + 30 * 60 * 1000);

    // Mock fetch to return this valid date
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('admin.hlx.page/config')) {
        return { ok: true };
      }
      if (url.includes('admin.hlx.page/snapshot')) {
        return {
          ok: true,
          json: async () => ({
            manifest: {
              metadata: {
                scheduledPublish: validDate.toISOString(),
              },
            },
          }),
        };
      }
      return { ok: false };
    };

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    const responseData = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(responseData.success, true);

    // Restore original fetch
    global.fetch = originalFetch;
  });

  it('should return 400 for scheduled publish exactly 4 minutes 59 seconds in the future', async () => {
    const { updateSchedule } = await import('../src/index.js');

    // Create a date that's just under 5 minutes in the future (4:59)
    const almostValidDate = new Date(Date.now() + (4 * 60 + 59) * 1000);

    // Mock fetch to return this almost-valid date
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('admin.hlx.page/config')) {
        return { ok: true };
      }
      if (url.includes('admin.hlx.page/snapshot')) {
        return {
          ok: true,
          json: async () => ({
            manifest: {
              metadata: {
                scheduledPublish: almostValidDate.toISOString(),
              },
            },
          }),
        };
      }
      return { ok: false };
    };

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'token test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    const errorHeader = response.headers.get('X-Error');

    assert.strictEqual(response.status, 400);
    assert.strictEqual(errorHeader, 'Scheduled publish must be at least 5 minutes in the future');

    // Restore original fetch
    global.fetch = originalFetch;
  });
});

describe('Authorization Tests', () => {
  it('should return true for valid admin authorization', async () => {
    const { isAuthorized } = await import('../src/index.js');

    const result = await isAuthorized('token test-token', 'org1', 'site1', true);
    assert.strictEqual(result, true);
  });

  it('should return true for valid non-admin authorization', async () => {
    const { isAuthorized } = await import('../src/index.js');

    const result = await isAuthorized('token test-token', 'org1', 'site1', false);
    assert.strictEqual(result, true);
  });

  it('should return false for invalid admin authorization', async () => {
    const { isAuthorized } = await import('../src/index.js');

    // Mock fetch to return error for admin API
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('admin.hlx.page/config')) {
        return { ok: false };
      }
      return { ok: true };
    };

    const result = await isAuthorized('token invalid-token', 'org1', 'site1', true);
    assert.strictEqual(result, false);

    // Restore original fetch
    global.fetch = originalFetch;
  });

  it('should return false for invalid snapshot list authorization', async () => {
    const { isAuthorized } = await import('../src/index.js');

    // Mock fetch to return error for snapshot API
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('admin.hlx.page/snapshot')) {
        return { ok: false };
      }
      return { ok: true };
    };

    const result = await isAuthorized('token invalid-token', 'org1', 'site1', false);
    assert.strictEqual(result, false);

    // Restore original fetch
    global.fetch = originalFetch;
  });
});
