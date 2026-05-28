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
  const REPO = 'at0m-b0mb/linkedin-sync';
  const BRANCH = 'main';
  const TOKEN_KEY = 'linkedin_sync_pat_v1';

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

    log(`Got ${experience.length} positions. Committing to GitHub ...`);
    await commit(token, 'profile.json', profile);
    await commit(token, 'experience.json', experience);

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
    // Don't DOM-scrape. LinkedIn rebuilds its CSS classes constantly.
    // Instead fetch the dedicated experience-details page (which lists every
    // position regardless of "show all" state) and pull the structured JSON
    // out of the <code> tags LinkedIn embeds for client-side state hydration.
    const target = vanity || extractVanityFromUrl();
    if (!target) throw new Error('Could not determine your profile vanity URL.');
    const url = `/in/${target}/details/experience/`;
    log(`Fetching ${url} ...`);
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`Experience page → HTTP ${r.status}`);
    const html = await r.text();

    const positions = extractPositionsFromHydrationJson(html);
    console.log('[linkedin-sync] positions found in hydration:', positions);
    return positions;
  }

  /**
   * Walk every <code id="bpr-guid-*"> block on the page; each one contains a
   * Voyager API response (JSON). The /details/experience/ page hydrates with
   * a response whose `included` array lists all Position entities. Find them.
   */
  function extractPositionsFromHydrationJson(html) {
    const positions = [];
    const seen = new Set();
    // Match <code id="bpr-guid-..."> ... </code> blocks.
    const re = /<code[^>]*id="bpr-guid-[^"]*"[^>]*>([\s\S]*?)<\/code>/g;
    let m;
    while ((m = re.exec(html))) {
      let json;
      try {
        // HTML-entity-decode the contents before parsing.
        const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
        json = JSON.parse(raw);
      } catch (_) { continue; }
      const included = json.included || [];
      for (const item of included) {
        const t = item.$type || item._type || '';
        if (!/Position|profile\.Position/.test(t)) continue;
        // Some `Position` entities are part of a group/aggregation — pick the
        // ones with an actual title or companyName field.
        if (!item.title && !item.companyName) continue;
        const key = `${item.entityUrn || ''}|${item.title}|${item.companyName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        positions.push(item);
      }
    }
    return positions;
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmtDate(d) {
    if (!d || !d.year) return '';
    return d.month ? `${MONTHS[d.month - 1]} ${d.year}` : `${d.year}`;
  }
  function fmtPeriod(tp) {
    if (!tp) return '';
    const s = fmtDate(tp.startDate);
    const e = fmtDate(tp.endDate) || 'Present';
    return s ? `${s} — ${e}` : e;
  }

  function formatPosition(p) {
    const title = (p.title || '').trim();
    const company = (p.companyName || '').trim();
    if (!title || !company) return null;
    return {
      date: fmtPeriod(p.timePeriod),
      title,
      company,
      location: (p.locationName || '').trim(),
      description: (p.description || '').replace(/\s+/g, ' ').trim(),
    };
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function commit(token, path, dataObj) {
    const apiBase = `https://api.github.com/repos/${REPO}/contents/${path}`;
    // get existing SHA so we can update rather than create-conflict
    let sha = null;
    const head = await fetch(`${apiBase}?ref=${BRANCH}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
    });
    if (head.ok) sha = (await head.json()).sha;
    else if (head.status !== 404) throw new Error(`GitHub GET ${path}: HTTP ${head.status}`);

    const body = {
      message: `chore: sync ${path} from LinkedIn`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(dataObj, null, 2) + '\n'))),
      branch: BRANCH,
      committer: { name: 'at0m-b0mb', email: '99875896+at0m-b0mb@users.noreply.github.com' },
      author:    { name: 'at0m-b0mb', email: '99875896+at0m-b0mb@users.noreply.github.com' },
    };
    if (sha) body.sha = sha;

    const r = await fetch(apiBase, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`GitHub PUT ${path}: HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
  }
})();
