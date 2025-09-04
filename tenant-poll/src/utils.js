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
/* eslint-disable no-await-in-loop */
/* eslint-disable no-console */

export const MAIN_BRANCH = 'main';
export const ADMIN_API_BASE = 'https://admin.hlx.page';

/**
 * List all items stored in R2
 * @param {Object} env - The environment object
 * @param {string} prefix - The prefix of the items to list
 * @returns {Array} An array of items
 */
export async function listFromR2(env, prefix) {
  try {
    const bucket = env.R2_BUCKET; // R2 bucket containing tenants
    const items = [];
    console.log(`listing items from R2: ${prefix}`);
    let cursor;
    do {
      const listRes = await bucket.list({ cursor, prefix });
      console.log(`listing items from R2: ${prefix}`, JSON.stringify(listRes.objects));
      listRes.objects.forEach((obj) => {
        items.push(obj.key.split('.')[0]);
      });
      cursor = listRes.truncated ? listRes.cursor : undefined;
    } while (cursor);
    return items;
  } catch (error) {
    console.log(`error getting items from R2: ${error}`);
    return [];
  }
}

export async function getSnapshotsList(env, org, site) {
  try {
    const { ADMIN_API_TOKEN } = env;
    const snapshotsList = await fetch(
      `${ADMIN_API_BASE}/snapshot/${org}/${site}/${MAIN_BRANCH}`,
      {
        method: 'GET',
        headers: {
          Authorization: `token ${ADMIN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    ).then((res) => res.json());

    if (!snapshotsList.snapshots || !Array.isArray(snapshotsList.snapshots)) {
      console.debug('No snapshots found or invalid response format');
      return [];
    }
    console.debug(`Found ${snapshotsList.snapshots.length} snapshots`);
    return snapshotsList.snapshots;
  } catch (error) {
    console.error(`error getting snapshots for tenant: ${org}, ${site}, ${error}`);
    return [];
  }
}

/**
 * Process the snapshots list and return the snapshots
 * that are scheduled to be published within the lookahead window
 *
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 * @param {Array} snapshotsList - The snapshots list
 * @param {number} lookAheadMs - The lookahead window in milliseconds
 * @returns {Array} The snapshots that are scheduled to be published
 *
 */
export async function processSnapshotList(env, org, site, snapshotsList, lookAheadMs) {
  const publishSnapshotList = [];
  console.log('processing snapshot list', org, site, snapshotsList);
  for (const snapshot of snapshotsList) {
    try {
      const manifestResponse = await fetch(
        `${ADMIN_API_BASE}/snapshot/${org}/${site}/${MAIN_BRANCH}/${snapshot}`,
        {
          method: 'GET',
          headers: {
            Authorization: `token ${env.ADMIN_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      ).then((res) => res.json());
      if (manifestResponse.manifest
          && manifestResponse.manifest.metadata
          && manifestResponse.manifest.metadata.scheduledPublish
          && manifestResponse.manifest.resources.length > 0
      ) {
        console.log('snapshot is scheduled to be published', org, site, manifestResponse.manifest);
        const scheduledPublish = new Date(
          manifestResponse.manifest.metadata.scheduledPublish,
        ).getTime();
        const now = Date.now();
        if (scheduledPublish >= now && scheduledPublish <= (now + lookAheadMs)) {
          delete manifestResponse.manifest.resources; // strip resources to save space
          publishSnapshotList.push({
            org,
            site,
            snapshot,
            publishAt: scheduledPublish,
            manifest: manifestResponse.manifest,
          });
        }
      }
    } catch (error) {
      console.error(`error getting snapshot details: ${org}, ${site}, ${snapshot}, ${error}`);
    }
  }
  return publishSnapshotList;
}
