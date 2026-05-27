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
  profile.json     — headline, about, location, picture
  experience.json  — list of positions
  education.json   — list of schools
  skills.json      — list of endorsed skills

If LinkedIn returns an empty or error response, the script exits non-zero
WITHOUT touching the existing JSON files. The portfolio site keeps showing
the last good data instead of breaking.
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

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def fmt_date(d):
    if not d:
        return ""
    month = d.get("month")
    year = d.get("year")
    if not year:
        return ""
    if not month:
        return str(year)
    return f"{MONTHS[month - 1]} {year}"


def fmt_period(tp):
    if not tp:
        return ""
    start = fmt_date(tp.get("startDate"))
    end = fmt_date(tp.get("endDate")) or "Present"
    if not start:
        return end
    return f"{start} — {end}"


def clean(text):
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


def build_cookie_jar(li_at, jsessionid):
    jar = RequestsCookieJar()
    jar.set("li_at", li_at, domain=".linkedin.com", path="/")
    # JSESSIONID MUST be sent to LinkedIn wrapped in literal double-quotes —
    # that's how LinkedIn issues it. Browsers may show the value with or
    # without quotes in DevTools; normalize so it always has them on the wire.
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


def extract_experience(profile):
    out = []
    for pos in profile.get("experience", []) or []:
        title = clean(pos.get("title"))
        company = clean(pos.get("companyName"))
        if not title or not company:
            continue
        out.append({
            "date": fmt_period(pos.get("timePeriod", {})),
            "title": title,
            "company": company,
            "location": clean(pos.get("locationName")),
            "description": clean(pos.get("description")),
        })
    return out


def extract_education(profile):
    out = []
    for edu in profile.get("education", []) or []:
        school = clean(edu.get("schoolName"))
        if not school:
            continue
        out.append({
            "date": fmt_period(edu.get("timePeriod", {})),
            "school": school,
            "degree": clean(edu.get("degreeName")),
            "field": clean(edu.get("fieldOfStudy")),
            "description": clean(edu.get("description")),
        })
    return out


def extract_skills(api, profile_id):
    try:
        raw = api.get_profile_skills(public_id=profile_id) or []
    except Exception as e:
        print(f"WARN: could not fetch skills — {e}")
        return []
    out = []
    for s in raw:
        name = clean(s.get("name"))
        if name:
            out.append({"name": name})
    return out


def extract_summary(profile):
    pic = ""
    pic_root = profile.get("displayPictureUrl")
    artifacts = profile.get("profilePicture", {}).get(
        "displayImageReference", {}
    ).get("vectorImage", {}).get("artifacts", []) if isinstance(
        profile.get("profilePicture"), dict
    ) else []
    if pic_root and (profile.get("img_400_400") or profile.get("img_200_200")):
        pic = pic_root + (profile.get("img_400_400") or profile.get("img_200_200"))
    elif artifacts:
        # fall back to the largest available artifact
        biggest = max(artifacts, key=lambda a: a.get("width", 0))
        pic = biggest.get("fileIdentifyingUrlPathSegment", "")

    return {
        "name": clean(
            f"{profile.get('firstName', '')} {profile.get('lastName', '')}"
        ),
        "headline": clean(profile.get("headline")),
        "summary": clean(profile.get("summary")),
        "location": clean(profile.get("locationName")
                          or profile.get("geoLocationName")),
        "industry": clean(profile.get("industryName")),
        "picture": pic,
        "profile_url": f"https://www.linkedin.com/in/{PROFILE_ID}/",
    }


def write_json(name, data):
    path = REPO_ROOT / name
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(data) if isinstance(data, list) else 'profile'} → {name}")


def diagnose(api):
    """Make a raw call to the Voyager API and print what LinkedIn returns.

    Helps debug auth failures since the library swallows error responses.
    """
    print("Diagnostic: calling /voyager/api/me ...")
    res = api.client.session.get(
        "https://www.linkedin.com/voyager/api/me",
        cookies=api.client.session.cookies,
        headers=api.client.session.headers,
    )
    print(f"  HTTP {res.status_code} — {len(res.content)} bytes")
    body = res.text[:500]
    print(f"  Body snippet: {body!r}")
    print(f"  Cookies sent: {[c.name for c in api.client.session.cookies]}")
    print(f"  csrf-token header set: "
          f"{'csrf-token' in api.client.session.headers}")


def main():
    api = authenticate()

    diagnose(api)

    print(f"Fetching profile: {PROFILE_ID}")
    try:
        profile = api.get_profile(PROFILE_ID)
    except Exception as e:
        print(f"ERROR: profile fetch failed — KeyError {e}")
        print("This usually means LinkedIn returned an error response. "
              "Check the diagnostic above.")
        sys.exit(1)

    if not profile:
        print("ERROR: empty profile response. Cookies may be invalid.")
        sys.exit(1)

    experience = extract_experience(profile)
    education = extract_education(profile)
    skills = extract_skills(api, PROFILE_ID)
    summary = extract_summary(profile)

    if not experience:
        print("ERROR: no experience entries parsed. Refusing to overwrite "
              "existing experience.json with an empty list.")
        print("Profile keys returned:", list(profile.keys()))
        sys.exit(1)

    write_json("experience.json", experience)
    write_json("education.json", education)
    write_json("skills.json", skills)
    write_json("profile.json", summary)


if __name__ == "__main__":
    main()
