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
    const mini = me.miniProfile || {};
    const urnFull = mini.dashEntityUrn || mini.entityUrn || '';
    const urn = urnFull.split(':').pop();
    if (!urn) throw new Error('Could not extract URN from /me response');
    const vanity = mini.publicIdentifier || extractVanityFromUrl();

    const profile = {
      name: `${(mini.firstName || '').trim()} ${(mini.lastName || '').trim()}`.trim(),
      headline: (mini.occupation || '').trim(),
      picture: extractPicture(mini),
      profile_url: vanity ? `https://www.linkedin.com/in/${vanity}/` : '',
      synced_at: new Date().toISOString(),
    };

    log(`Identity: ${profile.name}\nFetching experience ...`);
    const experience = await fetchExperience(urn);
    if (!experience.length) throw new Error('No experience entries parsed. Are you on your own profile?');

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
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'csrf-token': csrfFromCookie(),
        'x-restli-protocol-version': '2.0.0',
      },
    });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return r.json();
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

  async function fetchExperience(urn) {
    // The profile page itself embeds the data we need. When the user is
    // viewing their own profile, LinkedIn renders experience cards in
    // .pv-profile-section / artdeco-card components. We parse the DOM
    // directly rather than chase a moving GraphQL queryId.
    if (!location.pathname.includes('/in/')) {
      throw new Error('Navigate to your LinkedIn profile page first (linkedin.com/in/your-vanity/).');
    }

    // Make sure the experience section is expanded. Click "Show all" if present.
    const showAll = [...document.querySelectorAll('a, button')]
      .find(el => /show all .* experiences/i.test(el.textContent || ''));
    if (showAll) showAll.click();
    await wait(800);

    // Each top-level position is a <li> inside the experience section.
    const expSection = findSection('experience');
    if (!expSection) throw new Error('Could not find Experience section on this page.');

    const items = expSection.querySelectorAll('li.artdeco-list__item, li.pvs-list__paged-list-item');
    const out = [];
    items.forEach(li => {
      const entry = parseExperienceItem(li);
      if (entry) out.push(entry);
    });
    return out;
  }

  function findSection(name) {
    const sections = [...document.querySelectorAll('section')];
    return sections.find(s => {
      const id = (s.id || '').toLowerCase();
      if (id.includes(name)) return true;
      const h = s.querySelector('h2, h3, [role="heading"]');
      return h && h.textContent.toLowerCase().includes(name);
    });
  }

  function parseExperienceItem(li) {
    const t = sel => {
      const e = li.querySelector(sel);
      return e ? e.innerText.replace(/\s+/g, ' ').trim() : '';
    };
    // LinkedIn marks visually-hidden duplicate text with .visually-hidden;
    // use those when present because they hold the canonical strings.
    const bold = li.querySelector('.t-bold span[aria-hidden="true"], .t-bold');
    const subtitleEls = li.querySelectorAll('.t-14.t-normal span[aria-hidden="true"]');
    const captionEls = li.querySelectorAll('.t-14.t-normal.t-black--light span[aria-hidden="true"]');

    const title = bold ? bold.innerText.trim() : '';
    if (!title) return null;
    const company = (subtitleEls[0] ? subtitleEls[0].innerText : '').split('·')[0].trim();
    const dateRaw = captionEls[0] ? captionEls[0].innerText : '';
    const location = captionEls[1] ? captionEls[1].innerText.trim() : '';
    const desc = t('.pvs-list__outer-container .inline-show-more-text--is-collapsed, .pv-shared-text-with-see-more, .display-flex.full-width .t-14.t-normal.t-black .pvs-list__outer-container');

    // dateRaw is usually "Jan 2025 - Jun 2025 · 6 mos" — strip the duration suffix.
    const date = dateRaw.split('·')[0].trim().replace(/\s*-\s*/, ' — ');

    return { date, title, company, location, description: desc };
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
