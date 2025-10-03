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

// Allowed origins for CORS
const allowedOrigins = [
  '*.aem.live',
  '*.da.live',
  '*.aem.page',
  'http://localhost:3000',
];

// Function to check if origin is allowed and return appropriate CORS headers
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const corsHeaders = {
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (origin) {
    // Check if origin matches any allowed pattern
    const isAllowed = allowedOrigins.some((allowedOrigin) => {
      if (allowedOrigin.startsWith('*.')) {
        // Handle wildcard subdomains
        const domain = allowedOrigin.substring(2);
        return origin.endsWith(domain);
      }
      return origin === allowedOrigin;
    });
    if (isAllowed) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
    }
  }
  return corsHeaders;
}

export async function setApiToken(env, org, site, apiToken) {
  try {
    if (!env || !env.SCHEDULER_KV) {
      console.error('KV binding is missing in the environment.');
      return false;
    }
    const kvConfigKey = `${org}--${site}--apiToken`;
    await env.SCHEDULER_KV.put(kvConfigKey, apiToken);
    console.log('API token set in KV: ', org, site);
    return true;
  } catch (err) {
    console.error('Error setting API token in KV: ', org, site, err);
    return false;
  }
}

export async function getApiToken(env, org, site) {
  try {
    if (!env || !env.SCHEDULER_KV) {
      console.error('KV binding is missing in the environment.');
      return null;
    }
    const kvConfigKey = `${org}--${site}--apiToken`;
    const apiToken = await env.SCHEDULER_KV.get(kvConfigKey);
    if (!apiToken) {
      return null;
    }
    return apiToken;
  } catch (err) {
    console.error('Error getting API token from KV: ', org, site, err);
    return null;
  }
}

export async function fetchSnapshotManifest(org, site, snapshot, apiToken) {
  const adminURL = `https://admin.hlx.page/snapshot/${org}/${site}/main/${snapshot}`;
  const resp = await fetch(adminURL, {
    method: 'GET',
    headers: {
      Authorization: `${apiToken}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    console.log('Could not make a call to the AEM Snapshot Manifest API', resp.status, resp.statusText);
    return null;
  }
  const { manifest } = await resp.json();
  return manifest;
}

export async function isAuthorized(authToken, org, site, admin = true) {
  // check if the user has access to the AEM Admin API site config for admin access
  if (admin) {
    const aemAdminApiUrl = `https://admin.hlx.page/config/${org}/sites/${site}.json`;
    console.log('AEM Admin API URL:', aemAdminApiUrl);
    const aemAdminApiResponse = await fetch(aemAdminApiUrl, {
      method: 'GET',
      headers: {
        Authorization: `${authToken}`,
        Accept: 'application/json',
      },
    });
    if (!aemAdminApiResponse.ok) {
      console.log('Could not make a call to the AEM Admin API', aemAdminApiResponse.status, aemAdminApiResponse.statusText);
      return false;
    }
    return true;
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
    console.log(
      'Could not make a call to the AEM Snapshot List API',
      snapshotListResponse.status,
      snapshotListResponse.statusText,
    );
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
      console.log('Register Request: Invalid body. Please provide org, site and apiToken');
      return new Response('Invalid body. Please provide org, site and apiToken', { status: 400 });
    }
    const { org, site, apiToken } = data;
    if (!org || !site || !apiToken) {
      console.log('Register Request: Invalid body. Please provide org, site and apiToken');
      return new Response('Invalid body. Please provide org, site and apiToken', { status: 400 });
    }

    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      console.log('Register Request: No authorization token found');
      return new Response('Unauthorized', { status: 401 });
    }
    const authorized = await isAuthorized(authToken, org, site, true);
    if (!authorized) {
      console.log('Register Request: isAuthorized returned false');
      return new Response('Unauthorized', { status: 401 });
    }
    // set the api token for the org/site
    const success = await setApiToken(env, org, site, apiToken);
    if (!success) {
      console.log('Register Request: Failed to set API token');
      return new Response('Register Request failed: Internal server error', { status: 500 });
    }
    return new Response('Success!', { status: 200 });
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
    const apiToken = await getApiToken(env, org, site);
    if (!apiToken) {
      return new Response(JSON.stringify({ registered: false }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify({ registered: true }), {
      status: 200,
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
      console.log('Update Schedule Request: Invalid body. Please provide org, site, snapshotId, and scheduledPublish');
      return new Response('Invalid body. Please provide org, site, snapshotId, and scheduledPublish', { status: 400 });
    }

    const {
      org, site, snapshotId,
    } = data;
    if (!org || !site || !snapshotId) {
      console.log('Update Schedule Request: Invalid body. Please provide org, site and snapshotId');
      return new Response('Invalid body. Please provide org, site and snapshotId', { status: 400 });
    }

    // Get the snapshot details from the AEM Admin API
    const apiToken = await getApiToken(env, org, site);
    if (!apiToken) {
      console.log('Update Schedule Request: No API token found');
      return new Response('Org/site not registered', { status: 404 });
    }
    const snapshotManifest = await fetchSnapshotManifest(org, site, snapshotId, apiToken);
    if (!snapshotManifest) {
      console.log('Update Schedule Request: Could not get snapshot details');
      return new Response('Could not get snapshot details', { status: 404 });
    }
    const { scheduledPublish } = snapshotManifest.metadata;
    console.log('Update Schedule Request: Scheduled publish: ', scheduledPublish);
    // Validate scheduledPublish is a valid date
    const scheduledDate = new Date(scheduledPublish);
    if (Number.isNaN(scheduledDate.getTime())) {
      console.log('Update Schedule Request: Invalid scheduledPublish date format. Please provide a valid ISO date string');
      return new Response('Invalid scheduledPublish date format. Please provide a valid ISO date string', { status: 400 });
    }

    // Read existing schedule data
    let scheduleData = {};
    try {
      const existingSchedule = await env.R2_BUCKET.get('schedule.json');
      if (existingSchedule) {
        scheduleData = await existingSchedule.json();
      }
    } catch (err) {
      console.warn('Could not read existing schedule data:', err);
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
// export async function getSchedule(request, env) {
//   try {
//     const { org, site } = request.params;
//     if (!org || !site) {
//       return new Response('Invalid org or site', { status: 400 });
//     }
//     // Check authorization if specific org/site requested
//     const authToken = request.headers.get('Authorization');
//     if (!authToken) {
//       return new Response('Unauthorized', { status: 401 });
//     }
//     const authorized = await isAuthorized(authToken, org, site, false);
//     if (!authorized) {
//       return new Response('Unauthorized', { status: 401 });
//     }

//     let scheduleData = {};
//     try {
//       const existingSchedule = await env.R2_BUCKET.get('schedule.json');
//       if (existingSchedule) {
//         scheduleData = await existingSchedule.json();
//       }
//     } catch (err) {
//       console.warn('Could not read schedule data:', err);
//       return new Response('Could not retrieve schedule data', { status: 500 });
//     }
//     const orgSiteKey = `${org}--${site}`;
//     const orgSiteData = scheduleData[orgSiteKey] || {};
//     return new Response(JSON.stringify({
//       [orgSiteKey]: orgSiteData,
//     }), {
//       status: 200,
//       headers: {
//         'Content-Type': 'application/json',
//       },
//     });
//   } catch (err) {
//     console.error('Get schedule failed: ', request, err);
//     return new Response('Get schedule failed: Internal server error', { status: 500 });
//   }
// }

// Create a new router
const router = IttyRouter();

// Handle preflight OPTIONS requests for POST endpoints only
// router.options('/register', (request) => new Response(null, {
//   status: 204,
//   headers: getCorsHeaders(request),
// }));
router.options('/schedule', (request) => new Response(null, {
  status: 204,
  headers: getCorsHeaders(request),
}));

router.post('/register', async (request, env) => registerRequest(request, env));
router.get('/register/:org/:site', async (request, env) => isRegistered(request, env));
router.post('/schedule', async (request, env) => updateSchedule(request, env));
// router.get('/schedule/:org/:site', async (request, env) => getSchedule(request, env));
// catch all for invalid routes
router.all('*', () => new Response('404, not found!', { status: 404 }));

export default router;
