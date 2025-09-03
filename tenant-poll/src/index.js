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
/* eslint-disable no-unused-vars */

import { listFromR2, getSnapshotsList, processSnapshotList } from './utils.js';

const LOOKAHEAD_SEC = 600; // 10 minutes

async function addTenantsToQueue(env) {
  try {
    console.log('polling tenants');
    // get all registered tenants from R2 bucket
    const tenants = await listFromR2(env, 'registered/');
    // console.log(`tenants: ${JSON.stringify(tenants)}`);
    if (tenants && tenants.length === 0) {
      console.log('No tenants found');
      return 0;
    } else {
      console.log(`found ${tenants.length} tenants`);
    }
    for (const tenant of tenants) {
      const [org, site] = tenant.replace('.json', '').replace('registered/', '').split('--');
      if (!org || !site) {
        throw new Error(`Invalid tenant name: ${tenant}`);
      }
      // console.log(`org: ${org}, site: ${site}`);
      // console.log(`adding tenant ${org}/${site} to queue...`);
      const tenantData = { org, site };
      await env.TENANT_POLL_QUEUE.send(tenantData);
      console.log(`tenant ${org}/${site} added to queue successfully`);
    }
    console.log('All tenants added to queue');
    return tenants.length;
  } catch (error) {
    console.error(`error adding tenants to queue: ${error}`);
    throw error;
  }
}

export default {
  async scheduled(controller, env, ctx) {
    try {
      // add registered tenants to the queue
      const numTenants = await addTenantsToQueue(env);
      console.log(`number of tenants added to queue: ${numTenants}`);
      return true;
    } catch (error) {
      console.error(`error adding tenants to queue: ${error}`);
      return false;
    }
  },
  async queue(batch, env) {
    console.log('Tenant Poll Worker queue: Processing batch', batch.messages);
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
