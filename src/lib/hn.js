/**
 * Hacker News data access.
 *
 * Uses the Algolia HN Search API (public, CORS-enabled, no key) because it
 * returns points + comment counts in the same payload as the story metadata.
 * The Firebase API is the fallback when Algolia is unavailable.
 */

const ALGOLIA = 'https://hn.algolia.com/api/v1';
const FIREBASE = 'https://hacker-news.firebaseio.com/v0';

const DEFAULTS = {
  hitsPerPage: 80,
  // A story still needs some oxygen before it is worth a post suggestion.
  minPoints: 100,
  timeoutMs: 8000,
};

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getJson(url, timeoutMs) {
  const res = await withTimeout(fetch(url, { credentials: 'omit' }), timeoutMs, url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Normalise one Algolia hit into the shape the rest of the extension speaks. */
export function normalizeHit(hit) {
  const id = String(hit.objectID || hit.story_id || '');
  if (!id) return null;

  const createdAt = Date.parse(hit.created_at || hit.created_at_i * 1000 || '');
  return {
    id,
    title: String(hit.title || hit.story_title || '').trim(),
    url: hit.url || hit.story_url || `https://news.ycombinator.com/item?id=${id}`,
    hnUrl: `https://news.ycombinator.com/item?id=${id}`,
    author: hit.author || '',
    points: toInt(hit.points),
    comments: toInt(hit.num_comments),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  };
}

async function fromAlgolia(minPoints, hitsPerPage, timeoutMs) {
  const params = new URLSearchParams({
    tags: 'front_page',
    hitsPerPage: String(hitsPerPage),
  });
  const data = await getJson(`${ALGOLIA}/search?${params}`, timeoutMs);
  const hits = Array.isArray(data.hits) ? data.hits : [];
  return hits
    .map(normalizeHit)
    .filter((s) => s && s.title && s.points >= minPoints);
}

async function fromFirebase(minPoints, limit, timeoutMs) {
  const ids = await getJson(`${FIREBASE}/topstories.json`, timeoutMs);
  const wanted = (Array.isArray(ids) ? ids : []).slice(0, limit);
  const items = await Promise.all(
    wanted.map((id) =>
      getJson(`${FIREBASE}/item/${id}.json`, timeoutMs).catch(() => null),
    ),
  );
  return items
    .filter((it) => it && !it.deleted && !it.dead && it.title)
    .map((it) =>
      normalizeHit({
        objectID: it.id,
        title: it.title,
        url: it.url,
        author: it.by,
        points: it.score,
        num_comments: it.descendants,
        created_at_i: it.time,
      }),
    )
    .filter((s) => s && s.points >= minPoints);
}

/**
 * Current Hacker News front page, filtered and de-duplicated.
 * @param {{minPoints?: number, hitsPerPage?: number, timeoutMs?: number}} options
 * @returns {Promise<Array>} stories sorted newest first
 */
export async function fetchStories(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  let stories;
  let source = 'algolia';

  try {
    stories = await fromAlgolia(opts.minPoints, opts.hitsPerPage, opts.timeoutMs);
  } catch (err) {
    source = 'firebase';
    stories = await fromFirebase(opts.minPoints, opts.hitsPerPage, opts.timeoutMs);
  }

  const seen = new Set();
  const unique = [];
  for (const story of stories) {
    if (!story || seen.has(story.id)) continue;
    // HN re-submits the same link constantly; keep the strongest instance.
    const key = `${story.title.toLowerCase()}::${story.url}`;
    if (seen.has(key)) continue;
    seen.add(story.id);
    seen.add(key);
    unique.push(story);
  }

  unique.sort((a, b) => b.createdAt - a.createdAt);
  unique.source = source;
  return unique;
}

export const HN_SOURCE_LABEL = 'Hacker News';
