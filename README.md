# linkedin-sync

LinkedIn profile data → JSON files in this repo → consumed live by my portfolio site.

Sync is triggered by a **browser bookmarklet** I click while logged in to LinkedIn. It runs in my own browser session, calls LinkedIn's internal API the same way the LinkedIn website does, and commits the resulting JSON to this repo via the GitHub API. No server-side scraping, no cloud-IP anti-bot triggers.

**Setup + instructions:** https://at0m-b0mb.github.io/linkedin-sync/

## Output files

| File              | Contents                                                |
|-------------------|---------------------------------------------------------|
| `profile.json`    | Name, headline, picture, profile URL, `synced_at`       |
| `experience.json` | Positions: title, company, dates, location, description |

## How my website consumes it

```js
const base = 'https://raw.githubusercontent.com/at0m-b0mb/linkedin-sync/main';
const [profile, experience] = await Promise.all([
  fetch(`${base}/profile.json`).then(r => r.json()),
  fetch(`${base}/experience.json`).then(r => r.json()),
]);
```

`raw.githubusercontent.com` serves CORS-friendly responses, so this works from any frontend without a proxy.

## Why a bookmarklet instead of a cron-driven scraper

I tried server-side scraping from GitHub Actions first. LinkedIn aggressively flags requests from cloud IPs — typically after 1–2 calls the session is invalidated even with valid cookies. The bookmarklet bypasses this entirely because it runs in my real browser session, originating from `linkedin.com` itself, indistinguishable from the LinkedIn web app's own requests.

## Why the previous attempt failed (notes for future-me)

- `linkedin-api` Python library uses `/identity/profiles/{vanity}/profileView` — LinkedIn killed that endpoint.
- Cookie auth works for ~1 call from a GitHub Actions IP, then `/voyager/*` returns 302 self-redirects (anti-bot flag).
- The library's GraphQL `queryId` rotates server-side; hardcoding any value will eventually break.

Bookmarklet sidesteps all three.
