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

async function fetchLogEntries({
  org, site, apiKey, sinceMs,
}) {
  const url = `${ADMIN}/log/${org}/${site}/main?since=${msToTimespan(sinceMs)}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'x-auth-token': apiKey, Accept: 'application/json' },
  });
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

  // Log readback — one retry after 500ms to absorb admin log propagation lag
  let entries = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetchLogEntries({
      org, site, apiKey, sinceMs: window,
    });
    if (r.error) return { ok: false, status: 503, error: 'could not verify schedule intent' };
    entries = r.entries;
    if (findIntent(entries, { route, nonce })) break;
    if (attempt === 0) {
      // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const entry = findIntent(entries, { route, nonce });
  if (!entry) {
    return { ok: false, status: 401, error: 'schedule intent not found in audit log' };
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
