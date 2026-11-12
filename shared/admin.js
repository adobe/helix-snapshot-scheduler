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

export const ADMIN_API_BASE = 'https://admin.hlx.page';

/**
 * Read the site's API key. Throws on KV errors so callers can tell an outage
 * apart from a site that is not registered (resolves to null).
 */
export async function readApiKey(env, org, site) {
  if (!env || !env.SCHEDULER_KV) {
    throw new Error('KV binding is missing in the environment.');
  }
  const apiKey = await env.SCHEDULER_KV.get(`${org}--${site}--apiKey`);
  return apiKey || null;
}

export async function getApiKey(env, org, site) {
  try {
    return await readApiKey(env, org, site);
  } catch (err) {
    console.error('Error getting API key from KV: ', org, site, err);
    return null;
  }
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
    const resp = await fetch(`${ADMIN_API_BASE}/log/${org}/${site}/main`, {
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

/**
 * Write the outcome of a scheduled publish to the site's admin audit log.
 * Never throws: audit logging must not affect publishing.
 */
export async function logScheduledPublish(env, {
  org, site, path, type = 'snapshot', scheduledPublish, userId,
}, { status, adminStatus = null, attempts = null }) {
  try {
    const apiKey = await getApiKey(env, org, site);
    await postActionAuditLog({
      org,
      site,
      apiKey,
      entry: {
        route: 'scheduled-publish',
        status,
        type,
        path,
        ...(type !== 'page' && { snapshotId: path }),
        scheduledPublish,
        adminStatus,
        attempts,
        userId: userId || null,
      },
    });
  } catch (err) {
    console.warn('logScheduledPublish failed:', err);
  }
}
