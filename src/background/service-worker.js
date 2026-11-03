/**
 * Background service worker: the only place that talks to Hacker News.
 *
 * Content scripts ask for ready-to-render topics; responses are cached in
 * chrome.storage so a busy x.com tab (which re-injects on SPA navigations)
 * never hammers the API.
 */

import { fetchStories } from '../lib/hn.js';
import { buildTopics } from '../lib/topics.js';

const CACHE_KEY = 'hackerx:stories';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_STORIES = 80;

const DEFAULT_SETTINGS = { minPoints: 150, maxTopics: 12, sort: 'new' };

async function readCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return stored[CACHE_KEY] || null;
}

async function writeCache(payload) {
  await chrome.storage.local.set({ [CACHE_KEY]: payload });
  return payload;
}

function isFresh(entry) {
  return !!entry && Array.isArray(entry.stories) && Date.now() - entry.at < CACHE_TTL_MS;
}

/** Serialise concurrent requests so a burst only triggers one fetch. */
let inflight = null;

async function getStories({ force = false } = {}) {
  if (!force) {
    const cached = await readCache();
    if (isFresh(cached)) return { entry: cached, cached: true };
  }

  if (!inflight) {
    inflight = (async () => {
      try {
        const stories = await fetchStories({ hitsPerPage: MAX_STORIES, minPoints: 0 });
        return await writeCache({ at: Date.now(), stories });
      } finally {
        inflight = null;
      }
    })();
  }

  try {
    return { entry: await inflight, cached: false };
  } catch (err) {
    const stale = await readCache();
    if (stale && Array.isArray(stale.stories)) {
      return { entry: stale, cached: true, stale: true };
    }
    throw err;
  }
}

async function handleTopics(message) {
  const settings = { ...DEFAULT_SETTINGS, ...(message.settings || {}) };
  try {
    const { entry, cached, stale } = await getStories({ force: !!message.force });
    const stories = entry.stories.filter((s) => s.points >= settings.minPoints);
    return {
      ok: true,
      at: entry.at,
      cached: !!cached,
      stale: !!stale,
      total: stories.length,
      topics: buildTopics(stories, {
        maxTopics: settings.maxTopics,
        sort: settings.sort,
      }),
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'hackerx:topics') return false;
  handleTopics(message).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: String(err) }),
  );
  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => {
  // Warm the cache so the first x.com page load is instant.
  getStories({ force: true }).catch(() => {});
});
