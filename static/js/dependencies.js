// dependencies.js — Settings ▸ Dependencies panel.
//
// Local machine only: optional pip packages that extend AD (app features
// and local model serving). Status comes from /api/cookbook/packages and
// installs run through /api/cookbook/packages/install — a synchronous,
// allowlisted `python -m pip install` in the app's own environment.
//
// Layout mirrors the Agent Tools tab: two top-level admin-cards ("AD app"
// and "Server"), each with its own description — no wrapping section.

import uiModule from './ui.js';

const esc = uiModule.esc;

// Per-package inline glyphs — accent-coloured marks for the serving
// engines. Unknown packages get no icon (the name alone is fine).
const _GLYPHS = {
  sglang: '<span aria-hidden="true" style="display:block;width:13px;height:13px;background:currentColor;-webkit-mask:url(/static/icons/sglang-mark.png) center/contain no-repeat;mask:url(/static/icons/sglang-mark.png) center/contain no-repeat;"></span>',
  llama_cpp: '<svg width="13" height="13" viewBox="0 0 600 600" fill="none" aria-hidden="true"><path d="M600 392L504.249 558L504.137 557.929C487.252 584.069 458.193 600 426.864 600H120L240 392H600Z" fill="currentColor"/><path d="M240 392H0L199.602 46.0254C216.032 17.5463 246.411 0 279.29 0H466.154L240 392Z" fill="currentColor"/></svg>',
  diffusers: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>',
};

function _glyphHtml(name) {
  const g = _GLYPHS[name];
  return g ? `<span class="dep-glyph" aria-hidden="true">${g}</span>` : '';
}

function _statusTag(pkg) {
  if (pkg.installed) {
    const tip = esc(pkg.update_note || pkg.status_note || 'Installed');
    return `<span class="dep-tag dep-installed" title="${tip}">Installed</span>`;
  }
  return `<button type="button" class="dep-tag dep-install" data-dep-pip="${esc(pkg.pip)}">Install</button>`;
}

function _row(pkg) {
  // llama_cpp carries a dynamic build-deps/status note (cmake/g++/git probe)
  // that clutters the card — show only its short description.
  const _hideNotes = pkg.name === 'llama_cpp';
  const note = (pkg.status_note && !_hideNotes)
    ? `<div class="memory-item-meta" style="font-size:14px;opacity:0.65;margin-top:3px;">${esc(pkg.status_note)}</div>`
    : '';
  const updateNote = (pkg.installed && pkg.update_note && !_hideNotes)
    ? `<div class="memory-item-meta" style="font-size:14px;opacity:0.55;margin-top:3px;">${esc(pkg.update_note)}</div>`
    : '';
  return `<div class="dep-row" data-pkg-name="${esc(pkg.name)}">`
    + `<div class="dep-info">`
    + `<div class="memory-item-title">${_glyphHtml(pkg.name)}${esc(pkg.name)}</div>`
    + `<div class="memory-item-meta" style="font-size:14px;opacity:0.5;margin-top:2px;">${esc(pkg.desc)}</div>`
    + note
    + updateNote
    + `</div>`
    + `<span class="dep-tag dep-cat">${esc(pkg.category)}</span>`
    + _statusTag(pkg)
    + `</div>`;
}

async function _install(btn, container) {
  const pip = btn.dataset.depPip;
  if (!pip) return;
  const name = btn.closest('.dep-row')?.dataset.pkgName || pip;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  try {
    const res = await fetch('/api/cookbook/packages/install', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pip }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const reason = data.detail || data.error || `HTTP ${res.status}`;
      uiModule.showToast('Install failed: ' + String(reason).slice(0, 400), {
        duration: 20000, action: 'OK', onAction: () => {},
      });
      btn.disabled = false;
      btn.textContent = 'Install';
      return;
    }
    uiModule.showToast(`Installed ${name}`);
    await _fillLists(container);   // refresh statuses
  } catch (err) {
    uiModule.showToast('Install failed: ' + err.message, {
      duration: 20000, action: 'OK', onAction: () => {},
    });
    btn.disabled = false;
    btn.textContent = 'Install';
  }
}

async function _fillLists(container) {
  const appList = container.querySelector('#deps-app-list');
  const serverList = container.querySelector('#deps-server-list');
  if (!appList || !serverList) return;
  try {
    const resp = await fetch('/api/cookbook/packages', { credentials: 'same-origin' });
    const data = await resp.json();
    const pkgs = data.packages || [];
    const appPkgs = pkgs.filter(p => p.target === 'local');
    const serverPkgs = pkgs.filter(p => p.target !== 'local');
    appList.innerHTML = appPkgs.map(_row).join('') || '<div class="dep-loading">No packages found</div>';
    serverList.innerHTML = serverPkgs.map(_row).join('') || '<div class="dep-loading">No packages found</div>';
    container.querySelectorAll('.dep-install').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _install(btn, container);
      });
    });
  } catch (err) {
    appList.innerHTML = `<div class="dep-loading">Failed to load packages: ${esc(err.message)}</div>`;
    serverList.innerHTML = '';
  }
}

const _BOX_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;opacity:0.6"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
const _SERVER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;opacity:0.6"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>';

export async function renderDependenciesPanel(container) {
  if (!container) return;
  container.innerHTML =
    `<div class="admin-card" style="margin-bottom:12px;">`
    + `<h2>${_BOX_ICON}AD app</h2>`
    + `<div class="admin-toggle-sub" style="margin-bottom:8px">Optional packages for features that run inside the AD app itself.</div>`
    + `<div class="deps-list" id="deps-app-list"><div class="dep-loading">Loading packages…</div></div>`
    + `</div>`
    + `<div class="admin-card" style="margin-bottom:12px;">`
    + `<h2>${_SERVER_ICON}Server</h2>`
    + `<div class="admin-toggle-sub" style="margin-bottom:8px">Optional packages for serving local models on this machine.</div>`
    + `<div class="deps-list" id="deps-server-list"><div class="dep-loading">Loading packages…</div></div>`
    + `</div>`;
  await _fillLists(container);
}
