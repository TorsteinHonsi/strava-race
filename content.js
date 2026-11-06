(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Fetch relay: the race page asks us to fetch Strava URLs, because we run
  //    on strava.com and the request carries the user's session cookie.
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'stravaFetch') return;
    if (typeof msg.path !== 'string' || !msg.path.startsWith('/')) {
      sendResponse({ ok: false, status: 0, error: 'Invalid path' });
      return;
    }
    fetch(msg.path, { credentials: 'same-origin', headers: msg.headers || {} })
      .then(async (res) => {
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, url: res.url, body: text });
      })
      .catch((err) => sendResponse({ ok: false, status: 0, error: String(err) }));
    return true; // async response
  });

  // ---------------------------------------------------------------------------
  // 2. Menu item on activity pages.
  // ---------------------------------------------------------------------------
  const ITEM_ID = 'strava-race-menu-item';
  const FAB_ID = 'strava-race-fab';

  const activityId = () => {
    const m = location.pathname.match(/^\/activities\/(\d+)/);
    return m ? m[1] : null;
  };

  const activityName = () => {
    const h = document.querySelector('.activity-name, h1.activity-name, [data-testid="activity-name"]');
    const t = (h && h.textContent.trim()) || document.title.replace(/\s*\|\s*Strava\s*$/, '');
    return t.trim();
  };

  const openRace = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const id = activityId();
    if (id) chrome.runtime.sendMessage({ type: 'openRace', id, name: activityName() });
  };

  const flagSvg =
    '<svg class="strava-race-flag" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<path fill="currentColor" d="M2 1h1.5v14H2z"/>' +
    '<path fill="currentColor" d="M4 2h10v7H4z" opacity=".25"/>' +
    '<path fill="currentColor" d="M4 2h2.5v2.33H4zm5 0h2.5v2.33H9zM6.5 4.33H9v2.34H6.5zm5 0H14v2.34h-2.5zM4 6.67h2.5V9H4zm5 0h2.5V9H9z"/>' +
    '</svg>';

  // Strava's activity sidebar menu (Overview, Analysis, Laps, ...). We try the
  // classic markup first, then more generic fallbacks.
  const findSidebarMenu = () =>
    document.querySelector('nav.sidenav ul.pagenav') ||
    document.querySelector('ul.pagenav') ||
    document.querySelector('#pagenav') ||
    document.querySelector('nav[aria-label*="ctivity"] ul');

  const inject = () => {
    if (!activityId()) {
      document.getElementById(ITEM_ID)?.remove();
      document.getElementById(FAB_ID)?.remove();
      return;
    }
    if (document.getElementById(ITEM_ID)) return;

    const menu = findSidebarMenu();
    if (menu) {
      const li = document.createElement('li');
      li.id = ITEM_ID;
      const sample = menu.querySelector('li a');
      const a = document.createElement('a');
      a.href = '#';
      if (sample) a.className = sample.className.replace(/\bselected\b|\bactive\b/g, '').trim();
      a.innerHTML = flagSvg + '<span>Race</span>';
      a.title = 'Race this activity against others (Strava Race)';
      a.addEventListener('click', openRace);
      li.appendChild(a);
      menu.appendChild(li);
      document.getElementById(FAB_ID)?.remove();
      return;
    }

    // Fallback: a floating button if the sidebar menu isn't found.
    if (!document.getElementById(FAB_ID) && document.body) {
      const b = document.createElement('button');
      b.id = FAB_ID;
      b.type = 'button';
      b.innerHTML = flagSvg + '<span>Race</span>';
      b.title = 'Race this activity against others (Strava Race)';
      b.addEventListener('click', openRace);
      document.body.appendChild(b);
    }
  };

  inject();
  // Strava re-renders parts of the page (and navigates client-side in places),
  // so keep watching. The fallback button gets replaced once the menu appears.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; inject(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
