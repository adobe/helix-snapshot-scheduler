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
};

// Mock fetch for authorization
global.fetch = async (url) => {
  if (url.includes('admin.hlx.page')) {
    return { ok: true };
  }
  return { ok: false };
};

describe('Schedule API Tests', () => {
  it('should update schedule successfully', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot2',
        scheduledPublish: '2025-01-02T15:30:00Z',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    const responseData = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(responseData.success, true);
    assert.strictEqual(responseData.snapshotId, 'snapshot2');
    assert.strictEqual(responseData.scheduledPublish, '2025-01-02T15:30:00Z');
  });

  it('should return 400 for missing required fields', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        // missing snapshotId and scheduledPublish
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    assert.strictEqual(response.status, 400);
  });

  it('should return 401 for missing authorization', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
        scheduledPublish: '2025-01-01T10:00:00Z',
      }),
      headers: {
        get: () => null, // no authorization header
      },
    };

    const response = await updateSchedule(request, mockEnv);
    assert.strictEqual(response.status, 401);
  });

  it('should return 404 for unregistered org/site', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'unregistered',
        site: 'site',
        snapshotId: 'snapshot1',
        scheduledPublish: '2025-01-01T10:00:00Z',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    assert.strictEqual(response.status, 404);
  });

  it('should return 400 for invalid date format', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
        scheduledPublish: 'invalid-date',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    assert.strictEqual(response.status, 400);
  });

  it('should return 400 for null request body', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const request = {
      json: async () => null,
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnv);
    assert.strictEqual(response.status, 400);
  });

  it('should handle R2 read errors gracefully', async () => {
    const { updateSchedule } = await import('../src/index.js');

    const mockEnvWithError = {
      R2_BUCKET: {
        get: async (key) => {
          if (key === 'registered/org1--site1.json') {
            return { json: async () => ({ org: 'org1', site: 'site1' }) };
          }
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
    };

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
        snapshotId: 'snapshot1',
        scheduledPublish: '2025-01-01T10:00:00Z',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await updateSchedule(request, mockEnvWithError);
    const responseData = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(responseData.success, true);
  });
});

describe('Register API Tests', () => {
  it('should register org/site successfully', async () => {
    const { registerRequest } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org2',
        site: 'site2',
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
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
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
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
        // missing site
      }),
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await registerRequest(request, mockEnv);
    assert.strictEqual(response.status, 400);
  });

  it('should return 401 for missing authorization in register', async () => {
    const { registerRequest } = await import('../src/index.js');

    const request = {
      json: async () => ({
        org: 'org1',
        site: 'site1',
      }),
      headers: {
        get: () => null,
      },
    };

    const response = await registerRequest(request, mockEnv);
    assert.strictEqual(response.status, 401);
  });

  it('should return 400 for null request body in register', async () => {
    const { registerRequest } = await import('../src/index.js');

    const request = {
      json: async () => null,
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
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
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
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
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
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
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await isRegistered(request, mockEnv);
    const responseData = await response.json();

    assert.strictEqual(response.status, 400);
    assert.strictEqual(responseData.registered, 'error');
  });

  it('should return 401 for missing authorization in isRegistered', async () => {
    const { isRegistered } = await import('../src/index.js');

    const request = {
      params: { org: 'org1', site: 'site1' },
      headers: {
        get: () => null,
      },
    };

    const response = await isRegistered(request, mockEnv);
    assert.strictEqual(response.status, 401);
  });
});

describe('GetSchedule API Tests', () => {
  it('should return schedule data for specific org/site', async () => {
    const { getSchedule } = await import('../src/index.js');

    const request = {
      params: { org: 'org1', site: 'site1' },
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await getSchedule(request, mockEnv);
    const responseData = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(responseData['org1--site1'].snapshot1, '2025-01-01T10:00:00Z');
  });

  it('should return empty object for org/site with no schedule', async () => {
    const { getSchedule } = await import('../src/index.js');

    const request = {
      params: { org: 'org2', site: 'site2' },
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await getSchedule(request, mockEnv);
    const responseData = await response.json();

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(responseData['org2--site2'], {});
  });

  it('should return 400 for missing org/site params in getSchedule', async () => {
    const { getSchedule } = await import('../src/index.js');

    const request = {
      params: { org: 'org1' }, // missing site
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await getSchedule(request, mockEnv);
    assert.strictEqual(response.status, 400);
  });

  it('should return 401 for missing authorization in getSchedule', async () => {
    const { getSchedule } = await import('../src/index.js');

    const request = {
      params: { org: 'org1', site: 'site1' },
      headers: {
        get: () => null,
      },
    };

    const response = await getSchedule(request, mockEnv);
    assert.strictEqual(response.status, 401);
  });

  it('should handle R2 read errors in getSchedule', async () => {
    const { getSchedule } = await import('../src/index.js');

    const mockEnvWithError = {
      R2_BUCKET: {
        get: async (key) => {
          if (key === 'schedule.json') {
            throw new Error('R2 read error');
          }
          return null;
        },
      },
    };

    const request = {
      params: { org: 'org1', site: 'site1' },
      headers: {
        get: (name) => (name === 'Authorization' ? 'Bearer test-token' : null),
      },
    };

    const response = await getSchedule(request, mockEnvWithError);
    assert.strictEqual(response.status, 500);
  });
});

describe('Authorization Tests', () => {
  it('should return true for valid admin authorization', async () => {
    const { isAuthorized } = await import('../src/index.js');

    const result = await isAuthorized('Bearer test-token', 'org1', 'site1', true);
    assert.strictEqual(result, true);
  });

  it('should return true for valid non-admin authorization', async () => {
    const { isAuthorized } = await import('../src/index.js');

    const result = await isAuthorized('Bearer test-token', 'org1', 'site1', false);
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

    const result = await isAuthorized('Bearer invalid-token', 'org1', 'site1', true);
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

    const result = await isAuthorized('Bearer invalid-token', 'org1', 'site1', false);
    assert.strictEqual(result, false);

    // Restore original fetch
    global.fetch = originalFetch;
  });
});
