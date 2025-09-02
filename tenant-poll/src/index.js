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

import { listFromR2, getSnapshotsList, processSnapshotList } from './utils.js';

const LOOKAHEAD_SEC = 600; // 10 minutes

async function addTenantsToQueue(env) {
  try {
    console.debug('polling tenants');
    // get all registered tenants from R2 bucket
    const tenants = await listFromR2(env, 'registered/');
    console.debug(`tenants: ${tenants}`);
    tenants.filter((tenant) => tenant.key.split('--').length === 2).forEach(async (tenant) => {
      const [org, site] = tenant.key.split('--');
      if (!org || !site) return;
      await env.TENANT_POLL_QUEUE.send({ org, site });
    });
  } catch (error) {
    console.error(`error adding tenants to queue: ${error}`);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    // add registered tenants to the queue
    return addTenantsToQueue(env, ctx);
  },
  async queue(batch, env) {
    // get scheduled publish times from snapshots for each tenant
    for (const msg of batch.messages) {
      const { org, site } = msg.body;
      let snapshots = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        snapshots = await getSnapshotsList(env, org, site);
      } catch (err) {
        console.error('Tenant Poll Worker failed: getSnapshotsList', org, site, err);
        // Requeue with backoff or send to DLQ if needed
        const delaySec = 30; // simple retry delay
        await env.TENANT_POLL_QUEUE.send(msg.body, { delaySeconds: delaySec });
        continue; // eslint-disable-line no-continue
      }
      if (snapshots.length > 0) {
        try {
          const publishSnapshotList = await processSnapshotList(
            env,
            org,
            site,
            snapshots,
            LOOKAHEAD_SEC * 1000,
          );
          if (publishSnapshotList.length > 0) {
            for (const snapshot of publishSnapshotList) {
              await env.PUBLISH_QUEUE.send(
                snapshot,
                { delaySeconds: Math.ceil((snapshot.publishAt - Date.now()) / 1000) || 0 },
              );
            }
          }
        } catch (err) {
          console.error('Tenant Poll Worker failed: processSnapshotList', org, site, err);
        }
      }
    }
  },
};
