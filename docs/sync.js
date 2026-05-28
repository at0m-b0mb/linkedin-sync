/* LinkedIn → GitHub sync bookmarklet
 *
 * Runs in the user's logged-in linkedin.com browser session. Calls the
 * Voyager API using the cookies that are already in the page, formats the
 * data, and commits the resulting JSON to a GitHub repo via the GitHub
 * REST API using a personal access token stored in localStorage.
 *
 * Loaded by the bookmarklet stub (see docs/index.html) as an external script
 * so we don't have to inline all of this into the javascript: URL.
 */
(async () => {
  const VERSION = 'v8-sort-recency';  // bump on every behavioural change
  console.log(`[linkedin-sync] bookmarklet ${VERSION}`);
  const REPO = 'at0m-b0mb/linkedin-sync';
  const BRANCH = 'main';
  const TOKEN_KEY = 'linkedin_sync_pat_v1';
  // Declared up here because formatPosition references it during the async
  // flow above the bottom-of-file helper definitions. `const`'s temporal
  // dead zone would throw otherwise.
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const $banner = (() => {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
      'background:#111', 'color:#fff', 'padding:14px 18px',
      'border-radius:8px', 'box-shadow:0 6px 24px rgba(0,0,0,.3)',
      'font:13px/1.4 -apple-system,system-ui,sans-serif',
      'max-width:360px', 'white-space:pre-wrap',
    ].join(';');
    document.body.appendChild(el);
    return el;
  })();
  const log = (msg, color) => {
    if (color) $banner.style.background = color;
    $banner.textContent = msg;
    console.log('[linkedin-sync]', msg);
  };

  try {
    if (!location.host.endsWith('linkedin.com')) {
      log('Open your LinkedIn profile page first, then click the bookmarklet.', '#a00');
      return;
    }

    let token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      token = prompt('Paste your GitHub Personal Access Token (will be stored in localStorage on linkedin.com only):');
      if (!token) { log('Cancelled — no token provided.', '#a00'); return; }
      localStorage.setItem(TOKEN_KEY, token.trim());
      token = token.trim();
    }

    log('Fetching identity from /voyager/api/me ...');
    const me = await voyager('/voyager/api/me');
    console.log('[linkedin-sync] /me response:', me);
    const mini = resolveMini(me);
    if (!mini) {
      throw new Error('Could not find miniProfile in /me response. ' +
        'Open DevTools → Console to see the raw response (logged above).');
    }
    const urnFull = mini.dashEntityUrn || mini.entityUrn || '';
    const urn = (urnFull.split(':').pop() || '').trim();
    if (!urn) throw new Error('Found miniProfile but no entityUrn/dashEntityUrn field.');
    const vanity = mini.publicIdentifier || extractVanityFromUrl();

    const profile = {
      name: `${(mini.firstName || '').trim()} ${(mini.lastName || '').trim()}`.trim(),
      headline: (mini.occupation || '').trim(),
      picture: extractPicture(mini),
      profile_url: vanity ? `https://www.linkedin.com/in/${vanity}/` : '',
      synced_at: new Date().toISOString(),
    };

    log(`Identity: ${profile.name}\nFetching experience ...`);
    const rawPositions = await fetchExperience(urn, vanity);
    const experience = rawPositions.map(formatPosition).filter(Boolean);
    if (!experience.length) {
      throw new Error('No experience entries parsed. ' +
        'Open DevTools → Console: see the [linkedin-sync] log lines for what was returned.');
    }
    sortByRecency(experience);

    log(`Got ${experience.length} positions. Opening commit window ...`);
    await commitViaPopup(token, profile, experience);

    log(`Done.\n• profile.json (${profile.name})\n• experience.json (${experience.length} entries)\nCommitted to ${REPO}@${BRANCH}.`, '#0a7a2a');
    setTimeout(() => $banner.remove(), 6000);
  } catch (err) {
    console.error(err);
    log(`Error: ${err.message}\n\nIf this says "401" or "Bad credentials" your GitHub PAT is wrong — clear it via console:\nlocalStorage.removeItem('${TOKEN_KEY}')`, '#a00');
  }

  // ------------ helpers ------------

  async function voyager(path) {
    const r = await fetch(path, {
      credentials: 'include',
      headers: {
        'csrf-token': csrfFromCookie(),
        'x-restli-protocol-version': '2.0.0',
      },
    });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return r.json();
  }

  /**
   * /voyager/api/me can come back in two shapes depending on Accept header
   * and what tier of API was used. Find the miniProfile no matter where it
   * lives.
   */
  function resolveMini(me) {
    if (me && me.miniProfile && (me.miniProfile.entityUrn || me.miniProfile.dashEntityUrn)) {
      return me.miniProfile;
    }
    // Normalized response: data is a graph reference, included is the array
    // of resolved entities. Find the one tagged as a (mini)Profile.
    if (Array.isArray(me?.included)) {
      const mp = me.included.find(x => {
        const t = (x.$type || x._type || '');
        return /MiniProfile|Profile$/i.test(t) || (x.entityUrn || '').includes('miniProfile') || (x.entityUrn || '').includes('fsd_profile');
      });
      if (mp) return mp;
    }
    return null;
  }

  function csrfFromCookie() {
    const m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    if (!m) throw new Error('No JSESSIONID cookie — are you logged in?');
    return m[1];
  }

  function extractVanityFromUrl() {
    const m = location.pathname.match(/^\/in\/([^/]+)/);
    return m ? m[1] : '';
  }

  function extractPicture(mini) {
    const pic = mini.picture && mini.picture['com.linkedin.common.VectorImage'];
    if (!pic || !pic.rootUrl) return '';
    const artifacts = pic.artifacts || [];
    if (!artifacts.length) return '';
    const biggest = artifacts.reduce((a, b) => (a.width >= b.width ? a : b));
    return pic.rootUrl + (biggest.fileIdentifyingUrlPathSegment || '');
  }

  async function fetchExperience(urn, vanity) {
    // Modern LinkedIn /details/experience/ ships only an SPA shell — no
    // server-side hydration JSON. So we call the Voyager API directly the
    // same way the page's JS does. We try a few known endpoint shapes and
    // use whichever one responds successfully.
    const fullUrn = `urn:li:fsd_profile:${urn}`;
    const enc = encodeURIComponent(fullUrn);

    const candidates = [
      {
        name: 'dash profilePositions q=viewee',
        path: `/voyager/api/identity/dash/profilePositions?q=viewee&profileUrn=${enc}&count=100`,
      },
      {
        name: 'rest profilePositions count=100',
        path: `/voyager/api/identity/dash/profilePositions?q=viewee&profileUrn=${enc}`,
      },
      {
        name: 'legacy positions by urn',
        path: `/voyager/api/identity/profiles/${urn}/positions?count=100&start=0`,
      },
      {
        name: 'legacy positionGroups by urn',
        path: `/voyager/api/identity/profiles/${urn}/positionGroups?count=100&start=0`,
      },
    ];

    for (const c of candidates) {
      log(`Trying: ${c.name} ...`);
      try {
        const r = await fetch(c.path, {
          credentials: 'include',
          headers: {
            'csrf-token': csrfFromCookie(),
            'x-restli-protocol-version': '2.0.0',
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
          },
        });
        console.log(`[linkedin-sync] ${c.name}: HTTP ${r.status}`);
        if (!r.ok) continue;
        const data = await r.json();
        console.log(`[linkedin-sync] ${c.name} body:`, data);
        const positions = extractPositionsFromVoyagerJson(data);
        if (positions.length) {
          console.log(`[linkedin-sync] ${c.name} → ${positions.length} positions`);
          return positions;
        }
        console.log(`[linkedin-sync] ${c.name}: 200 OK but 0 positions parsed`);
      } catch (err) {
        console.log(`[linkedin-sync] ${c.name} threw:`, err.message);
      }
    }

    // Last resort: fetch the details/experience HTML and look in case
    // LinkedIn does ship hydration data for this specific page.
    const target = vanity || extractVanityFromUrl();
    if (target) {
      log('All APIs failed; trying HTML hydration fallback ...');
      try {
        const r = await fetch(`/in/${target}/details/experience/`, { credentials: 'include' });
        if (r.ok) {
          const html = await r.text();
          const positions = extractPositionsFromHydrationJson(html);
          if (positions.length) return positions;
        }
      } catch (_) {}
    }
    return [];
  }

  function extractPositionsFromVoyagerJson(data) {
    const positions = [];
    const seen = new Set();

    // Normalized response: elements + included
    const containers = [];
    if (Array.isArray(data.elements)) containers.push(...data.elements);
    if (Array.isArray(data.included)) containers.push(...data.included);
    // Sometimes the payload itself is a list
    if (Array.isArray(data)) containers.push(...data);

    for (const item of containers) {
      if (!item || typeof item !== 'object') continue;
      const t = item.$type || item._type || '';
      const looksLikePosition = /Position(?!Group)/.test(t) ||
        (item.title && (item.companyName || item.companyUrn));
      if (!looksLikePosition) continue;
      if (!item.title && !item.companyName) continue;
      const key = `${item.entityUrn || ''}|${item.title}|${item.companyName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      positions.push(item);
    }
    return positions;
  }

  /**
   * Walk every JSON-bearing block on the page (LinkedIn hydration). Look for
   * Voyager API responses whose `included` array contains Position entities.
   *
   * LinkedIn has used several hydration tag formats over the years:
   *   <code id="bpr-guid-*">...</code>          (classic BigPipe)
   *   <code id="datalet-bpr-guid-*">...</code>  (variant)
   *   <script type="application/json">...</script>  (Next.js-style)
   * We try them all and combine the results.
   */
  function extractPositionsFromHydrationJson(html) {
    const blocks = [];

    const patterns = [
      /<code[^>]*id="bpr-guid-[^"]*"[^>]*>([\s\S]*?)<\/code>/g,
      /<code[^>]*id="datalet-bpr-guid-[^"]*"[^>]*>([\s\S]*?)<\/code>/g,
      /<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html))) blocks.push(m[1]);
    }
    console.log(`[linkedin-sync] hydration blocks found: ${blocks.length}`);

    const positions = [];
    const seen = new Set();
    const typeCounts = {};

    for (const raw of blocks) {
      const decoded = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
      let json;
      try { json = JSON.parse(decoded); }
      catch (_) { continue; }

      const included = json.included || [];
      for (const item of included) {
        const t = item.$type || item._type || '';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
        if (!/Position|profile\.Position/.test(t)) continue;
        if (!item.title && !item.companyName) continue;
        const key = `${item.entityUrn || ''}|${item.title}|${item.companyName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        positions.push(item);
      }
    }

    if (!positions.length) {
      console.log('[linkedin-sync] no Position entities found. ' +
        'Entity type counts seen across all blocks:', typeCounts);
    }
    return positions;
  }

  function fmtDate(d) {
    if (!d || !d.year) return '';
    return d.month ? `${MONTHS[d.month - 1]} ${d.year}` : `${d.year}`;
  }
  function fmtPeriod(start, end) {
    const s = fmtDate(start);
    const e = fmtDate(end) || 'Present';
    return s ? `${s} — ${e}` : e;
  }

  /**
   * The dash Voyager API returns dates in several different shapes depending
   * on which endpoint and which entity version. Try each known shape.
   */
  function extractDates(p) {
    // Shape 1: legacy { timePeriod: { startDate: {m,y}, endDate: {m,y} } }
    if (p.timePeriod) {
      return [p.timePeriod.startDate, p.timePeriod.endDate];
    }
    // Shape 2: dash { dateRange: { start: {m,y}, end: {m,y} } }
    if (p.dateRange) {
      return [p.dateRange.start, p.dateRange.end];
    }
    // Shape 3: split fields on the position itself
    if (p.startedOn || p.endedOn) {
      return [p.startedOn, p.endedOn];
    }
    return [null, null];
  }

  function extractText(field) {
    if (!field) return '';
    if (typeof field === 'string') return field;
    // Dash returns rich text as { text: "...", attributes: [...] }
    if (typeof field === 'object' && typeof field.text === 'string') return field.text;
    return '';
  }

  /**
   * Sort positions in reverse-chronological order — current roles first,
   * then most-recently-ended. Operates in-place. Parses the formatted `date`
   * string ("Jan 2025 — Jun 2025" or "Oct 2023 — Present") since we don't
   * keep the raw {month, year} objects after formatting.
   */
  function sortByRecency(items) {
    const MONTH_IDX = Object.fromEntries(MONTHS.map((m, i) => [m, i + 1]));
    const ONGOING = [9999, 13];
    function parseSide(s) {
      if (!s) return [0, 0];
      s = s.trim();
      if (/present/i.test(s)) return null; // null = ongoing → sorts highest
      const m = s.match(/(\w{3})\s+(\d{4})/);
      if (m) return [parseInt(m[2], 10), MONTH_IDX[m[1]] || 0];
      const y = s.match(/(\d{4})/);
      return y ? [parseInt(y[1], 10), 1] : [0, 0];
    }
    function key(p) {
      const parts = (p.date || '').split(/\s*—\s*|\s*-\s*/);
      const start = parseSide(parts[0]) || [0, 0];
      const end = parseSide(parts[1] || '') || ONGOING;
      return [end[0], end[1], start[0], start[1]];
    }
    items.sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return kb[i] - ka[i];
      }
      return 0;
    });
  }

  function formatPosition(p) {
    const title = extractText(p.title).trim() ||
                  extractText(p.titleV2 && p.titleV2.text).trim();
    const company = extractText(p.companyName).trim() ||
                    extractText(p.subtitle).trim() ||
                    extractText(p.standardizedTitle).trim();
    if (!title || !company) return null;

    const [start, end] = extractDates(p);
    const date = fmtPeriod(start, end);
    if (!date) {
      console.log('[linkedin-sync] no date extracted for position, raw fields:',
        Object.keys(p), 'sample:', p);
    }

    const location = extractText(p.locationName).trim() ||
                     extractText(p.geoLocationName).trim() ||
                     extractText(p.location).trim();
    const description = extractText(p.description).replace(/\s+/g, ' ').trim();

    return { date, title, company, location, description };
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * Commit by opening a popup on github.io and posting the data to it. We
   * can't fetch api.github.com from this context because LinkedIn's CSP
   * `connect-src` directive blocks external API endpoints, even from a
   * bookmarklet. The github.io popup has no such CSP, so it can call
   * api.github.com freely.
   */
  function commitViaPopup(token, profile, experience) {
    return new Promise((resolve, reject) => {
      const popup = window.open(
        'https://at0m-b0mb.github.io/linkedin-sync/commit.html',
        'linkedin-sync-commit',
        'width=520,height=300'
      );
      if (!popup) {
        reject(new Error(
          'Popup was blocked. Allow popups for linkedin.com (click the popup-blocked icon in the address bar) and try again.'
        ));
        return;
      }

      let settled = false;
      function cleanup() {
        settled = true;
        window.removeEventListener('message', onMessage);
      }
      function onMessage(ev) {
        if (ev.source !== popup) return;
        const msg = ev.data;
        if (!msg) return;
        if (msg.type === 'commit-ready') {
          popup.postMessage(
            { type: 'commit', token, profile, experience },
            'https://at0m-b0mb.github.io'
          );
        } else if (msg.type === 'done') {
          cleanup();
          resolve();
        } else if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.error || 'commit popup reported an error'));
        }
      }
      window.addEventListener('message', onMessage);

      setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error('Commit popup did not respond within 30s.'));
      }, 30000);
    });
  }
})();
