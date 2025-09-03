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

/**
 * Register the incoming request by creating a folder in the R2 bucket
 * @param {Object} env - The environment object
 * @param {string} org - The organization
 * @param {string} site - The site
 */
async function registerRequest(env, org, site) {
  try {
    // first check if the folder already exists
    const folder = await env.R2_BUCKET.get(`registered/${org}--${site}`);
    if (folder) {
      console.debug('Register Request: ', org, site, 'Folder already exists');
      return 'Folder already exists';
    }
    await env.R2_BUCKET.put(`registered/${org}--${site}`, `{ "org": "${org}", "site": "${site}" }`);
    return 'Folder created';
  } catch (err) {
    console.error('Register Request failed: ', org, site, err);
    throw err;
  }
}

export default {
  async fetch(request, env) {
    try {
      const requestUrl = new URL(request.url);
      // register the incoming request by creating a folder in the R2 bucket
      // Only allow posts to the /register endpoint
      if (requestUrl.pathname !== '/register') {
        return new Response('Not found', { status: 404 });
      }
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      if (!request.body) {
        return new Response('No body', { status: 400 });
      }
      const data = await request.json();
      const { org, site } = data;
      if (!org || !site) {
        return new Response('Invalid body. Please provide org and site', { status: 400 });
      }
      try {
        const result = await registerRequest(env, org, site);
        if (result === 'Folder already exists') {
          return new Response('This org/site has already been registered', { status: 200 });
        }
        return new Response('Registration successful!', { status: 200 });
      } catch (err) {
        console.error('Registration failed: ', org, site, err);
        return new Response(`Registration failed: ${err.message}`, { status: 500 });
      }
    } catch (err) {
      console.error('Registration failed: ', request.url, err);
      return new Response(`Registration failed: ${err.message}`, { status: 500 });
    }
  },
};
