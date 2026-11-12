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
/* eslint-disable no-await-in-loop */
/* eslint-disable quote-props */
/* eslint-disable comma-dangle */

import {
  ADMIN_API_BASE, getApiKey, readApiKey, logScheduledPublish,
} from '../../shared/admin.js';
import { appendToDailyFile, removeFromSchedule } from '../../shared/schedule-store.js';

export { getApiKey };

const MAIN_BRANCH = 'main';

// Admin responses that will not succeed on retry (bad request, auth, missing snapshot/page).
const PERMANENT_STATUSES = new Set([400, 401, 403, 404]);
const RETRY_BASE_DELAY_SECONDS = 30;
const RETRY_MAX_DELAY_SECONDS = 600;

export function isPermanentFailure({ status, notRegistered }) {
  return !!notRegistered || PERMANENT_STATUSES.has(status);
}

export function retryDelaySeconds(attempts = 1) {
  const exp = Math.max(0, attempts - 1);
  return Math.min(RETRY_BASE_DELAY_SECONDS * 2 ** exp, RETRY_MAX_DELAY_SECONDS);
}

/**
 * Publish a snapshot by calling the AEM Admin API
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 * @param {string} snapshotId - The snapshot ID
 * @param {boolean} approved - Whether the snapshot is approved & published by the user
 * @returns {Promise<{ok: boolean, status: number|null, notRegistered?: boolean}>}
 */
async function publishSnapshot(env, org, site, snapshotId, approved) {
  try {
    const apiKey = await readApiKey(env, org, site);
    if (!apiKey) {
      console.log('Publish Snapshot Worker: No API token found');
      return { ok: false, status: null, notRegistered: true };
    }
    // forceUpdate: publish even when the live copy is newer than the snapshot copy
    const url = approved
      ? `${ADMIN_API_BASE}/snapshot/${org}/${site}/${MAIN_BRANCH}/${snapshotId}?review=approve&keepResources=true&forceUpdate=true`
      : `${ADMIN_API_BASE}/snapshot/${org}/${site}/${MAIN_BRANCH}/${snapshotId}?publish=true&forceUpdate=true`;
    const body = approved
      ? { 'review': 'approve', 'keepResources': 'true', 'forceUpdate': 'true' }
      : { 'publish': 'true', 'forceUpdate': 'true' };
    console.log(`Publish Snapshot Worker: ${approved ? 'approving' : 'publishing'} snapshot`, org, site, snapshotId);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status >= 400) {
      console.error('Publish Snapshot Worker: failed to publish snapshot', org, site, snapshotId, res.status, res.statusText);
      return { ok: false, status: res.status };
    }
    console.log('Publish Snapshot Worker: successfully published snapshot', org, site, snapshotId, res.status, res.statusText);
    return { ok: true, status: res.status };
  } catch (error) {
    console.error(`Failed to publish snapshot ${snapshotId}:`, error.message);
    return { ok: false, status: null };
  }
}

/**
 * Publish a page by calling the AEM Admin API
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 * @param {string} path - The page path
 * @returns {Promise<{ok: boolean, status: number|null, notRegistered?: boolean}>}
 */
async function publishPage(env, org, site, path) {
  try {
    const apiKey = await readApiKey(env, org, site);
    if (!apiKey) {
      console.log('Publish Page Worker: No API token found');
      return { ok: false, status: null, notRegistered: true };
    }
    console.log('Publish Page Worker: publishing page', org, site, path);
    const res = await fetch(`${ADMIN_API_BASE}/live/${org}/${site}/${MAIN_BRANCH}${path}`, {
      method: 'POST',
      headers: { Authorization: `token ${apiKey}` },
    });
    if (res.status >= 400) {
      console.error('Publish Page Worker: failed to publish page', org, site, path, res.status, res.statusText);
      return { ok: false, status: res.status };
    }
    console.log('Publish Page Worker: successfully published page', org, site, path, res.status, res.statusText);
    return { ok: true, status: res.status };
  } catch (error) {
    console.error(`Failed to publish page ${path}:`, error.message);
    return { ok: false, status: null };
  }
}

/**
 * Check whether a schedule entry still exists in schedule.json.
 * Returns false if the entry was removed (e.g. via DELETE /schedule/page),
 * preventing publication of unscheduled items whose queue messages are
 * already in-flight.
 */
async function isStillScheduled(env, org, site, path) {
  try {
    const scheduleData = await env.R2_BUCKET.get('schedule.json');
    if (!scheduleData) return false;
    const schedule = await scheduleData.json();
    const orgSiteKey = `${org}--${site}`;
    return !!(schedule[orgSiteKey] && schedule[orgSiteKey][path]);
  } catch (err) {
    console.warn('Could not verify schedule entry, proceeding with publish:', err.message);
    return true;
  }
}

export default {
  async queue(batch, env) {
    const published = [];
    const failed = [];

    for (const msg of batch.messages) {
      const attempts = msg.attempts || 1;
      const {
        org,
        site,
        scheduledPublish,
        approved = false,
        type = 'snapshot',
        userId,
      } = msg.body;
      // backward compat: support in-flight messages that still use snapshotId
      const path = msg.body.path ?? msg.body.snapshotId;
      console.log(`Publish Worker: processing ${type} ${path} for ${org}/${site} (attempt ${attempts})`);

      try {
        // Guard: verify the entry hasn't been unscheduled while the message was in-flight
        const stillScheduled = await isStillScheduled(env, org, site, path);
        if (!stillScheduled) {
          console.log(`Skipping ${type} ${path} for ${org}/${site}: entry was unscheduled`);
          msg.ack();
          // eslint-disable-next-line no-continue
          continue;
        }

        const result = type === 'page'
          ? await publishPage(env, org, site, path)
          : await publishSnapshot(env, org, site, path, approved);

        const entry = {
          msg,
          org,
          site,
          path,
          scheduledPublish,
          approved,
          type,
          userId,
          attempts,
          adminStatus: result.status,
        };
        if (result.ok) {
          published.push({ ...entry, publishedAt: new Date().toISOString() });
          console.log(`Successfully published ${type} ${path} for ${org}/${site}`);
        } else if (isPermanentFailure(result)) {
          console.error(`Permanent failure publishing ${type} ${path} for ${org}/${site} (status ${result.status ?? 'n/a'}), not retrying`);
          failed.push({
            ...entry,
            reason: result.notRegistered ? 'org-site-not-registered' : `admin-${result.status}`,
          });
        } else {
          const delaySeconds = retryDelaySeconds(attempts);
          console.error(`Transient failure publishing ${type} ${path} for ${org}/${site} (status ${result.status ?? 'n/a'}), retrying in ${delaySeconds}s`);
          msg.retry({ delaySeconds });
        }
      } catch (err) {
        const delaySeconds = retryDelaySeconds(attempts);
        console.error(`Publish Worker error (attempt ${attempts}), retrying in ${delaySeconds}s:`, org, site, path, err.message);
        msg.retry({ delaySeconds });
      }
    }

    let failedRecorded = failed.length === 0;
    if (failed.length > 0) {
      try {
        const failedAt = new Date().toISOString();
        await appendToDailyFile(env, 'failed', failed.map((f) => ({
          org: f.org,
          site: f.site,
          path: f.path,
          scheduledPublish: f.scheduledPublish,
          type: f.type,
          userId: f.userId,
          messageId: f.msg.id,
          timestamp: f.msg.timestamp,
          adminStatus: f.adminStatus,
          attempts: f.attempts,
          failedAt,
          reason: f.reason,
        })));
        failedRecorded = true;
      } catch (err) {
        console.error('Failed to store failed entries in R2:', err.message);
      }
    }

    // Only remove published entries from schedule.json once they are recorded in completed/,
    // so a retry still finds them scheduled.
    let recorded = published.length === 0;
    if (published.length > 0) {
      try {
        await appendToDailyFile(env, 'completed', published.map((p) => ({
          org: p.org,
          site: p.site,
          path: p.path,
          scheduledPublish: p.scheduledPublish,
          publishedAt: p.publishedAt,
          publishedBy: p.type === 'page' ? 'scheduled-page-publisher' : 'scheduled-snapshot-publisher',
        })));
        recorded = true;
      } catch (err) {
        console.error('Failed to batch move to completed:', err.message);
      }
    }

    // Remove entries from schedule.json only once their outcome is durably recorded,
    // otherwise retry so nothing is lost and cron does not re-queue an acked message.
    const toRemove = [...(recorded ? published : []), ...(failedRecorded ? failed : [])];
    if (toRemove.length > 0) {
      try {
        await removeFromSchedule(env, toRemove);
        console.log(`Updated schedule.json, removed ${toRemove.length} entries`);
      } catch (err) {
        console.error('Failed to batch update schedule.json:', err.message);
        recorded = false;
        failedRecorded = false;
      }
    }

    const settle = (items, ok) => items.forEach((item) => {
      if (ok) {
        item.msg.ack();
      } else {
        item.msg.retry({ delaySeconds: retryDelaySeconds(item.attempts) });
      }
    });
    settle(failed, failedRecorded);
    settle(published, recorded);

    await Promise.all([
      ...published.map((p) => logScheduledPublish(env, p, {
        status: 'published', adminStatus: p.adminStatus, attempts: p.attempts,
      })),
      ...failed.map((f) => logScheduledPublish(env, f, {
        status: 'failed', adminStatus: f.adminStatus, attempts: f.attempts,
      })),
    ]);

    console.log(`Processed batch: ${published.length} published, ${failed.length} failed permanently`);
  },
};
