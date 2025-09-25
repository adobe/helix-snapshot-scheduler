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

import { IttyRouter } from 'itty-router';

export async function isAuthorized(authToken, org, site, admin = true) {
  // check if the user has access to the AEM Admin API site config for admin access
  if (admin) {
    const aemAdminApiUrl = `https://admin.hlx.page/config/${org}/sites/${site}.json`;
    const aemAdminApiResponse = await fetch(aemAdminApiUrl, {
      method: 'GET',
      headers: {
        Authorization: `${authToken}`,
        Accept: 'application/json',
      },
    });
    if (!aemAdminApiResponse.ok) {
      console.debug('Could not make a call to the AEM Admin API', aemAdminApiResponse.status, aemAdminApiResponse.statusText);
      return false;
    }
  }
  // check if user has access to read the snapshot list for snapshot list access
  const snapshotListUrl = `https://admin.hlx.page/snapshot/${org}/${site}/main`;
  const snapshotListResponse = await fetch(snapshotListUrl, {
    method: 'GET',
    headers: {
      Authorization: `${authToken}`,
      Accept: 'application/json',
    },
  });
  if (!snapshotListResponse.ok) {
    console.debug('Could not make a call to the AEM Snapshot List API', snapshotListResponse.status, snapshotListResponse.statusText);
    return false;
  }
  return true;
}

/**
 * Register the incoming request by creating a folder in the R2 bucket
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 */
export async function registerRequest(request, env) {
  try {
    const data = await request.json();
    if (!data) {
      return new Response('Invalid body. Please provide org and site', { status: 400 });
    }
    const { org, site } = data;
    if (!org || !site) {
      return new Response('Invalid body. Please provide org and site', { status: 400 });
    }
    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      return new Response('Unauthorized', { status: 401 });
    }
    const authorized = await isAuthorized(authToken, org, site, true);
    if (!authorized) {
      return new Response('Unauthorized', { status: 401 });
    }
    // first check if the folder already exists
    const folder = await env.R2_BUCKET.get(`registered/${org}--${site}.json`);
    if (folder) {
      console.debug('Register Request: ', org, site, 'Folder already exists');
      return new Response(`${org}/${site} is already registered`, { status: 200 });
    }
    await env.R2_BUCKET.put(`registered/${org}--${site}.json`, `{ "org": "${org}", "site": "${site}" }`);
    return new Response(`${org}/${site} is now registered for scheduled publishing via snapshots`, { status: 200 });
  } catch (err) {
    console.error('Register Request failed: ', request, err);
    return new Response('Register Request failed: Internal server error', { status: 500 });
  }
}

export async function isRegistered(request, env) {
  const { org, site } = request.params;
  if (!org || !site) {
    return new Response(JSON.stringify({ registered: 'error', error: 'Invalid org or site' }), {
      status: 400,
    });
  }
  try {
    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      return new Response('Unauthorized', { status: 401 });
    }
    const authorized = await isAuthorized(authToken, org, site, false);
    if (!authorized) {
      return new Response('Unauthorized', { status: 401 });
    }
    const folder = await env.R2_BUCKET.get(`registered/${org}--${site}.json`);
    if (folder) {
      return new Response(JSON.stringify({ registered: true }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ registered: false }), {
      status: 404,
    });
  } catch (err) {
    console.error('isRegistered failed: ', org, site, err);
    return new Response(JSON.stringify({ registered: 'error', error: 'Internal server error' }), {
      status: 500,
    });
  }
}

/**
 * Update the schedule by storing snapshot scheduling information in R2 bucket
 * @param {Object} request - The incoming request
 * @param {Object} env - The environment object
 */
export async function updateSchedule(request, env) {
  try {
    const data = await request.json();
    if (!data) {
      return new Response('Invalid body. Please provide org, site, snapshotId, and scheduledPublish', { status: 400 });
    }

    const {
      org, site, snapshotId, scheduledPublish,
    } = data;
    if (!org || !site || !snapshotId || !scheduledPublish) {
      return new Response('Invalid body. Please provide org, site, snapshotId, and scheduledPublish', { status: 400 });
    }

    // Validate scheduledPublish is a valid date
    const scheduledDate = new Date(scheduledPublish);
    if (Number.isNaN(scheduledDate.getTime())) {
      return new Response('Invalid scheduledPublish date format. Please provide a valid ISO date string', { status: 400 });
    }

    // Check authorization
    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      return new Response('Unauthorized', { status: 401 });
    }

    const authorized = await isAuthorized(authToken, org, site, false);
    if (!authorized) {
      return new Response('Unauthorized. You need to have basic_author access to update the scheduled publish date for a snapshot', { status: 401 });
    }

    // Check if the org/site is registered
    const registration = await env.R2_BUCKET.get(`registered/${org}--${site}.json`);
    if (!registration) {
      return new Response(`${org}/${site} is not registered for scheduled publishing`, { status: 404 });
    }

    // Read existing schedule data
    let scheduleData = {};
    try {
      const existingSchedule = await env.R2_BUCKET.get('schedule.json');
      if (existingSchedule) {
        scheduleData = await existingSchedule.json();
      }
    } catch (err) {
      console.warn('Could not read existing schedule data, starting fresh:', err);
    }

    // Ensure the structure exists
    const orgSiteKey = `${org}--${site}`;
    if (!scheduleData[orgSiteKey]) {
      scheduleData[orgSiteKey] = {};
    }

    // Update the schedule with the new snapshot
    scheduleData[orgSiteKey][snapshotId] = scheduledPublish;

    // Store the updated schedule back to R2
    await env.R2_BUCKET.put('schedule.json', JSON.stringify(scheduleData, null, 2));

    console.log(`Schedule updated for ${orgSiteKey}: ${snapshotId} -> ${scheduledPublish}`);

    return new Response(JSON.stringify({
      success: true,
      message: `Schedule updated for ${org}/${site}`,
      org,
      site,
      snapshotId,
      scheduledPublish,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Update schedule failed: ', request, err);
    return new Response('Update schedule failed: Internal server error', { status: 500 });
  }
}

/**
 * Get the schedule data for a specific org/site or all schedules
 * @param {Object} request - The incoming request
 * @param {Object} env - The environment object
 */
export async function getSchedule(request, env) {
  try {
    const { org, site } = request.params;
    if (!org || !site) {
      return new Response('Invalid org or site', { status: 400 });
    }
    // Check authorization if specific org/site requested
    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      return new Response('Unauthorized', { status: 401 });
    }
    const authorized = await isAuthorized(authToken, org, site, false);
    if (!authorized) {
      return new Response('Unauthorized', { status: 401 });
    }

    let scheduleData = {};
    try {
      const existingSchedule = await env.R2_BUCKET.get('schedule.json');
      if (existingSchedule) {
        scheduleData = await existingSchedule.json();
      }
    } catch (err) {
      console.warn('Could not read schedule data:', err);
      return new Response('Could not retrieve schedule data', { status: 500 });
    }
    const orgSiteKey = `${org}--${site}`;
    const orgSiteData = scheduleData[orgSiteKey] || {};
    return new Response(JSON.stringify({
      [orgSiteKey]: orgSiteData,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Get schedule failed: ', request, err);
    return new Response('Get schedule failed: Internal server error', { status: 500 });
  }
}

// Create a new router
const router = IttyRouter();
router.post('/register', async (request, env) => registerRequest(request, env));
router.get('/register/:org/:site', async (request, env) => isRegistered(request, env));
router.post('/schedule', async (request, env) => updateSchedule(request, env));
router.get('/schedule/:org/:site', async (request, env) => getSchedule(request, env));
// catch all for invalid routes
router.all('*', () => new Response('404, not found!', { status: 404 }));

export default router;
