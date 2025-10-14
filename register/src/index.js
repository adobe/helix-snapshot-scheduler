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

// Global environment variable
let globalEnv = null;

// Get environment-specific allowed origins for CORS
function getAllowedOrigins() {
  const baseOrigins = [
    '*.aem.live',
    '*.da.live',
    '*.aem.page',
  ];

  // Only allow localhost in CI environment for development/testing
  if (globalEnv?.ENVIRONMENT === 'ci') {
    return [...baseOrigins, 'http://localhost:3000', 'http://localhost:6456'];
  }

  return baseOrigins;
}

// Function to check if origin is allowed and return appropriate CORS headers
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const corsHeaders = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };

  if (origin) {
    const allowedOrigins = getAllowedOrigins();
    // Check if origin matches any allowed pattern
    const isAllowed = allowedOrigins.some((allowedOrigin) => {
      if (allowedOrigin.startsWith('*.')) {
        // Handle wildcard subdomains
        const domain = allowedOrigin.substring(2);
        // Extract hostname from origin URL if it has protocol
        const originHostname = origin.includes('://') ? new URL(origin).hostname : origin;
        return originHostname.endsWith(domain);
      }
      return origin === allowedOrigin;
    });
    if (isAllowed) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
    }
  }
  return corsHeaders;
}

// Helper function to create Response with CORS headers for browser endpoints
function createResponse(body, request, options = {}) {
  const corsHeaders = getCorsHeaders(request);
  const headers = {
    ...options.headers,
    ...corsHeaders,
  };
  return new Response(body, { ...options, headers });
}

// Helper function to create error Response with X-Error header
// Pass request for CORS-enabled endpoints, or null for non-CORS endpoints
function createErrorResponse(errorMessage, request, statusCode) {
  const headers = {
    'X-Error': errorMessage,
    ...(request ? getCorsHeaders(request) : {}),
  };
  return new Response(null, { status: statusCode, headers });
}

export async function setApiKey(env, org, site, apiKey) {
  try {
    if (!env || !env.SCHEDULER_KV) {
      console.error('KV binding is missing in the environment.');
      return false;
    }
    const kvConfigKey = `${org}--${site}--apiKey`;
    await env.SCHEDULER_KV.put(kvConfigKey, apiKey);
    console.log('API token set in KV: ', org, site);
    return true;
  } catch (err) {
    console.error('Error setting API key in KV: ', org, site, err);
    return false;
  }
}

export async function getApiKey(env, org, site) {
  try {
    if (!env || !env.SCHEDULER_KV) {
      console.error('KV binding is missing in the environment.');
      return null;
    }
    const kvConfigKey = `${org}--${site}--apiKey`;
    const apiKey = await env.SCHEDULER_KV.get(kvConfigKey);
    if (!apiKey) {
      return null;
    }
    return apiKey;
  } catch (err) {
    console.error('Error getting API key from KV: ', org, site, err);
    return null;
  }
}

export async function fetchSnapshotManifest(org, site, snapshot, apiKey) {
  const adminURL = `https://admin.hlx.page/snapshot/${org}/${site}/main/${snapshot}`;
  const resp = await fetch(adminURL, {
    method: 'GET',
    headers: {
      'X-Auth-Token': `${apiKey}`,
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
      console.log('Register Request: Invalid body. Please provide org, site and apiKey');
      return createErrorResponse('Invalid body. Please provide org, site and apiKey', null, 400);
    }
    const { org, site, apiKey } = data;
    if (!org || !site || !apiKey) {
      console.log('Register Request: Invalid body. Please provide org, site and apiKey');
      return createErrorResponse('Invalid body. Please provide org, site and apiKey', null, 400);
    }

    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      console.log('Register Request: No authorization token found');
      return createErrorResponse('Unauthorized', null, 401);
    }
    const authorized = await isAuthorized(authToken, org, site, true);
    if (!authorized) {
      console.log('Register Request: isAuthorized returned false');
      return createErrorResponse('Unauthorized', null, 401);
    }
    // set the api key for the org/site
    const success = await setApiKey(env, org, site, apiKey);
    if (!success) {
      console.log('Register Request: Failed to set API key');
      return createErrorResponse('Register Request failed: Internal server error', null, 500);
    }
    return new Response(null, { status: 200 });
  } catch (err) {
    console.error('Register Request failed: ', request, err);
    return createErrorResponse('Register Request failed: Internal server error', null, 500);
  }
}

export async function isRegistered(request, env) {
  const { org, site } = request.params;
  if (!org || !site) {
    return createErrorResponse('Invalid org or site', request, 400);
  }
  try {
    const apiKey = await getApiKey(env, org, site);
    if (!apiKey) {
      return createResponse(JSON.stringify({ registered: false }), request, {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }
    return createResponse(JSON.stringify({ registered: true }), request, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('isRegistered failed: ', org, site, err);
    return createErrorResponse('Internal server error', request, 500);
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
      return createErrorResponse('Invalid body. Please provide org, site, snapshotId, and scheduledPublish', request, 400);
    }

    const {
      org, site, snapshotId,
    } = data;
    if (!org || !site || !snapshotId) {
      console.log('Update Schedule Request: Invalid body. Please provide org, site and snapshotId');
      return createErrorResponse('Invalid body. Please provide org, site and snapshotId', request, 400);
    }

    // Get the snapshot details from the AEM Admin API
    const apiKey = await getApiKey(env, org, site);
    if (!apiKey) {
      console.log('Update Schedule Request: No API key found');
      return createErrorResponse('Org/site not registered', request, 404);
    }
    const snapshotManifest = await fetchSnapshotManifest(org, site, snapshotId, apiKey);
    if (!snapshotManifest) {
      console.log('Update Schedule Request: Could not get snapshot details');
      return createErrorResponse('Could not get snapshot details', request, 404);
    }
    const { scheduledPublish } = snapshotManifest.metadata;
    console.log('Update Schedule Request: Scheduled publish: ', scheduledPublish);
    // Validate scheduledPublish is a valid date
    const scheduledDate = new Date(scheduledPublish);
    if (Number.isNaN(scheduledDate.getTime())) {
      console.log('Update Schedule Request: Invalid scheduledPublish date format. Please provide a valid ISO date string');
      return createErrorResponse('Invalid scheduledPublish date format. Please provide a valid ISO date string', request, 400);
    }

    // Calculate minimum allowed time (5 minutes from now)
    const now = new Date();
    const minimumTime = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes in milliseconds

    if (scheduledDate < minimumTime) {
      const errorMessage = scheduledDate < now
        ? 'Scheduled publish is in the past'
        : 'Scheduled publish must be at least 5 minutes in the future';
      console.log(`Update Schedule Request: ${errorMessage}. Scheduled: ${scheduledPublish}, Minimum allowed: ${minimumTime.toISOString()}`);
      return createErrorResponse(errorMessage, request, 400);
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

    return createResponse(JSON.stringify({
      success: true,
      message: `Schedule updated for ${org}/${site}`,
      org,
      site,
      snapshotId,
    }), request, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Update schedule failed: ', request, err);
    return createErrorResponse('Update schedule failed: Internal server error', request, 500);
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
      return createErrorResponse('Invalid org or site', null, 400);
    }
    // Check authorization if specific org/site requested
    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      return createErrorResponse('Unauthorized', null, 401);
    }
    const authorized = await isAuthorized(authToken, org, site, false);
    if (!authorized) {
      return createErrorResponse('Unauthorized', null, 401);
    }

    let scheduleData = {};
    try {
      const existingSchedule = await env.R2_BUCKET.get('schedule.json');
      if (existingSchedule) {
        scheduleData = await existingSchedule.json();
      }
    } catch (err) {
      console.warn('Could not read schedule data:', err);
      return createErrorResponse('Could not retrieve schedule data', null, 500);
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
    return createErrorResponse('Get schedule failed: Internal server error', null, 500);
  }
}

// Create a new router
const router = IttyRouter();

// Handle preflight OPTIONS requests for browser endpoints only
router.options('/schedule', (request) => createResponse(null, request, { status: 204 }));
router.options('/register/:org/:site', (request) => createResponse(null, request, { status: 204 }));

router.post('/register', async (request, env) => registerRequest(request, env));
router.get('/register/:org/:site', async (request, env) => isRegistered(request, env));
router.post('/schedule', async (request, env) => updateSchedule(request, env));
router.get('/schedule/:org/:site', async (request, env) => getSchedule(request, env));
// catch all for invalid routes
router.all('*', () => createErrorResponse('404, not found!', null, 404));

// Wrapper that initializes global environment and routes requests
export default {
  async fetch(request, env, ctx) {
    globalEnv = env;
    return router.fetch(request, env, ctx);
  },
};
