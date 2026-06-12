/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import {
  describe, it, beforeEach, afterEach,
} from 'node:test';
import assert from 'node:assert';
import { verifyScheduleIntent, postActionAuditLog } from '../src/intent.js';

const originalFetch = global.fetch;

function makeEnv({ apiKey = 'test-api-key', kv = {} } = {}) {
  return {
    SCHEDULER_KV: {
      get: async (k) => (k in kv ? kv[k] : null),
      // eslint-disable-next-line no-param-reassign
      put: async (k, v) => { kv[k] = v; },
    },
    kv,
    apiKey,
  };
}

function mockAdminLog(entries) {
  global.fetch = async (url, opts = {}) => {
    if (url.startsWith('https://admin.hlx.page/log/')) {
      assert.equal(opts.headers?.['x-auth-token'], 'test-api-key');
      return {
        ok: true,
        status: 200,
        json: async () => ({ entries }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

describe('verifyScheduleIntent', () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns ok with server-stamped user when matching entry exists', async () => {
    mockAdminLog([{
      route: 'schedule-page-intent',
      nonce: 'n1',
      path: '/foo',
      scheduledPublish: '2026-06-12T10:30:00Z',
      user: 'amol@adobe.com',
      timestamp: Date.now(),
    }]);

    const env = makeEnv();
    const result = await verifyScheduleIntent({
      env,
      org: 'o',
      site: 's',
      apiKey: env.apiKey,
      nonce: 'n1',
      route: 'schedule-page-intent',
      expected: { path: '/foo', scheduledPublish: '2026-06-12T10:30:00Z' },
      window: 5 * 60 * 1000,
      singleUse: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.user, 'amol@adobe.com');
  });

  it('returns 401 schedule intent not found when nonce missing from log', async () => {
    mockAdminLog([]);
    const env = makeEnv();
    const result = await verifyScheduleIntent({
      env,
      org: 'o',
      site: 's',
      apiKey: env.apiKey,
      nonce: 'n-missing',
      route: 'schedule-page-intent',
      expected: { path: '/foo' },
      window: 5 * 60 * 1000,
      singleUse: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.error, /schedule intent not found/);
  });

  it('returns 401 schedule intent has expired when entry timestamp is outside window', async () => {
    mockAdminLog([{
      route: 'schedule-page-intent',
      nonce: 'n-stale',
      path: '/foo',
      user: 'a@b.com',
      timestamp: Date.now() - 10 * 60 * 1000,
    }]);
    const env = makeEnv();
    const result = await verifyScheduleIntent({
      env,
      org: 'o',
      site: 's',
      apiKey: env.apiKey,
      nonce: 'n-stale',
      route: 'schedule-page-intent',
      expected: { path: '/foo' },
      window: 5 * 60 * 1000,
      singleUse: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.error, /expired/);
  });

  it('returns 401 mismatch when expected.path differs from entry.path', async () => {
    mockAdminLog([{
      route: 'schedule-page-intent',
      nonce: 'n-mm',
      path: '/foo',
      scheduledPublish: '2026-06-12T10:30:00Z',
      user: 'a@b.com',
      timestamp: Date.now(),
    }]);
    const env = makeEnv();
    const result = await verifyScheduleIntent({
      env,
      org: 'o',
      site: 's',
      apiKey: env.apiKey,
      nonce: 'n-mm',
      route: 'schedule-page-intent',
      expected: { path: '/bar', scheduledPublish: '2026-06-12T10:30:00Z' },
      window: 5 * 60 * 1000,
      singleUse: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.error, /does not match/);
  });

  it('passes when expected is empty (view-intent case)', async () => {
    mockAdminLog([{
      route: 'view-schedule-intent',
      nonce: 'n-view',
      user: 'a@b.com',
      timestamp: Date.now(),
    }]);
    const env = makeEnv();
    const result = await verifyScheduleIntent({
      env,
      org: 'o',
      site: 's',
      apiKey: env.apiKey,
      nonce: 'n-view',
      route: 'view-schedule-intent',
      expected: {},
      window: 30 * 60 * 1000,
      singleUse: false,
    });
    assert.equal(result.ok, true);
  });

  it('reserves nonce in KV after successful single-use verify', async () => {
    mockAdminLog([{
      route: 'schedule-page-intent',
      nonce: 'n-once',
      path: '/foo',
      user: 'a@b.com',
      timestamp: Date.now(),
    }]);
    const env = makeEnv();
    const result = await verifyScheduleIntent({
      env,
      org: 'o',
      site: 's',
      apiKey: env.apiKey,
      nonce: 'n-once',
      route: 'schedule-page-intent',
      expected: { path: '/foo' },
      window: 5 * 60 * 1000,
      singleUse: true,
    });
    assert.equal(result.ok, true);
    assert.equal(env.kv['nonce--n-once'], '1');
  });

  it('rejects replay of a previously used single-use nonce', async () => {
    mockAdminLog([{
      route: 'schedule-page-intent',
      nonce: 'n-replay',
      path: '/foo',
      user: 'a@b.com',
      timestamp: Date.now(),
    }]);
    const env = makeEnv({ kv: { 'nonce--n-replay': '1' } });
    const result = await verifyScheduleIntent({
      env,
      org: 'o',
      site: 's',
      apiKey: env.apiKey,
      nonce: 'n-replay',
      route: 'schedule-page-intent',
      expected: { path: '/foo' },
      window: 5 * 60 * 1000,
      singleUse: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.error, /already used/);
  });

  it('does not reserve nonce when singleUse is false (view-intent)', async () => {
    mockAdminLog([{
      route: 'view-schedule-intent',
      nonce: 'n-reusable',
      user: 'a@b.com',
      timestamp: Date.now(),
    }]);
    const env = makeEnv();
    const result = await verifyScheduleIntent({
      env,
      org: 'o',
      site: 's',
      apiKey: env.apiKey,
      nonce: 'n-reusable',
      route: 'view-schedule-intent',
      expected: {},
      window: 30 * 60 * 1000,
      singleUse: false,
    });
    assert.equal(result.ok, true);
    assert.equal(env.kv['nonce--n-reusable'], undefined);
  });

  it('retries log readback once after 500ms when nonce not found on first attempt', async () => {
    let calls = 0;
    global.fetch = async (url, opts = {}) => {
      if (url.startsWith('https://admin.hlx.page/log/')) {
        assert.equal(opts.headers?.['x-auth-token'], 'test-api-key');
        calls += 1;
        if (calls === 1) return { ok: true, status: 200, json: async () => ({ entries: [] }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            entries: [{
              route: 'schedule-page-intent',
              nonce: 'n-late',
              path: '/foo',
              user: 'a@b.com',
              timestamp: Date.now(),
            }],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const env = makeEnv();
    const result = await verifyScheduleIntent({
      env,
      org: 'o',
      site: 's',
      apiKey: env.apiKey,
      nonce: 'n-late',
      route: 'schedule-page-intent',
      expected: { path: '/foo' },
      window: 5 * 60 * 1000,
      singleUse: true,
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
  });
});

describe('postActionAuditLog', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses Authorization header in DA mode', async () => {
    let captured;
    global.fetch = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 201 };
    };
    await postActionAuditLog({
      org: 'o',
      site: 's',
      authToken: 'token abc',
      apiKey: 'fallback-key',
      entry: { route: 'scheduled-publish', path: '/foo', triggeredBy: 'a@b.com' },
    });
    assert.equal(captured.url, 'https://admin.hlx.page/log/o/s/main');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers.Authorization, 'token abc');
    assert.equal(captured.opts.headers['x-auth-token'], undefined);
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].triggeredBy, 'a@b.com');
  });

  it('uses x-auth-token in Sidekick mode (no authToken)', async () => {
    let captured;
    global.fetch = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 201 };
    };
    await postActionAuditLog({
      org: 'o',
      site: 's',
      authToken: null,
      apiKey: 'stored-api-key',
      entry: { route: 'scheduled-publish', path: '/foo', triggeredBy: 'a@b.com' },
    });
    assert.equal(captured.opts.headers['x-auth-token'], 'stored-api-key');
    assert.equal(captured.opts.headers.Authorization, undefined);
  });

  it('soft-fails on admin log POST failure', async () => {
    global.fetch = async () => ({ ok: false, status: 500, statusText: 'oops' });
    await postActionAuditLog({
      org: 'o',
      site: 's',
      authToken: 'token x',
      apiKey: 'k',
      entry: { route: 'scheduled-publish', path: '/foo' },
    });
  });
});
