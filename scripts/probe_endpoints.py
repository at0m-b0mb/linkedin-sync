#!/usr/bin/env python3
"""One-shot probe to discover which LinkedIn endpoints still work.

Reads LINKEDIN_LI_AT / LINKEDIN_JSESSIONID from env (same secrets the main
sync uses). Prints HTTP status + a body snippet for each endpoint. No
credentials are stored, logged, or written anywhere — env vars only.

This script is meant to be deleted from the repo once we identify a working
endpoint for experience/positions data.
"""

import os
import sys

from linkedin_api import Linkedin
from requests.cookies import RequestsCookieJar


URN = "ACoAADdewusBZnW06uMMuQuY0E-s9Xdws1HRNkM"
PROFILE_ID = "kailash-parshad"


def build_jar(li_at, jsess):
    jar = RequestsCookieJar()
    jar.set("li_at", li_at, domain=".linkedin.com", path="/")
    jar.set("JSESSIONID", f'"{jsess.strip(chr(34))}"',
            domain=".linkedin.com", path="/")
    return jar


def probe(sess, label, path, **kwargs):
    import time
    time.sleep(2)  # pace ourselves so LinkedIn doesn't flag the session
    headers = kwargs.pop("headers", None) or {}
    base = "https://www.linkedin.com"
    url = base + path
    r = sess.get(url, headers=headers, allow_redirects=False, **kwargs)
    body = r.text[:200].replace("\n", " ")
    loc = r.headers.get("Location", "")
    print(f"[{r.status_code}] {label}")
    if loc:
        print(f"    → Location: {loc}")
    print(f"    body[:200]: {body!r}")
    print()


def main():
    li_at = os.environ["LINKEDIN_LI_AT"].strip()
    jsess = os.environ["LINKEDIN_JSESSIONID"].strip()

    api = Linkedin("", "", cookies=build_jar(li_at, jsess))
    sess = api.client.session

    print("=== Probe: experience / positions endpoints ===\n")

    # 1. /voyager/api/me — known to work, sanity check
    probe(sess, "/voyager/api/me (sanity)", "/voyager/api/me")

    # 2. Old profileView path with vanity ID
    probe(sess, "profileView by vanity",
          f"/voyager/api/identity/profiles/{PROFILE_ID}/profileView")

    # 3. Old profileView path with URN
    probe(sess, "profileView by URN",
          f"/voyager/api/identity/profiles/{URN}/profileView")

    # 4. positionGroups (legacy)
    probe(sess, "positionGroups by vanity",
          f"/voyager/api/identity/profiles/{PROFILE_ID}/positionGroups")

    # 5. Dash profile (newer REST endpoint)
    probe(sess, "dash profileView by URN",
          f"/voyager/api/identity/dash/profiles/urn:li:fsd_profile:{URN}/profileView")

    # 6. Dash positions (newer REST endpoint)
    probe(
        sess,
        "dash profilePositions q=viewee",
        "/voyager/api/identity/dash/profilePositions"
        f"?q=viewee&profileUrn=urn%3Ali%3Afsd_profile%3A{URN}",
        headers={"accept": "application/vnd.linkedin.normalized+json+2.1"},
    )

    # 7. GraphQL — library's hardcoded queryId
    from urllib.parse import quote
    profile_urn_enc = quote(f"urn:li:fsd_profile:{URN}")
    variables = f"profileUrn:{profile_urn_enc},sectionType:experience"
    qid_old = "voyagerIdentityDashProfileComponents.7af5d6f176f11583b382e37e5639e69e"
    probe(
        sess,
        "GraphQL experience (library queryId)",
        f"/voyager/api/graphql?variables=({variables})&queryId={qid_old}"
        "&includeWebMetadata=true",
        headers={"accept": "application/vnd.linkedin.normalized+json+2.1"},
    )

    # 8. GraphQL with different queryId variants seen in the wild
    for qid in (
        "voyagerIdentityDashProfileComponents.fa6f95cad96fb5e64a3c30b46c0c4ca5",
        "voyagerIdentityDashProfileComponents.acdf0bb9cb1fc60ad36625dbf658d4f8",
        "voyagerIdentityDashProfileComponents.2b9eebb4b1a87b1fb27d7c8f2d2dc60c",
    ):
        probe(
            sess,
            f"GraphQL experience (qid {qid.split('.')[-1][:8]}...)",
            f"/voyager/api/graphql?variables=({variables})&queryId={qid}"
            "&includeWebMetadata=true",
            headers={"accept": "application/vnd.linkedin.normalized+json+2.1"},
        )


if __name__ == "__main__":
    main()
