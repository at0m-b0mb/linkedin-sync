#!/usr/bin/env python3
"""
Fetch LinkedIn profile data and write JSON files consumed by the portfolio site.

Authentication uses session cookies, NOT email/password. LinkedIn challenges
email/password logins from cloud IPs (GitHub Actions) almost immediately, so
cookie-based auth is the only thing that survives in CI.

Required GitHub secrets:
  LINKEDIN_LI_AT        — value of the `li_at` cookie from your browser
  LINKEDIN_JSESSIONID   — value of the `JSESSIONID` cookie from your browser

How to get them:
  1. Log in to https://linkedin.com in your browser.
  2. Open DevTools → Application → Cookies → https://www.linkedin.com
  3. Copy `li_at` and `JSESSIONID` values into GitHub Actions secrets.
  4. Cookies expire roughly every year — refresh when the workflow starts failing.

Outputs (repo root):
  profile.json     — name, headline, picture, profile URL
  experience.json  — list of positions

If LinkedIn returns an empty or error response, the script exits non-zero
WITHOUT touching the existing JSON files. The portfolio site keeps showing
the last good data instead of breaking.

Endpoints used:
  /voyager/api/me                                 — identity (still works)
  /voyager/api/graphql?...sectionType:experience  — experience (still works)

The older /identity/profiles/{vanity}/profileView endpoint is dead — LinkedIn
returns an error structure that breaks the linkedin-api library's parser. We
avoid it entirely by going through the URN-based GraphQL path.
"""

import json
import os
import re
import sys
from pathlib import Path

try:
    from linkedin_api import Linkedin
    from requests.cookies import RequestsCookieJar
except ImportError:
    print("ERROR: dependencies missing. Run: pip install -r requirements.txt")
    sys.exit(1)


PROFILE_ID = os.environ.get("LINKEDIN_PROFILE_ID", "kailash-parshad").strip()
REPO_ROOT = Path(__file__).resolve().parent.parent


def clean(text):
    if not text:
        return ""
    return re.sub(r"\s+", " ", str(text)).strip()


def build_cookie_jar(li_at, jsessionid):
    jar = RequestsCookieJar()
    jar.set("li_at", li_at, domain=".linkedin.com", path="/")
    # JSESSIONID MUST be sent to LinkedIn wrapped in literal double-quotes —
    # that's how LinkedIn issues it. Browsers may show the value with or
    # without quotes; normalize so it always has them on the wire.
    js = jsessionid.strip('"')
    jar.set("JSESSIONID", f'"{js}"', domain=".linkedin.com", path="/")
    return jar


def authenticate():
    li_at = os.environ.get("LINKEDIN_LI_AT", "").strip()
    jsess = os.environ.get("LINKEDIN_JSESSIONID", "").strip()

    if not li_at or not jsess:
        print("ERROR: LINKEDIN_LI_AT and LINKEDIN_JSESSIONID must be set.")
        print("See scripts/sync_linkedin.py docstring for how to obtain them.")
        sys.exit(1)

    print("Authenticating with LinkedIn via session cookies...")
    try:
        return Linkedin("", "", cookies=build_cookie_jar(li_at, jsess))
    except Exception as e:
        print(f"ERROR: cookie authentication failed — {e}")
        print("Your cookies are likely expired. Refresh them from your browser.")
        sys.exit(1)


def fetch_me(api):
    """Hit /voyager/api/me to get identity info + URN.

    This is the only endpoint we can rely on for identity since LinkedIn
    killed /identity/profiles/{vanity}/profileView.
    """
    res = api.client.session.get(
        "https://www.linkedin.com/voyager/api/me",
        allow_redirects=False,
    )
    if res.status_code in (301, 302, 303, 307, 308):
        print(f"ERROR: /voyager/api/me redirected (HTTP {res.status_code}) → "
              f"{res.headers.get('Location', '<no Location>')}")
        print("This means LinkedIn does not recognize the session. Your "
              "li_at / JSESSIONID secrets are invalid or have been "
              "invalidated. Get fresh cookies from your browser DevTools and "
              "update the GitHub secrets.")
        sys.exit(1)
    if res.status_code != 200:
        print(f"ERROR: /voyager/api/me returned HTTP {res.status_code}")
        print(f"Body snippet: {res.text[:300]!r}")
        sys.exit(1)
    return res.json()


def extract_urn(me):
    """Pull the URN ID out of the /me response.

    The URN looks like `urn:li:fsd_profile:ACoAA...`. We return the trailing
    identifier (everything after the last colon) since that's what
    get_profile_experiences expects.
    """
    mini = me.get("miniProfile", {})
    urn = mini.get("dashEntityUrn") or mini.get("entityUrn", "")
    if not urn or ":" not in urn:
        print(f"ERROR: could not find URN in /me response. Keys: {list(me.keys())}")
        sys.exit(1)
    return urn.rsplit(":", 1)[-1]


def build_profile(me):
    mini = me.get("miniProfile", {}) or {}
    first = clean(mini.get("firstName"))
    last = clean(mini.get("lastName"))
    headline = clean(mini.get("occupation"))

    picture_url = ""
    pic = mini.get("picture") or {}
    vector = pic.get("com.linkedin.common.VectorImage") or {}
    root = vector.get("rootUrl", "")
    artifacts = vector.get("artifacts", []) or []
    if root and artifacts:
        biggest = max(artifacts, key=lambda a: a.get("width", 0))
        picture_url = root + biggest.get("fileIdentifyingUrlPathSegment", "")

    return {
        "name": clean(f"{first} {last}"),
        "headline": headline,
        "picture": picture_url,
        "profile_url": f"https://www.linkedin.com/in/{PROFILE_ID}/",
    }


def fetch_experience(api, urn_id):
    """Call the GraphQL experiences endpoint via the library."""
    try:
        return api.get_profile_experiences(urn_id=urn_id) or []
    except Exception as e:
        print(f"ERROR: experience fetch failed — {type(e).__name__}: {e}")
        return []


def format_experience(raw_items):
    """Normalize the library's GraphQL response shape into our JSON contract."""
    out = []
    for item in raw_items:
        title = clean(item.get("title"))
        company = clean(item.get("companyName") or item.get("employmentType"))
        if not title or not company:
            continue
        start = clean(item.get("startDate"))
        end = clean(item.get("endDate")) or "Present"
        date = f"{start} — {end}" if start else end
        out.append({
            "date": date,
            "title": title,
            "company": company,
            "location": clean(item.get("locationName")),
            "description": clean(item.get("description")),
        })
    return out


def write_json(name, data):
    path = REPO_ROOT / name
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    size = len(data) if isinstance(data, list) else "object"
    print(f"Wrote {size} → {name}")


def main():
    api = authenticate()

    print("Fetching identity via /voyager/api/me ...")
    me = fetch_me(api)
    urn_id = extract_urn(me)
    print(f"Resolved URN: {urn_id}")

    profile = build_profile(me)
    print(f"  Name: {profile['name']!r}")
    print(f"  Headline: {profile['headline']!r}")

    print("Fetching experience via GraphQL ...")
    raw_exp = fetch_experience(api, urn_id)
    print(f"  Got {len(raw_exp)} raw experience items")

    experience = format_experience(raw_exp)
    if not experience:
        print("ERROR: zero experience entries parsed. Refusing to overwrite "
              "experience.json with an empty list.")
        sys.exit(1)

    write_json("profile.json", profile)
    write_json("experience.json", experience)


if __name__ == "__main__":
    main()
