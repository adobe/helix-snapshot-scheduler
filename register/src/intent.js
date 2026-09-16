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
/* eslint-disable no-console */

const ADMIN = 'https://admin.hlx.page';

// Readback tuning. Admin's audit log is written asynchronously (helix-admin
// enqueues to SQS; helix-audit-logger appends to S3), so a just-written intent
// takes ~1-3s — up to ~30s under FIFO per-org/site backlog — to become
// queryable. Poll with capped exponential backoff (front-loading the common
// case) up to a bounded deadline, staying well under admin's 10 req/s limit.
const READBACK_DEADLINE_MS = 10000;
const READBACK_INITIAL_BACKOFF_MS = 500;
const READBACK_MAX_BACKOFF_MS = 4000;
const READBACK_MAX_ATTEMPTS = 20; // defensive cap; the real bound is the deadline

/**
 * Convert a millisecond duration into the short-notation timespan string that
 * helix-admin's `parseTimespan()` accepts on the log `since` query param
 * (a number followed by a `s`/`m`/`h`/`d` unit, e.g. `5m`, `30m`, `1h`).
 * Picks the largest unit that divides the duration evenly so values stay whole.
 */
function msToTimespan(ms) {
  const units = [
    ['d', 86400000],
    ['h', 3600000],
    ['m', 60000],
    ['s', 1000],
  ];
  for (const [unit, size] of units) {
    if (ms >= size && ms % size === 0) {
      return `${ms / size}${unit}`;
    }
  }
  // Fall back to whole seconds (rounded up) for sub-second or odd durations.
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

/**
 * Parse a `Retry-After` header (delta-seconds or an HTTP-date) into milliseconds.
 * Returns null when the header is absent or unparseable.
 */
function parseRetryAfterMs(resp) {
  const value = resp.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

async function fetchLogEntries({
  org, site, apiKey, sinceMs,
}) {
  const url = `${ADMIN}/log/${org}/${site}/main?since=${msToTimespan(sinceMs)}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'x-auth-token': apiKey, Accept: 'application/json' },
  });
  if (resp.status === 429) {
    return { throttled: true, retryAfterMs: parseRetryAfterMs(resp) };
  }
  if (!resp.ok) {
    return { error: `admin log GET failed: ${resp.status}` };
  }
  try {
    const json = await resp.json();
    return { entries: Array.isArray(json?.entries) ? json.entries : [] };
  } catch {
    return { error: 'admin log GET returned invalid JSON' };
  }
}

function findIntent(entries, { route, nonce }) {
  return entries.find((e) => e?.route === route && e?.nonce === nonce);
}

export async function verifyScheduleIntent({
  env, org, site, apiKey, nonce, route,
  expected, window, singleUse,
  readbackDeadlineMs = READBACK_DEADLINE_MS,
  initialBackoffMs = READBACK_INITIAL_BACKOFF_MS,
}) {
  if (!nonce) return { ok: false, status: 401, error: 'missing nonce or authorization' };
  if (!apiKey) return { ok: false, status: 503, error: 'scheduler not properly registered, contact your admin' };

  // Single-use replay check
  if (singleUse) {
    try {
      const used = await env.SCHEDULER_KV.get(`nonce--${nonce}`);
      if (used) return { ok: false, status: 401, error: 'schedule intent already used' };
    } catch (err) {
      console.warn('SCHEDULER_KV.get failed:', err);
      return { ok: false, status: 500, error: 'could not verify schedule intent' };
    }
  }

  // Log readback with capped exponential backoff. The audit log is written
  // asynchronously, so poll until the intent appears or we hit the deadline,
  // returning as soon as it is found. A 429 is retried (not failed), honoring
  // Retry-After when provided.
  let entry = null;
  let backoffMs = initialBackoffMs;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < READBACK_MAX_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetchLogEntries({
      org, site, apiKey, sinceMs: window,
    });
    if (r.error) return { ok: false, status: 503, error: 'could not verify schedule intent' };
    if (!r.throttled) {
      entry = findIntent(r.entries, { route, nonce });
      if (entry) break;
    }
    const remainingMs = readbackDeadlineMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    const waitMs = Math.min(
      r.throttled && r.retryAfterMs > 0 ? r.retryAfterMs : backoffMs,
      remainingMs,
    );
    // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (!r.throttled) backoffMs = Math.min(backoffMs * 2, READBACK_MAX_BACKOFF_MS);
  }

  if (!entry) {
    // The intent may simply not have propagated to the audit log yet (async
    // pipeline). Return a retryable "not yet visible" signal rather than an auth
    // failure so the client can retry with the same nonce.
    return { ok: false, status: 425, error: 'schedule intent not yet visible, retry' };
  }

  // Freshness window
  if (typeof entry.timestamp !== 'number' || Date.now() - entry.timestamp > window) {
    return { ok: false, status: 401, error: 'schedule intent has expired' };
  }

  // Payload binding
  const mismatchKey = Object.keys(expected || {}).find((k) => entry[k] !== expected[k]);
  if (mismatchKey) {
    return { ok: false, status: 401, error: 'schedule intent does not match this request' };
  }

  if (singleUse) {
    try {
      await env.SCHEDULER_KV.put(`nonce--${nonce}`, '1', { expirationTtl: 600 });
    } catch (err) {
      console.warn('SCHEDULER_KV.put failed (fail-open):', err);
    }
  }

  return { ok: true, user: entry.user, timestamp: entry.timestamp };
}

export async function postActionAuditLog({
  org, site, authToken, apiKey, entry,
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers.Authorization = authToken;
  } else if (apiKey) {
    headers['x-auth-token'] = apiKey;
  } else {
    console.warn('postActionAuditLog: no credential available, skipping');
    return;
  }
  try {
    const resp = await fetch(`${ADMIN}/log/${org}/${site}/main`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ entries: [entry] }),
    });
    if (!resp.ok) {
      console.warn(`postActionAuditLog non-2xx: ${resp.status} ${resp.statusText || ''}`);
    }
  } catch (err) {
    console.warn('postActionAuditLog failed:', err);
  }
}

export async function resolveDaUserId({ authToken, org, site }) {
  if (!authToken) return null;
  try {
    const resp = await fetch(`${ADMIN}/profile/${org}/${site}`, {
      method: 'GET',
      headers: { Authorization: authToken, Accept: 'application/json' },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    // helix-admin's profile handler nests the user under `profile`, e.g.
    // { profile: { email, name, ... }, links: { ... } }.
    return json?.profile?.email || null;
  } catch (err) {
    console.warn('resolveDaUserId failed:', err);
    return null;
  }
}
