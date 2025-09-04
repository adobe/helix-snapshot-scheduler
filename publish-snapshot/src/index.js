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

const ADMIN_API_BASE = 'https://admin.hlx.page';
const MAIN_BRANCH = 'main';

async function publishSnapshot(env, org, site, snapshot, publishAt, manifest, messageBody) {
  try {
    // Publish the snapshot
    console.log('Publish Snapshot Worker: publishing snapshot', org, site, snapshot, publishAt, manifest);
    const publishResponse = await fetch(
      `${ADMIN_API_BASE}/snapshot/${org}/${site}/${MAIN_BRANCH}/${snapshot}?publish=true`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${env.ADMIN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publish: true,
        }),
      },
    ).then((res) => res.json());
    console.log(publishResponse);
    console.log(`Successfully published snapshot ${snapshot}`);
  } catch (error) {
    console.error(`Failed to publish snapshot ${snapshot}:`, error.message);
    // if publish fails, requeue the message with a delay
    await env.PUBLISH_QUEUE.send(messageBody, { delaySeconds: 30 });
  }
  // Update the manifest to remove scheduledPublish property and mark as published

  console.log(`Updating manifest for snapshot ${manifest.id}...`);

  // Create updated manifest without scheduledPublish and with published metadata
  const updatedManifest = {
    title: manifest.title || '',
    description: manifest.description || '',
    locked: manifest.locked || false,
    metadata: {
      ...manifest.metadata,
      publishedAt: new Date(publishAt).toISOString(),
      publishedBy: 'scheduled-snapshot-publisher',
      status: 'published',
    },
  };
  delete updatedManifest.metadata.scheduledPublish;
  console.log(updatedManifest);
  try {
    // Update the snapshot manifest
    await fetch(
      `${ADMIN_API_BASE}/snapshot/${org}/${site}/${MAIN_BRANCH}/${snapshot}`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${env.ADMIN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedManifest),
      },
    ).then((res) => res.json());

    console.log(`Successfully updated manifest for snapshot ${snapshot}`);
  } catch (manifestError) {
    console.error(`Failed to update manifest for snapshot ${snapshot}:`, manifestError.message);
    // Don't fail the entire process if manifest update fails
    // The snapshot was still published successfully
  }
}

export default {
  async queue(batch, env) {
    // publish
    for (const msg of batch.messages) {
      console.log('Publish Snapshot Worker: publishing snapshot', msg.body);
      const {
        org,
        site,
        snapshot,
        publishAt,
        manifest,
      } = msg.body;
      try {
        await publishSnapshot(env, org, site, snapshot, publishAt, manifest, msg.body);
      } catch (err) {
        console.error('Publish Snapshot Worker failed: ', org, site, snapshot, err);
        // Don't fail the entire process if publish fails
        // The snapshot was still published successfully
      }
    }
  },
};
