# linkedin-sync

Auto-syncs my LinkedIn profile data into JSON files in this repo, so my personal website can render it live without me having to update anything by hand.

A GitHub Action runs every Monday, scrapes the profile via the LinkedIn Voyager API (cookie auth), and commits the updated JSON back to `main`. My site fetches the files from `raw.githubusercontent.com` on every page load — the data is always at most a week stale, and never stale at all relative to what GitHub has.

## Output files

| File              | Contents                                                  |
|-------------------|-----------------------------------------------------------|
| `profile.json`    | Name, headline, about, location, picture URL              |
| `experience.json` | Positions: title, company, dates, location, description   |
| `education.json`  | Schools: degree, field, dates                             |
| `skills.json`     | Endorsed skills                                           |

## How the website consumes it

```js
// On any page, fetch the live data:
const base = 'https://raw.githubusercontent.com/at0m-b0mb/linkedin-sync/main';

const [profile, experience, education, skills] = await Promise.all([
  fetch(`${base}/profile.json`).then(r => r.json()),
  fetch(`${base}/experience.json`).then(r => r.json()),
  fetch(`${base}/education.json`).then(r => r.json()),
  fetch(`${base}/skills.json`).then(r => r.json()),
]);
```

`raw.githubusercontent.com` serves CORS-friendly responses, so this works from any frontend — no proxy needed.

## Setting up the secrets

LinkedIn challenges email/password logins from cloud IPs almost immediately. We auth with browser session cookies instead.

1. Log in to <https://linkedin.com> in your browser.
2. Open DevTools → **Application** → **Cookies** → `https://www.linkedin.com`.
3. Copy two cookie values:
   - `li_at`
   - `JSESSIONID` (the value will look like `"ajax:1234567890..."` — copy it including or excluding the quotes, both work).
4. In this repo go to **Settings → Secrets and variables → Actions** and add:
   - `LINKEDIN_LI_AT`
   - `LINKEDIN_JSESSIONID`
5. (Optional) Add a repo variable `LINKEDIN_PROFILE_ID` if your vanity URL is not `kailash-parshad`.

Cookies survive roughly a year. When the workflow starts failing with an auth error, repeat these steps with fresh values.

## Running locally

```bash
pip install -r requirements.txt
export LINKEDIN_LI_AT='...'
export LINKEDIN_JSESSIONID='...'
python scripts/sync_linkedin.py
```

## Why weekly?

LinkedIn aggressively rate-limits scrapers, and profile content changes infrequently anyway. Weekly cron + manual `workflow_dispatch` gives the freshness without burning the session. The website itself is always live — only the underlying data file refreshes weekly.

## Notes

- This uses the unofficial [`linkedin-api`](https://pypi.org/project/linkedin-api/) Python library, which talks to LinkedIn's internal Voyager API. It is not endorsed by LinkedIn and may break if they change endpoints.
- If a sync run fails, the existing JSON files are **not** overwritten — the site keeps showing the last good data instead of breaking.
