/**
 * Turns Hacker News story titles into X (Twitter) search topics.
 *
 * The rules are deliberately deterministic and inspectable: title cleanup ->
 * token scoring -> 2-3 salient terms -> X search query. No network, no model.
 */

const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below
   between both but by can cannot could did do does doing down during each few for from further had has
   have having he her here hers herself him himself his how i if in into is it its itself just me more
   most my myself no nor not now of off on once only or other our ours ourselves out over own same she
   should so some such than that the their theirs them themselves then there these they this those
   through to too under until up very was we were what when where which while who whom why will with
   would you your yours yourself yourselves
   show ask tell launch launches launched using use used gets get make makes made into via vs versus
   vs. week weeks year years day days today new now news
   hacker hackers hn ycombinator
   era times become became becomes talk talking talked without making take took takes taken
   give gave given come came comes going went want wants need needs know knows knew said says
   think thinks think look looks look find finds found keep keeps work works worked call calls
   called try tries allow allows help helps build builds built run runs running release released
   still almost about much many version edition`
    .split(/\s+/)
    .filter(Boolean),
);

/** Words that are true but too generic to search X for on their own. */
const BROAD = new Set(
  `ai llm llms app apps code coding software tech technology startup startups programming developer
   developers dev devs computer computers compute computing data web internet platform platforms tool
   tools product products model models system systems open source github blog post posts article
   articles opinion review guide tutorial introduction beginner beginners simple better best worst
   inside behind first second third thing things stuff`
    .split(/\s+/)
    .filter(Boolean),
);

const TRAILING_SITE = /\s+[|·–—]\s+[^|·–—]{1,32}$|\s+-\s+[A-Za-z0-9 .&']{1,28}$/;
const PREFIXES = /^(show|ask|tell)\s+hn\s*:\s*/i;

/** Strip "Show HN:", trailing publication names and stray punctuation. */
export function cleanTitle(title) {
  let out = String(title || '').trim();
  out = out.replace(PREFIXES, '');
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(TRAILING_SITE, '').trim();
    if (next === out || next.length < 12) break;
    out = next;
  }
  return out.replace(/[\s\-–—:|,;.!?]+$/g, '').trim();
}

/**
 * Score the words of a title so the query keeps names, versions and jargon
 * and drops filler.
 */
export function salientTokens(title, limit = 3) {
  const cleaned = cleanTitle(title);
  const words = cleaned
    .replace(/[«»'"“”‘’()[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const scored = [];
  words.forEach((word, index) => {
    // Keep + and # at the edges: "C++" and "C#" are the topic, not punctuation.
    const bare = word.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, '');
    if (bare.length < 2) return;
    const lower = bare.toLowerCase();
    if (STOPWORDS.has(lower)) return;

    let score = 0;
    if (BROAD.has(lower)) score -= 4;
    if (/\d/.test(bare)) score += 3; // GPT-5, iOS 26, Rust 1.9
    if (/[+#]/.test(bare)) score += 3; // C++, C#
    if (/\p{Lu}/u.test(bare.slice(1))) score += 2; // internal caps: OpenAI, iPhone
    if (index === 0 && /^\p{Lu}/u.test(bare)) score += 1;
    if (/^\p{Lu}/u.test(bare) && index > 0) score += 2; // proper noun
    score += Math.min(bare.length, 12) / 6; // long words are usually specific
    if (bare.includes('-')) score += 1;

    scored.push({ text: bare, lower, score, index });
  });

  const chosen = [];
  for (const token of scored.filter((t) => t.score > 0).sort((a, b) => b.score - a.score)) {
    // "New York Times … Times-inspired" must not yield "Times … Times".
    const clashes = chosen.some(
      (kept) => kept.lower === token.lower || kept.lower.slice(0, 5) === token.lower.slice(0, 5),
    );
    if (clashes) continue;
    chosen.push(token);
    if (chosen.length === limit) break;
  }

  if (chosen.length) {
    return chosen.sort((a, b) => a.index - b.index).map((t) => t.text);
  }

  return words
    .map((w) => w.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, limit);
}

/** Terms searched on X. Quoted when they contain X search operators. */
function xTerm(token) {
  return /[+#:()"]/.test(token) ? `"${token}"` : token;
}

/**
 * Build the X search query for a story.
 * `-filter:retweets` keeps the timeline readable; `f=live` (applied at link
 * level) is what makes X order results newest first.
 */
export function toQuery(title) {
  const tokens = salientTokens(title);
  const core = tokens.length ? tokens.map(xTerm).join(' ') : cleanTitle(title).slice(0, 60);
  return `${core} -filter:retweets`.trim();
}

/** Live search URL: same search UI as x.com, sorted newest first. */
export function toSearchUrl(query, base = 'https://x.com') {
  const params = new URLSearchParams({ q: query, src: 'typed_query', f: 'live' });
  return `${base}/search?${params.toString()}`;
}

function relTime(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.round(diff / 60000);
  if (min < 60) return `${Math.max(1, min)}m`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function formatRelative(ms) {
  return relTime(ms);
}

export function formatCount(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(n);
}

/**
 * Story list -> display topics.
 * @param {Array} stories normalised stories from hn.js
 * @param {{maxTopics?: number, sort?: 'new'|'top', baseUrl?: string}} options
 */
export function buildTopics(stories, options = {}) {
  const { maxTopics = 12, sort = 'new', baseUrl = 'https://x.com' } = options;
  const list = Array.isArray(stories) ? stories.slice() : [];

  list.sort(sort === 'top'
    ? (a, b) => b.points - a.points
    : (a, b) => b.createdAt - a.createdAt);

  const seen = new Set();
  const topics = [];

  for (const story of list) {
    const query = toQuery(story.title);
    const key = query.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const tokens = salientTokens(story.title);
    topics.push({
      id: story.id,
      title: cleanTitle(story.title) || story.title,
      query,
      // Lower-cased keywords used by the timeline badge matcher.
      keywords: tokens.map((t) => t.toLowerCase()).filter((t) => t.length > 2),
      searchUrl: toSearchUrl(query, baseUrl),
      hnUrl: story.hnUrl,
      points: story.points,
      comments: story.comments,
      createdAt: story.createdAt,
      age: relTime(story.createdAt),
    });

    if (topics.length >= maxTopics) break;
  }

  return topics;
}

export const TOPIC_DEFAULTS = {
  maxTopics: 12,
  sort: 'new',
};
