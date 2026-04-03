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
// eslint-disable-next-line no-unused-vars
let globalEnv = null;

// Get environment-specific allowed origins for CORS
function getAllowedOrigins() {
  const baseOrigins = [
    '*.aem.live',
    '*.aem.page',
    '*.da.live',
    'da.live',
    'http://localhost:3000',
    'http://localhost:6456',
  ];
  return baseOrigins;
}

// Function to check if origin is allowed and return appropriate CORS headers
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const corsHeaders = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

function resolveOrgSite(request, data) {
  const urlOrg = request.params?.org;
  const urlSite = request.params?.site;
  const bodyOrg = data?.org;
  const bodySite = data?.site;

  if ((urlOrg && bodyOrg && urlOrg !== bodyOrg) || (urlSite && bodySite && urlSite !== bodySite)) {
    return { error: 'URL org/site must match body org/site' };
  }

  return {
    org: urlOrg || bodyOrg,
    site: urlSite || bodySite,
  };
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
      Authorization: `token ${apiKey}`,
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
      return createErrorResponse('Invalid body. Please provide org, site and apiKey', request, 400);
    }
    const { org, site, error } = resolveOrgSite(request, data);
    if (error) {
      console.log(`Register Request: ${error}`);
      return createErrorResponse(error, request, 400);
    }
    const { apiKey } = data;
    if (!org || !site || !apiKey) {
      console.log('Register Request: Invalid body. Please provide org, site and apiKey');
      return createErrorResponse('Invalid body. Please provide org, site and apiKey', request, 400);
    }

    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      console.log('Register Request: No authorization token found');
      return createErrorResponse('Unauthorized', request, 401);
    }
    const authorized = await isAuthorized(authToken, org, site, true);
    if (!authorized) {
      console.log('Register Request: isAuthorized returned false');
      return createErrorResponse('Unauthorized', request, 401);
    }
    // set the api key for the org/site
    const success = await setApiKey(env, org, site, apiKey);
    if (!success) {
      console.log('Register Request: Failed to set API key');
      return createErrorResponse('Register Request failed: Internal server error', request, 500);
    }
    return createResponse(JSON.stringify({ success: true }), request, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Register Request failed: ', request, err);
    return createErrorResponse('Register Request failed: Internal server error', request, 500);
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
      console.log('Update Schedule Request: Invalid body. Please provide org, site and snapshotId');
      return createErrorResponse('Invalid body. Please provide org, site and snapshotId', request, 400);
    }

    const { org, site, error } = resolveOrgSite(request, data);
    if (error) {
      console.log(`Update Schedule Request: ${error}`);
      return createErrorResponse(error, request, 400);
    }
    const { snapshotId, approved = false, userId } = data;
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
    scheduleData[orgSiteKey][snapshotId] = {
      type: 'snapshot',
      scheduledPublish,
      approved,
      ...(userId && { userId }),
    };

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
 * Get the schedule data for a specific org/site.
 * When a `path` query parameter is provided, returns whether that path is
 * scheduled and, if so, its scheduledPublish time and userId.
 * Without the query parameter, returns the full schedule for the org/site.
 * @param {Object} request - The incoming request
 * @param {Object} env - The environment object
 */
export async function getSchedule(request, env) {
  try {
    const { org, site } = request.params;
    if (!org || !site) {
      return createErrorResponse('Invalid org or site', request, 400);
    }
    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      return createErrorResponse('Unauthorized', request, 401);
    }
    const authorized = await isAuthorized(authToken, org, site, false);
    if (!authorized) {
      return createErrorResponse('Unauthorized', request, 401);
    }

    let scheduleData = {};
    try {
      const existingSchedule = await env.R2_BUCKET.get('schedule.json');
      if (existingSchedule) {
        scheduleData = await existingSchedule.json();
      }
    } catch (err) {
      console.warn('Could not read schedule data:', err);
      return createErrorResponse('Could not retrieve schedule data', request, 500);
    }

    const orgSiteKey = `${org}--${site}`;
    const orgSiteData = scheduleData[orgSiteKey] || {};

    const queryPath = request.query?.path;
    if (queryPath) {
      const normalizedPath = queryPath.startsWith('/') ? queryPath : `/${queryPath}`;
      const entry = orgSiteData[normalizedPath];
      if (!entry) {
        return createResponse(JSON.stringify({
          scheduled: false,
          path: normalizedPath,
        }), request, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return createResponse(JSON.stringify({
        scheduled: true,
        path: normalizedPath,
        scheduledPublish: entry.scheduledPublish,
        userId: entry.userId,
        type: entry.type,
      }), request, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return createResponse(JSON.stringify({
      [orgSiteKey]: orgSiteData,
    }), request, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Get schedule failed: ', request, err);
    return createErrorResponse('Get schedule failed: Internal server error', request, 500);
  }
}

export async function hasPublishPermission(authToken, org, site, path) {
  const statusUrl = `https://admin.hlx.page/status/${org}/${site}/main${path}`;
  try {
    const resp = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `${authToken}`,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      console.log('Status API returned non-ok for publish permission check:', resp.status, resp.statusText);
      return false;
    }
    const data = await resp.json();
    const permissions = data?.live?.permissions || [];
    console.log('User permissions for this page:', path, 'Permissions:', permissions);
    return permissions.includes('write');
  } catch (err) {
    console.error('Error checking publish permission:', err);
    return false;
  }
}

/**
 * Schedule a page for publishing
 * @param {Object} request - The incoming request
 * @param {Object} env - The environment object
 */
export async function schedulePage(request, env) {
  try {
    const data = await request.json();
    if (!data) {
      console.log('Schedule Page Request: Invalid body. Please provide org, site, path, scheduledPublish, and userId');
      return createErrorResponse('Invalid body. Please provide org, site, path, scheduledPublish, and userId', request, 400);
    }

    const { org, site, error } = resolveOrgSite(request, data);
    if (error) {
      console.log(`Schedule Page Request: ${error}`);
      return createErrorResponse(error, request, 400);
    }
    const { path, scheduledPublish, userId } = data;
    if (!org || !site || !path || !scheduledPublish || !userId) {
      console.log('Schedule Page Request: Invalid body. Please provide org, site, path, scheduledPublish, and userId');
      return createErrorResponse('Invalid body. Please provide org, site, path, scheduledPublish, and userId', request, 400);
    }
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    // Check org/site is registered
    const apiKey = await getApiKey(env, org, site);
    if (!apiKey) {
      console.log('Schedule Page Request: No API key found');
      return createErrorResponse('Org/site not registered', request, 404);
    }

    // Check the user has publish permission for this path
    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      console.log('Schedule Page Request: No authorization token found');
      return createErrorResponse('Unauthorized', request, 401);
    }
    const canPublish = await hasPublishPermission(authToken, org, site, normalizedPath);
    if (!canPublish) {
      console.log(`Schedule Page Request: User does not have publish permission for ${normalizedPath}`);
      return createErrorResponse('Forbidden: you do not have publish permission for this page', request, 403);
    }

    // Validate scheduledPublish is a valid date >= 5 minutes in future
    const scheduledDate = new Date(scheduledPublish);
    if (Number.isNaN(scheduledDate.getTime())) {
      console.log('Schedule Page Request: Invalid scheduledPublish date format. Please provide a valid ISO date string');
      return createErrorResponse('Invalid scheduledPublish date format. Please provide a valid ISO date string', request, 400);
    }

    const now = new Date();
    const minimumTime = new Date(now.getTime() + 5 * 60 * 1000);

    if (scheduledDate < minimumTime) {
      const errorMessage = scheduledDate < now
        ? 'Scheduled publish is in the past'
        : 'Scheduled publish must be at least 5 minutes in the future';
      console.log(`Schedule Page Request: ${errorMessage}. Scheduled: ${scheduledPublish}, Minimum allowed: ${minimumTime.toISOString()}`);
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

    // Update the schedule with the new page entry
    scheduleData[orgSiteKey][normalizedPath] = {
      type: 'page',
      scheduledPublish,
      userId,
    };

    // Store the updated schedule back to R2
    await env.R2_BUCKET.put('schedule.json', JSON.stringify(scheduleData, null, 2));

    console.log(`Page schedule updated for ${orgSiteKey}: ${normalizedPath} -> ${scheduledPublish}`);

    // add an entry to the audit log
    const auditLogResponse = await fetch(`https://admin.hlx.page/log/${org}/${site}/main`, {
      method: 'POST',
      headers: {
        Authorization: `${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        entries: [{
          timestamp: Date.now(),
          route: 'scheduled-publish',
          path: normalizedPath,
          user: userId,
        }],
      }),
    }).catch((err) => console.error('Failed to post audit log:', err));
    if (auditLogResponse && !auditLogResponse.ok) {
      console.error('Failed to post audit log:', auditLogResponse.status, auditLogResponse.statusText);
    }
    return createResponse(JSON.stringify({
      success: true,
      message: `Page schedule updated for ${org}/${site}`,
      org,
      site,
      path: normalizedPath,
    }), request, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Schedule page failed: ', request, err);
    return createErrorResponse('Schedule page failed: Internal server error', request, 500);
  }
}

/**
 * Delete a scheduled page publish.
 * Route: DELETE /schedule/page/:org/:site/:path+
 * The greedy param captures the page path (which may contain slashes).
 * @param {Object} request - The incoming request
 * @param {Object} env - The environment object
 */
export async function deletePageSchedule(request, env) {
  try {
    const { org, site, path: pagePath } = request.params;
    if (!org || !site || !pagePath) {
      return createErrorResponse('Invalid URL. Expected /schedule/page/:org/:site/:path', request, 400);
    }
    const normalizedPath = pagePath.startsWith('/') ? pagePath : `/${pagePath}`;

    const apiKey = await getApiKey(env, org, site);
    if (!apiKey) {
      return createErrorResponse('Org/site not registered', request, 404);
    }

    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      return createErrorResponse('Unauthorized', request, 401);
    }
    const canPublish = await hasPublishPermission(authToken, org, site, normalizedPath);
    if (!canPublish) {
      return createErrorResponse('Forbidden: you do not have publish permission for this page', request, 403);
    }

    let scheduleData = {};
    try {
      const existingSchedule = await env.R2_BUCKET.get('schedule.json');
      if (existingSchedule) {
        scheduleData = await existingSchedule.json();
      }
    } catch (err) {
      console.warn('Could not read existing schedule data:', err);
      return createErrorResponse('Could not retrieve schedule data', request, 500);
    }

    const orgSiteKey = `${org}--${site}`;
    if (!scheduleData[orgSiteKey] || !scheduleData[orgSiteKey][normalizedPath]) {
      return createErrorResponse('No schedule found for this path', request, 404);
    }

    delete scheduleData[orgSiteKey][normalizedPath];

    if (Object.keys(scheduleData[orgSiteKey]).length === 0) {
      delete scheduleData[orgSiteKey];
    }

    await env.R2_BUCKET.put('schedule.json', JSON.stringify(scheduleData, null, 2));

    console.log(`Page schedule deleted for ${orgSiteKey}: ${normalizedPath}`);

    const auditLogResponse = await fetch(`https://admin.hlx.page/log/${org}/${site}/main`, {
      method: 'POST',
      headers: {
        Authorization: `${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        entries: [{
          timestamp: Date.now(),
          route: 'deleted-scheduled-publish',
          path: normalizedPath,
        }],
      }),
    }).catch((err) => console.error('Failed to post audit log:', err));
    if (auditLogResponse && !auditLogResponse.ok) {
      console.error('Failed to post audit log:', auditLogResponse.status, auditLogResponse.statusText);
    }

    return createResponse(JSON.stringify({
      success: true,
      message: `Page schedule deleted for ${org}/${site}`,
      org,
      site,
      path: normalizedPath,
    }), request, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Delete page schedule failed: ', request, err);
    return createErrorResponse('Delete page schedule failed: Internal server error', request, 500);
  }
}

/**
 * Delete a scheduled snapshot publish.
 * Route: DELETE /schedule/snapshot/:org/:site/:snapshotId+
 * The greedy param captures the snapshot ID (which may contain slashes).
 * @param {Object} request - The incoming request
 * @param {Object} env - The environment object
 */
export async function deleteSnapshotSchedule(request, env) {
  try {
    const { org, site, snapshotId } = request.params;
    if (!org || !site || !snapshotId) {
      return createErrorResponse('Invalid URL. Expected /schedule/snapshot/:org/:site/:snapshotId', request, 400);
    }

    const apiKey = await getApiKey(env, org, site);
    if (!apiKey) {
      return createErrorResponse('Org/site not registered', request, 404);
    }

    const authToken = request.headers.get('Authorization');
    if (!authToken) {
      return createErrorResponse('Unauthorized', request, 401);
    }
    const authorized = await isAuthorized(authToken, org, site, false);
    if (!authorized) {
      return createErrorResponse('Unauthorized', request, 401);
    }

    let scheduleData = {};
    try {
      const existingSchedule = await env.R2_BUCKET.get('schedule.json');
      if (existingSchedule) {
        scheduleData = await existingSchedule.json();
      }
    } catch (err) {
      console.warn('Could not read existing schedule data:', err);
      return createErrorResponse('Could not retrieve schedule data', request, 500);
    }

    const orgSiteKey = `${org}--${site}`;
    if (!scheduleData[orgSiteKey] || !scheduleData[orgSiteKey][snapshotId]) {
      return createErrorResponse('No schedule found for this snapshot', request, 404);
    }

    delete scheduleData[orgSiteKey][snapshotId];

    if (Object.keys(scheduleData[orgSiteKey]).length === 0) {
      delete scheduleData[orgSiteKey];
    }

    await env.R2_BUCKET.put('schedule.json', JSON.stringify(scheduleData, null, 2));

    console.log(`Snapshot schedule deleted for ${orgSiteKey}: ${snapshotId}`);

    return createResponse(JSON.stringify({
      success: true,
      message: `Snapshot schedule deleted for ${org}/${site}`,
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
    console.error('Delete snapshot schedule failed: ', request, err);
    return createErrorResponse('Delete snapshot schedule failed: Internal server error', request, 500);
  }
}

// Create a new router
const router = IttyRouter();

// Handle preflight OPTIONS requests for browser endpoints only
router.options('/register', (request) => createResponse(null, request, { status: 204 }));
router.options('/register/:org/:site', (request) => createResponse(null, request, { status: 204 }));
router.options('/schedule', (request) => createResponse(null, request, { status: 204 }));
router.options('/schedule/:org/:site', (request) => createResponse(null, request, { status: 204 }));
router.options('/schedule/page', (request) => createResponse(null, request, { status: 204 }));
router.options('/schedule/page/:org/:site/:path+', (request) => createResponse(null, request, { status: 204 }));
router.options('/schedule/page/:org/:site', (request) => createResponse(null, request, { status: 204 }));
router.options('/schedule/snapshot/:org/:site/:snapshotId+', (request) => createResponse(null, request, { status: 204 }));
router.options('/schedule/snapshot/:org/:site', (request) => createResponse(null, request, { status: 204 }));

router.post('/register', async (request, env) => registerRequest(request, env)); // old route for register
router.post('/register/:org/:site', async (request, env) => registerRequest(request, env)); // new route for register
router.get('/register/:org/:site', async (request, env) => isRegistered(request, env));
router.post('/schedule', async (request, env) => updateSchedule(request, env)); // old route for schedule snapshot
router.post('/schedule/page', async (request, env) => schedulePage(request, env)); // old route for schedule page
router.post('/schedule/page/:org/:site', async (request, env) => schedulePage(request, env)); // new route for schedule page
router.post('/schedule/snapshot/:org/:site', async (request, env) => updateSchedule(request, env)); // new route for schedule snapshot
router.delete('/schedule/page/:org/:site/:path+', async (request, env) => deletePageSchedule(request, env));
router.delete('/schedule/snapshot/:org/:site/:snapshotId+', async (request, env) => deleteSnapshotSchedule(request, env));
router.get('/schedule/:org/:site', async (request, env) => getSchedule(request, env));
// catch all for invalid routes
router.all('*', (request) => createErrorResponse('404, not found!', request, 404));

// Wrapper that initializes global environment and routes requests
export default {
  async fetch(request, env, ctx) {
    globalEnv = env;
    return router.fetch(request, env, ctx);
  },
};
