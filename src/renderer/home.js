// ============ v4 Running home (slice 2) ============
// The home screen when the v4 flag is on: a greeting that says whether anything needs you,
// a blocked strip with the fix as a button, the running tiles (the existing Now running
// strip, restyled), and "Ready to start" tiles with one big Start. With no apps it is the
// first-run welcome. What counts as blocked comes from src/core/homeModel.js, the same
// set the sidebar's Needs attention count uses; the conflict wording and actions come
// from renderConflictStrip in renderer.js, so every surface offers the same choices.
// Loaded after sidebar.js. With the flag off this file does nothing and both hosts stay hidden.
(function () {
  if (document.documentElement.getAttribute('data-ui') !== 'v4') return;
  const M = window.PortPilotHomeModel;
  const top = document.getElementById('v4-home-top');
  const ready = document.getElementById('v4-home-ready');
  const content = document.querySelector('main.content');
  if (!M || !top || !ready || !content) return;

  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const rowOf = (app) => appRowState(app);

  function blockedHtml(app, row) {
    const conflict = state.unknownConflicts.find((c) => c.appId === app.id);
    const head = `<span class="v4-alert-name">${esc(app.name)}</span>`;
    if (conflict) {
      return `<div class="v4-alert" data-app="${esc(app.id)}">${head}${renderConflictStrip(app, conflict, 'home')}</div>`;
    }
    const why = [row.word, row.reason].filter(Boolean).join(': ');
    return `<div class="v4-alert" data-app="${esc(app.id)}">${head}
      <span class="v4-alert-why">${esc(why)}</span>
      <span class="v4-alert-actions">
        <button class="btn btn-primary" data-act="startApp" data-id="${esc(app.id)}">${t('Restart')}</button>
        <button class="btn btn-secondary" data-act="openDrawer" data-id="${esc(app.id)}">${t('Details')}</button>
      </span></div>`;
  }

  const COMPACT_AFTER = 8;
  function rowHtml(app) {
    const port = app.preferredPort ? `<span class="app-port-badge">:${esc(app.preferredPort)}</span>` : '';
    const branch = app.branch ? `<span class="v4-tile-branch">${icon('branch', 11)}${esc(app.branch)}</span>` : '';
    return `<div class="v4-ready-row" data-app="${esc(app.id)}">
      <span class="v4-ready-name">${esc(app.name)}</span>${branch}${port}
      <button class="btn btn-secondary btn-small v4-ready-start" data-act="startApp" data-id="${esc(app.id)}" aria-label="${t('Start {name}', { name: esc(app.name) })}">${icon('play', 11)} ${t('Start')}</button>
      <button class="btn btn-secondary btn-small" data-act="openDrawer" data-id="${esc(app.id)}">${t('Details')}</button>
    </div>`;
  }

  function tileHtml(app) {
    const port = app.preferredPort ? `<span class="app-port-badge">:${esc(app.preferredPort)}</span>` : '';
    const branch = app.branch ? `<span class="v4-tile-branch">${icon('branch', 11)}${esc(app.branch)}</span>` : '';
    return `<article class="v4-tile" data-app="${esc(app.id)}" aria-label="${t('{name}, ready to start', { name: esc(app.name) })}">
      <div class="v4-tile-head"><span class="v4-tile-name">${esc(app.name)}</span>${port}</div>
      ${branch ? `<div class="v4-tile-meta">${branch}</div>` : ''}
      <div class="v4-tile-actions">
        <button class="btn btn-primary v4-start" data-act="startApp" data-id="${esc(app.id)}">${icon('play', 12)} ${t('Start')}</button>
        <button class="btn btn-secondary" data-act="openDrawer" data-id="${esc(app.id)}">${t('Details')}</button>
      </div></article>`;
  }

  function firstRunHtml() {
    return `<div class="v4-empty">
      <h2>${t('Welcome to PortPilot')}</h2>
      <p>${t('Your dev servers, one tap each. Add a project to begin.')}</p>
      <div class="v4-empty-actions">
        <button type="button" class="btn btn-primary" data-v4="addApp">${t('Add a project folder')}</button>
        <button type="button" class="btn btn-secondary" data-v4="detect">${t('Detect projects')}</button>
      </div>
      <ol class="v4-steps">
        <li><b>${t('Pick a folder.')}</b> ${t('PortPilot detects the start command.')}</li>
        <li><b>${t('Get a free port.')}</b> ${t('No more clashes.')}</li>
        <li><b>${t('Press Start.')}</b> ${t('Claude can start it too.')}</li>
      </ol></div>`;
  }

  function render() {
    const apps = state.apps;
    const rows = apps.map((a) => ({ id: a.id, state: rowOf(a).state }));
    const sum = M.summarise(rows);
    const byId = new Map(apps.map((a) => [a.id, a]));
    content.toggleAttribute('data-v4-empty', sum.empty);

    if (sum.empty) {
      top.hidden = false;
      top.innerHTML = firstRunHtml();
      ready.hidden = true; ready.innerHTML = '';
      return;
    }

    const blocked = sum.blocked.map((id) => byId.get(id)).filter(Boolean);
    top.hidden = false;
    top.innerHTML = `<div class="v4-hello" data-tone="${sum.tone}"><h2>${esc(sum.headline)}</h2><p>${esc(sum.sub)}</p></div>
      ${blocked.length ? `<div class="v4-alerts" role="region" aria-label="${t('Needs attention')}">${blocked.map((a) => blockedHtml(a, rowOf(a))).join('')}</div>` : ''}`;

    const idle = _filterApps(sum.ready.map((id) => byId.get(id)).filter(Boolean));
    if (!idle.length) { ready.hidden = true; ready.innerHTML = ''; return; }
    ready.hidden = false;
    // A few apps get big tiles; a long list gets quiet rows so fifty Start buttons do not shout.
    const compact = idle.length > COMPACT_AFTER;
    ready.innerHTML = `<div class="v4-sec"><span>${t('Ready to start')}</span><span class="v4-sec-count">${idle.length}</span></div>
      ${compact ? `<div class="v4-rows">${idle.map(rowHtml).join('')}</div>` : `<div class="v4-tiles">${idle.map(tileHtml).join('')}</div>`}`;
    reapplyArmed(top);
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v4]');
    if (!b) return;
    if (b.dataset.v4 === 'addApp') document.getElementById('btn-add-app').click();
    if (b.dataset.v4 === 'detect') document.getElementById('btn-discover-projects').click();
  });

  window.PortPilotHome = { render };
  render();
})();
