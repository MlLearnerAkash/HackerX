# HackerX

A Chrome extension that docks a panel on x.com listing **what Hacker News is talking about right now**, newest first. Each row opens X's own live search for that topic, so the posts you land on are native x.com results, ordered newest first (`f=live`).

## Install

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder (`HackerX`).
4. Reload any open x.com tab. Pin the extension so the settings popup is one click away.

## What you get

- **Dock** on x.com / twitter.com: the Hacker News front page converted into search topics, with points, comment counts and story age.
- **Newest first by default.** Rows sort by HN post time; the "Top" toggle sorts by points. Clicking a row opens `x.com/search?q=…&f=live`, which X renders newest-first.
- **Filter box** to narrow the list, and a "New" / "Top" order switch.
- **Timeline badges.** Posts in your timeline that match a live HN topic get a small `HN · N pts` chip linking to that topic's search. Toggle in the popup.
- **Draggable.** Grab the header to move the dock off x.com's right column; double-click the header to snap it back. Position is remembered.
- **Collapsible.** The close button shrinks it to a pill; Escape also hides it.

## Settings (toolbar popup)

| Setting | Meaning |
| --- | --- |
| Minimum points | Hide HN stories below this score (default 150). |
| Topics in the dock | How many rows to show (default 12). |
| Default order | Newest HN post first, or most points first. |
| Dock side | Initial corner when nothing has been dragged. |
| Badge matching timeline posts | Add the `HN · N pts` chip to matching posts. |

## How it works

```
x.com content script (src/content/ui.js)
        │  chrome.runtime.sendMessage
        ▼
service worker (src/background/service-worker.js)
        │  5-minute cache in chrome.storage.local
        ▼
Hacker News Algolia API  →  src/lib/hn.js   (normalise stories)
        │
        ▼
src/lib/topics.js  →  title → search query  →  x.com/search?f=live
```

Nothing is scraped from x.com and no X API is called. The extension never reads your account data; X renders the posts itself once the search tab opens. There is no build step — plain ES modules and a classic content script.

### Topic extraction

`src/lib/topics.js` is deterministic and inspectable: strip `Show HN:` prefixes and trailing publication names, drop stopwords, then score the remaining words (versions, digits, `C++`-style operators, proper nouns, length) and keep the best two or three. The query is those terms joined with `-filter:retweets`. Hover a row to see the exact query it will run.

## Development

`dev/harness.html` is a fake x.com timeline that loads the real content script with `chrome.*` absent — the dock then fetches Hacker News directly, so UI work needs no logged-in session.

```bash
./dev/serve.sh          # http://localhost:8765/dev/harness.html
python3 dev/make-icons.py   # regenerate icons/
```

In the harness, clicks are intercepted and logged to the console instead of navigating to x.com.

## Limitations

- X requires a logged-in session for search results; the dock works either way, but a logged-out tab shows the login wall.
- Topic queries are heuristics. Occasional filler words survive (e.g. an odd proper noun); the filter box and the "Top" sort are the escape hatches.
- The badge matcher looks for two shared keywords, so it can miss short posts and can occasionally over-match a common word.
- `x.com` ships frequent DOM changes; the timeline badge relies on `article[data-testid="tweet"]`. If badges stop appearing, that selector is the first place to look. The dock itself does not depend on X's markup.
