/*
 * Copyright 2026 Adobe. All rights reserved.
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
 * Append records to the dated file `${folder}/${YYYY-MM-DD}.json` (one R2 read + write).
 * @param {Object} env - The environment object
 * @param {string} folder - e.g. 'completed' or 'failed'
 * @param {Array} records - Records to append
 */
export async function appendToDailyFile(env, folder, records) {
  const today = new Date().toISOString().split('T')[0];
  const fileName = `${folder}/${today}.json`;
  let existing = [];
  try {
    const obj = await env.R2_BUCKET.get(fileName);
    if (obj) {
      existing = await obj.json();
    }
  } catch (err) {
    console.log(`No existing ${folder} data for today, starting fresh`);
  }
  existing.push(...records);
  await env.R2_BUCKET.put(fileName, JSON.stringify(existing, null, 2));
}

/**
 * Remove entries from schedule.json (one R2 read + write). Throws on R2 errors.
 * @param {Object} env - The environment object
 * @param {Array} entries - Array of {org, site, path}
 */
export async function removeFromSchedule(env, entries) {
  const scheduleData = await env.R2_BUCKET.get('schedule.json');
  if (!scheduleData) {
    console.log('No schedule data found');
    return;
  }
  const schedule = await scheduleData.json();
  for (const { org, site, path } of entries) {
    const orgSiteKey = `${org}--${site}`;
    if (schedule[orgSiteKey] && schedule[orgSiteKey][path]) {
      delete schedule[orgSiteKey][path];
      if (Object.keys(schedule[orgSiteKey]).length === 0) {
        delete schedule[orgSiteKey];
      }
    } else {
      console.warn(`Entry ${path} not found in schedule.json for ${orgSiteKey}`);
    }
  }
  await env.R2_BUCKET.put('schedule.json', JSON.stringify(schedule, null, 2));
}
