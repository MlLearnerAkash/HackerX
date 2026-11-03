const KEY = 'hackerx:settings';
const DEFAULTS = {
  minPoints: 150,
  maxTopics: 12,
  sort: 'new',
  side: 'right',
  highlight: true,
};

const fields = {
  minPoints: document.getElementById('minPoints'),
  maxTopics: document.getElementById('maxTopics'),
  sort: document.getElementById('sort'),
  side: document.getElementById('side'),
  highlight: document.getElementById('highlight'),
};
const hint = document.getElementById('pts-hint');
const status = document.getElementById('status');

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function read() {
  return {
    minPoints: clamp(fields.minPoints.value, 0, 5000, DEFAULTS.minPoints),
    maxTopics: clamp(fields.maxTopics.value, 3, 40, DEFAULTS.maxTopics),
    sort: fields.sort.value === 'top' ? 'top' : 'new',
    side: fields.side.value === 'left' ? 'left' : 'right',
    highlight: !!fields.highlight.checked,
  };
}

async function readSettings() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    const stored = await chrome.storage.local.get(KEY);
    return stored[KEY] || {};
  }
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch (_) {
    return {};
  }
}

async function writeSettings(settings) {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    await chrome.storage.local.set({ [KEY]: settings });
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(settings));
}

async function save() {
  const settings = read();
  fields.minPoints.value = settings.minPoints;
  hint.textContent = String(settings.minPoints);
  await writeSettings(settings);
  status.textContent = 'Saved — x.com updates live.';
  window.setTimeout(() => {
    status.textContent = '';
  }, 1800);
}

async function init() {
  const settings = { ...DEFAULTS, ...(await readSettings()) };

  fields.minPoints.value = settings.minPoints;
  fields.maxTopics.value = settings.maxTopics;
  fields.sort.value = settings.sort;
  fields.side.value = settings.side;
  fields.highlight.checked = settings.highlight;
  hint.textContent = String(settings.minPoints);

  Object.values(fields).forEach((field) => {
    field.addEventListener('change', save);
  });
}

init();
