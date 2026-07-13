// static/js/settings.js — Settings panel module (ES6)
// User-facing preferences: AI models, search, appearance

import uiModule from './ui.js';
import searchModule from './search.js';
import { makeWindowDraggable } from './windowDrag.js';
import { clearDockSide } from './modalSnap.js';
import { sortModelIds } from './modelSort.js';
import { providerLogo } from './providers.js';
import { isAltGrEvent } from './platform.js';
import { bindMenuDismiss } from './escMenuStack.js';

let initialized = false;
let modalEl = null;

function el(id) { return document.getElementById(id); }
function esc(s) { return uiModule.esc(s); }
function safeRasterDataUrl(raw) {
  const value = String(raw || '').trim();
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value) ? value : '';
}

/* ── Tab switching ── */
const ADMIN_TABS = new Set(['services', 'integrations', 'tools', 'users', 'system']);

/* Two-level vertical nav state (narrow/page layouts): false = section list,
   true = a section panel with the back row. Scrolls to the top on each flip
   so a "navigation" feels like a page change, not a scroll position. */
function _setPanelActive(on) {
  const content = modalEl && modalEl.querySelector('.settings-modal-content');
  if (!content) return;
  content.classList.toggle('settings-panel-active', !!on);
  content.scrollTop = 0;
  const panels = content.querySelector('.settings-panels');
  if (panels) panels.scrollTop = 0;
}

function initTabs() {
  // Narrow/page layouts run a two-level vertical nav: section list first,
  // then the chosen panel with a back row on top. The class is toggled on
  // every layout — CSS only acts on it below the narrow breakpoint.
  const backRow = modalEl.querySelector('#settings-back-row');
  if (backRow) {
    backRow.addEventListener('click', () => {
      _setPanelActive(false);
      // Leaving the Appearance panel via "back" must undo its page-dim state,
      // same as switching tabs or closing the modal does.
      document.body.classList.remove('settings-appearance-open');
      syncAppearanceOpacity(false);
    });
  }
  modalEl.querySelectorAll('[data-settings-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.settingsTab;
      _setPanelActive(true);
      // Lazy-init admin when first clicking an admin tab
      if (ADMIN_TABS.has(tab) && window.adminModule && typeof window.adminModule.open === 'function') {
        window.adminModule.open(tab);
        return;
      }
      modalEl.querySelectorAll('[data-settings-tab]').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tab));
      modalEl.querySelectorAll('[data-settings-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.settingsPanel !== tab));
      // Mark when the Appearance tab is open so the modal can go
      // semi-transparent — lets the user see the rest of the UI react as
      // they flip toggles instead of having to close + reopen the modal.
      document.body.classList.toggle('settings-appearance-open', tab === 'appearance');
      syncAppearanceOpacity(tab === 'appearance');
      if (tab === 'ai') refreshAiModelEndpoints();
      if (tab === 'dependencies') {
        // Re-render on every open so installed status is fresh.
        import('./dependencies.js')
          .then(m => m.renderDependenciesPanel(document.getElementById('settings-deps-root')))
          .catch(e => console.error('Dependencies panel failed to load:', e));
      }
    });
  });
}

/* ── Dragging ── */
function initDrag() {
  const header = modalEl.querySelector('.modal-header');
  const content = modalEl.querySelector('.settings-modal-content');
  if (!header || !content) return;
  // Skip interactive controls in the header (e.g. the opacity slider) so
  // grabbing them doesn't start a window-drag.
  makeWindowDraggable(modalEl, {
    content,
    header,
    skipSelector: 'button, input, select, .theme-opacity-wrap',
    enableDock: true,
  });
}

function resetWindowPlacement() {
  const content = modalEl && modalEl.querySelector('.settings-modal-content');
  if (!content) return;
  const hadLeft = modalEl.classList.contains('modal-left-docked');
  const hadRight = modalEl.classList.contains('modal-right-docked');
  modalEl.classList.remove('modal-left-docked', 'modal-right-docked');
  if (hadLeft) clearDockSide('left', modalEl);
  if (hadRight) clearDockSide('right', modalEl);
  if (content._leftDockNavObs) {
    try { content._leftDockNavObs.navObs && content._leftDockNavObs.navObs.disconnect(); } catch (_) {}
    try { window.removeEventListener('resize', content._leftDockNavObs.reanchor); } catch (_) {}
    delete content._leftDockNavObs;
  }
  delete content._preDockSnapshot;
  delete content._dockSide;
  delete content._dockSuspended;
  delete content.dataset._tilePreSnap;
  delete content.dataset._tileZone;
  [
    'position', 'left', 'top', 'right', 'bottom', 'margin', 'transform',
    'width', 'height', 'max-width', 'max-height', 'border-radius', 'transition',
  ].forEach(prop => content.style.removeProperty(prop));
}

/* ── Delegated link: close Settings + open the Prompt (characters) modal ── */
function initOpenPromptModalLink() {
  document.addEventListener('click', async (e) => {
    const link = e.target.closest('[data-open-prompt-modal]');
    if (!link) return;
    e.preventDefault();
    // Close settings first so the prompt modal isn't stacked on top.
    if (modalEl && !modalEl.classList.contains('hidden')) close();
    try {
      const m = await import('./presets.js');
      const fn = m.openCustomPresetModal || (m.default && m.default.openCustomPresetModal);
      if (typeof fn === 'function') fn();
    } catch (_) {
      const modal = document.getElementById('custom-preset-modal');
      if (modal) modal.classList.remove('hidden');
    }
    // Force the Persona tab (data-chartab="character") since the link's
    // whole purpose is editing personas — not landing on Inject by default.
    const personaTab = document.querySelector('#custom-preset-modal .preset-tab[data-chartab="character"]');
    if (personaTab) personaTab.click();
  });
}

/* ── Close on backdrop / X ── */
function initClose() {
  modalEl.querySelector('.close-btn').addEventListener('click', close);
  modalEl.addEventListener('mousedown', e => {
    if (uiModule.isTouchInsideModal()) return;
    if (e.target === modalEl) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !modalEl || modalEl.classList.contains('hidden')) return;
    // Bail when a transient popover inside the modal is open — Esc should
    // dismiss just that, not the whole modal. Same-document listeners fire
    // in registration order regardless of capture/bubble, so the popover's
    // own handler can't pre-empt ours; we have to opt out here.
    const popoverOpen = modalEl.querySelector(
      '#adm-epLocalMoreMenu, #adm-epApiMoreMenu, #adm-provider-menu, #search-provider-menu, [data-popover-open="1"]'
    );
    if (popoverOpen && popoverOpen.style.display !== 'none' && !popoverOpen.classList.contains('hidden')) {
      return;
    }
    // If an integration edit/add form is open inside the modal, close
    // just that — don't dismiss the whole settings modal. (Pressing
    // ESC mid-edit and losing the modal was a fast-typing footgun.)
    const innerForm = modalEl.querySelector('#unified-intg-form');
    if (innerForm && innerForm.style.display !== 'none' && innerForm.children.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      innerForm.style.display = 'none';
      innerForm.innerHTML = '';
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    close();
  });
}

/* ── Appearance-tab opacity slider ──
   Mirrors the Theme customizer's slider: fades the settings modal's
   background (and inner cards) via color-mix so the user can watch the
   rest of the UI react to toggles, while keeping text/controls crisp
   (no element opacity). Only shown/active on the Appearance tab. */
const _SETTINGS_PEEK = 55; // % opacity when the Peek toggle is on
function _applySettingsOpacity(on) {
  const content = modalEl && modalEl.querySelector('.settings-modal-content, .modal-content');
  if (!content) return;
  const cards = content.querySelectorAll('.admin-card');
  if (on) {
    const bgMix = `color-mix(in srgb, var(--bg) ${_SETTINGS_PEEK}%, transparent)`;
    const panelMix = `color-mix(in srgb, var(--panel) ${_SETTINGS_PEEK}%, transparent)`;
    content.style.setProperty('background', bgMix, 'important');
    content.style.setProperty('backdrop-filter', 'none', 'important');
    content.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    cards.forEach(c => {
      c.style.setProperty('background', panelMix, 'important');
      c.style.setProperty('backdrop-filter', 'none', 'important');
      c.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    });
  } else {
    content.style.removeProperty('background');
    content.style.removeProperty('backdrop-filter');
    content.style.removeProperty('-webkit-backdrop-filter');
    cards.forEach(c => {
      c.style.removeProperty('background');
      c.style.removeProperty('backdrop-filter');
      c.style.removeProperty('-webkit-backdrop-filter');
    });
  }
}

// Show/hide the Peek toggle for the Appearance tab and apply or clear the fade.
function syncAppearanceOpacity(active) {
  const toggle = el('settings-opacity-wrap');
  if (toggle) toggle.classList.toggle('hidden', !active);
  if (active) {
    _applySettingsOpacity(toggle ? toggle.classList.contains('active') : false);
  } else {
    _applySettingsOpacity(false); // clear the fade off the Appearance tab
  }
}

function initOpacityToggle() {
  const toggle = el('settings-opacity-wrap');
  if (!toggle || toggle.dataset.bound === '1') return;
  toggle.dataset.bound = '1';
  toggle.addEventListener('click', () => {
    const on = !toggle.classList.contains('active');
    toggle.classList.toggle('active', on);
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    _applySettingsOpacity(on);
  });
}

/* ═══════════════════════════════════════════
   AI TAB
   ═══════════════════════════════════════════ */

const _aiEndpointRefreshers = new Set();
let _aiEndpointRefreshInFlight = null;

async function _fetchModelEndpoints() {
  const epRes = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
  const endpoints = await epRes.json();
  return Array.isArray(endpoints) ? endpoints : [];
}

function _endpointLabel(ep) {
  return ep.name + (ep.online ? '' : ' (offline)');
}

function _fillEndpointSelect(selectEl, endpoints, selected, keepBlank) {
  if (!selectEl) return;
  const previous = selected !== undefined ? selected : selectEl.value;
  const blankText = keepBlank && selectEl.options[0] && selectEl.options[0].value === ''
    ? selectEl.options[0].textContent
    : null;
  while (selectEl.options.length) selectEl.remove(0);
  if (blankText !== null) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankText;
    selectEl.appendChild(blank);
  }
  (endpoints || []).forEach(function(ep) {
    if (!ep.is_enabled) return;
    const opt = document.createElement('option');
    opt.value = ep.id;
    opt.textContent = _endpointLabel(ep);
    selectEl.appendChild(opt);
  });
  if (previous && Array.from(selectEl.options).some(function(o) { return o.value === previous; })) {
    selectEl.value = previous;
  } else if (blankText !== null) {
    selectEl.value = '';
  }
  _syncEndpointLogo(selectEl);
}

// Mirror the selected model's provider logo into a sibling <span id="<selectId>-logo">.
// Wires the change listener exactly once so we can call this every time the
// select is repopulated without piling on duplicate handlers.
function _syncModelLogo(selectEl) {
  if (!selectEl) return;
  const logoEl = document.getElementById(selectEl.id + '-logo');
  if (!logoEl) return;
  const apply = () => { logoEl.innerHTML = providerLogo(selectEl.value) || ''; };
  apply();
  if (!selectEl.dataset.logoSync) {
    selectEl.dataset.logoSync = '1';
    selectEl.addEventListener('change', apply);
  }
}

// Same idea but for endpoint dropdowns where the <option value="…">
// is an opaque endpoint UUID — fall back to the option's text label
// so providerLogo() can pattern-match (Anthropic, OpenAI, Ollama, …).
function _syncEndpointLogo(selectEl) {
  if (!selectEl) return;
  const logoEl = document.getElementById(selectEl.id + '-logo');
  if (!logoEl) return;
  const apply = () => {
    const opt = selectEl.options[selectEl.selectedIndex];
    const label = (opt && opt.textContent) || selectEl.value || '';
    logoEl.innerHTML = providerLogo(label) || '';
  };
  apply();
  if (!selectEl.dataset.epLogoSync) {
    selectEl.dataset.epLogoSync = '1';
    selectEl.addEventListener('change', apply);
  }
}

function _fillModelSelect(selectEl, models, selected, keepBlank) {
  if (!selectEl) return;
  const previous = selected !== undefined ? selected : selectEl.value;
  const blankText = keepBlank && selectEl.options[0] && selectEl.options[0].value === ''
    ? selectEl.options[0].textContent
    : null;
  while (selectEl.options.length) selectEl.remove(0);
  if (blankText !== null) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankText;
    selectEl.appendChild(blank);
  }
  sortModelIds(models).forEach(function(m) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = String(m).split('/').pop();
    selectEl.appendChild(opt);
  });
  if (previous && Array.from(selectEl.options).some(function(o) { return o.value === previous; })) {
    selectEl.value = previous;
  } else if (blankText !== null) {
    selectEl.value = '';
  }
  _syncModelLogo(selectEl);
}

function _registerAiEndpointRefresh(fn) {
  _aiEndpointRefreshers.add(fn);
}

export async function refreshAiModelEndpoints() {
  if (_aiEndpointRefreshInFlight) return _aiEndpointRefreshInFlight;
  _aiEndpointRefreshInFlight = (async function() {
    try {
      const endpoints = await _fetchModelEndpoints();
      _aiEndpointRefreshers.forEach(function(fn) {
        try { fn(endpoints); } catch (e) { console.warn('[settings] endpoint refresh handler failed', e); }
      });
    } catch (e) {
      console.warn('[settings] failed to refresh model endpoints', e);
    } finally {
      _aiEndpointRefreshInFlight = null;
    }
  })();
  return _aiEndpointRefreshInFlight;
}

/* Shared fallback-chain widget — mirrors the Default Chat Model fallback UI
 * for other model cards (Utility, Vision, …). Pass in the container/button
 * IDs, the endpoints list, the settings key to persist under, and the
 * model-filter (for Vision we exclude non-chat-capable models).
 */
function _bindFallbackWidget(opts) {
  var fbContainer = el(opts.containerId);
  var addBtn = el(opts.addBtnId);
  var endpointsRef = opts.endpoints;       // mutable list reference
  var modelsFilter = opts.modelsFilter || function() { return true; };
  var settingKey = opts.settingKey;
  var current = opts.initial || [];        // [{endpoint_id, model}]

  if (!fbContainer || !addBtn) return { setEndpoints: function() {}, setInitial: function() {} };

  function enabledEps() { return (endpointsRef() || []).filter(function(e) { return e.is_enabled; }); }

  function fillModels(selectEl, epId, selected) {
    while (selectEl.options.length) selectEl.remove(0);
    var ep = (endpointsRef() || []).find(function(e) { return e.id === epId; });
    if (ep && ep.models) {
      sortModelIds(ep.models).forEach(function(m) {
        if (!modelsFilter(m, ep)) return;
        var o = document.createElement('option');
        o.value = m;
        o.textContent = m.split('/').pop();
        selectEl.appendChild(o);
      });
    }
    if (selected) selectEl.value = selected;
  }

  async function save() {
    var clean = current.filter(function(f) { return f.endpoint_id && f.model; });
    var body = {};
    body[settingKey] = clean;
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) { console.warn('[fallback] save failed for ' + settingKey, e); }
  }

  function render() {
    fbContainer.innerHTML = '';
    current.forEach(function(fb, idx) {
      var row = document.createElement('div');
      row.className = 'settings-fallback-row';

      var num = document.createElement('span');
      num.className = 'settings-fallback-num';
      num.textContent = (idx + 1) + '.';

      var epS = document.createElement('select');
      epS.className = 'settings-select';
      enabledEps().forEach(function(ep) {
        var o = document.createElement('option');
        o.value = ep.id;
        o.textContent = ep.name + (ep.online ? '' : ' (offline)');
        epS.appendChild(o);
      });
      var first = enabledEps()[0];
      epS.value = fb.endpoint_id || (first ? first.id : '');

      var mS = document.createElement('select');
      mS.className = 'settings-select';
      fillModels(mS, epS.value, fb.model);

      fb.endpoint_id = epS.value;
      fb.model = mS.value;

      epS.addEventListener('change', function() {
        fb.endpoint_id = epS.value;
        fillModels(mS, epS.value, '');
        fb.model = mS.value;
        save();
      });
      mS.addEventListener('change', function() { fb.model = mS.value; save(); });

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'settings-fallback-remove';
      rm.title = 'Remove fallback';
      rm.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      rm.addEventListener('click', function() {
        current.splice(idx, 1);
        render();
        save();
      });

      row.appendChild(num);
      row.appendChild(epS);
      row.appendChild(mS);
      row.appendChild(rm);
      fbContainer.appendChild(row);
    });
  }

  addBtn.addEventListener('click', function() {
    var first = enabledEps()[0];
    current.push({ endpoint_id: first ? first.id : '', model: '' });
    render();
    save();
  });

  render();

  return {
    setInitial: function(list) { current = (list || []).slice(); render(); },
    refresh: render,
  };
}

/* ── Default Chat Model ── */
async function initDefaultChat() {
  var epSel = el('set-defaultEpSelect');
  var modelSel = el('set-defaultModelSelect');
  var msg = el('set-defaultChatMsg');
  var fbContainer = el('set-defaultFallbacks');
  var addFbBtn = el('set-defaultAddFallback');
  var _endpoints = [];
  var _fallbacks = []; // [{endpoint_id, model}] — tried in order if primary fails

  function enabledEndpoints() {
    return _endpoints.filter(function(e) { return e.is_enabled; });
  }

  // Fill any <select> with the models for a given endpoint id.
  function fillModels(selectEl, epId, selected) {
    var ep = _endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(selectEl, ep ? ep.models : [], selected, false);
  }

  try {
    _endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, _endpoints, epSel.value, false);
  } catch (e) { console.warn('Failed to load endpoints for default chat', e); }

  function refreshModels(selectedModel) { fillModels(modelSel, epSel.value, selectedModel); }
  function refreshEndpointOptions(selectedEndpoint, selectedModel) {
    _fillEndpointSelect(epSel, _endpoints, selectedEndpoint !== undefined ? selectedEndpoint : epSel.value, false);
    refreshModels(selectedModel !== undefined ? selectedModel : modelSel.value);
    renderFallbacks();
  }

  // Render the fallback chain. Each row is endpoint + model + remove.
  function renderFallbacks() {
    fbContainer.innerHTML = '';
    _fallbacks.forEach(function(fb, idx) {
      var row = document.createElement('div');
      row.className = 'settings-fallback-row';

      var num = document.createElement('span');
      num.className = 'settings-fallback-num';
      num.textContent = (idx + 1) + '.';

      var epS = document.createElement('select');
      epS.className = 'settings-select';
      enabledEndpoints().forEach(function(ep) {
        var o = document.createElement('option');
        o.value = ep.id;
        o.textContent = ep.name + (ep.online ? '' : ' (offline)');
        epS.appendChild(o);
      });
      var first = enabledEndpoints()[0];
      epS.value = fb.endpoint_id || (first ? first.id : '');

      var mS = document.createElement('select');
      mS.className = 'settings-select';
      fillModels(mS, epS.value, fb.model);

      // Keep the model in sync with the values actually shown.
      fb.endpoint_id = epS.value;
      fb.model = mS.value;

      epS.addEventListener('change', function() {
        fb.endpoint_id = epS.value;
        fillModels(mS, epS.value, '');
        fb.model = mS.value;
        saveDefault();
      });
      mS.addEventListener('change', function() { fb.model = mS.value; saveDefault(); });

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'settings-fallback-remove';
      rm.title = 'Remove fallback';
      rm.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      rm.addEventListener('click', function() {
        _fallbacks.splice(idx, 1);
        renderFallbacks();
        saveDefault();
      });

      row.appendChild(num);
      row.appendChild(epS);
      row.appendChild(mS);
      row.appendChild(rm);
      fbContainer.appendChild(row);
    });
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.default_endpoint_id) epSel.value = settings.default_endpoint_id;
    refreshModels(settings.default_model || '');
    _fallbacks = Array.isArray(settings.default_model_fallbacks)
      ? settings.default_model_fallbacks.map(function(f) {
          return { endpoint_id: (f && f.endpoint_id) || '', model: (f && f.model) || '' };
        })
      : [];
    renderFallbacks();
  } catch (e) { console.warn('Failed to load default chat settings', e); }

  epSel.addEventListener('change', function() { refreshModels(''); saveDefault(); });
  modelSel.addEventListener('change', saveDefault);

  async function saveDefault() {
    try {
      var clean = _fallbacks.filter(function(f) { return f.endpoint_id && f.model; });
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default_endpoint_id: epSel.value,
          default_model: modelSel.value,
          default_model_fallbacks: clean
        })
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  if (addFbBtn) addFbBtn.addEventListener('click', function() {
    var first = enabledEndpoints()[0];
    _fallbacks.push({ endpoint_id: first ? first.id : '', model: '' });
    renderFallbacks();
    saveDefault();
  });

  _registerAiEndpointRefresh(function(endpoints) {
    _endpoints = endpoints;
    refreshEndpointOptions(epSel.value, modelSel.value);
  });
}

/* ── Utility Model ── */
async function initUtilityModel() {
  var epSel = el('set-utilityEpSelect');
  var modelSel = el('set-utilityModelSelect');
  var msg = el('set-utilityChatMsg');
  var _endpoints = [];
  var fallbackWidget = null;
  if (epSel && epSel.options[0]) epSel.options[0].textContent = 'Same as chat';
  if (modelSel && modelSel.options[0]) modelSel.options[0].textContent = 'Same as chat';

  try {
    _endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
  } catch (e) { console.warn('Failed to load endpoints for utility model', e); }

  function refreshModels(selectedModel) {
    var epId = epSel.value;
    var ep = _endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true);
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.utility_endpoint_id) epSel.value = settings.utility_endpoint_id;
    refreshModels(settings.utility_model || '');
    fallbackWidget = _bindFallbackWidget({
      containerId: 'set-utilityFallbacks',
      addBtnId: 'set-utilityAddFallback',
      endpoints: function() { return _endpoints; },
      settingKey: 'utility_model_fallbacks',
      initial: Array.isArray(settings.utility_model_fallbacks)
        ? settings.utility_model_fallbacks.map(function(f) { return { endpoint_id: (f && f.endpoint_id) || '', model: (f && f.model) || '' }; })
        : [],
    });
  } catch (e) { console.warn('Failed to load utility model settings', e); }

  // Persist whatever's currently selected. Empty endpoint or model → backend
  // transparently falls back to the chat model (mirrors the teacher panel:
  // no toggle, "—" means "unset, use chat").
  async function saveUtility() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          utility_endpoint_id: epSel.value || '',
          utility_model: modelSel.value || ''
        })
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 1500);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  epSel.addEventListener('change', function() { refreshModels(''); saveUtility(); });
  modelSel.addEventListener('change', saveUtility);

  _registerAiEndpointRefresh(function(endpoints) {
    _endpoints = endpoints;
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
    refreshModels(modelSel.value);
    if (fallbackWidget && fallbackWidget.refresh) fallbackWidget.refresh();
  });
}

/* ── Teacher Model ── */
// SOTA model called automatically when a self-hosted student model
// fails an agent-mode task. Stored as a single `teacher_model` string
// in the form `model@endpoint_name` so the backend's _resolve_model
// can dispatch directly. Master toggle is the separate
// `teacher_enabled` flag so the user can pause the feature without
// losing their endpoint+model selection.
async function initTeacherModel() {
  var enabledToggle = el('set-teacherEnabledToggle');
  var epSel = el('set-teacherEpSelect');
  var modelSel = el('set-teacherModelSelect');
  var msg = el('set-teacherChatMsg');
  if (!epSel || !modelSel) return;
  var _endpoints = [];

  try {
    _endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
  } catch (e) { console.warn('Failed to load endpoints for teacher model', e); }

  function refreshModels(selectedModel) {
    var epId = epSel.value;
    var ep = _endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true);
  }

  // Disable / enable the endpoint+model dropdowns based on the
  // master switch. Greys them out so users see at a glance that the
  // selection is dormant.
  function syncEnabled() {
    var off = enabledToggle ? !enabledToggle.checked : true;
    // Dim the card when off as a "dormant" cue, but keep the endpoint+model
    // dropdowns INTERACTIVE — the toggle gates whether escalation runs, not
    // whether you can configure it. (Previously the config was inert when off,
    // so users couldn't pick an endpoint until they'd already enabled it.)
    var card = enabledToggle ? enabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.7' : '';
    var wrap = card ? card.querySelector('.settings-col') : null;
    if (wrap) wrap.style.pointerEvents = '';
    epSel.disabled = false;
    modelSel.disabled = false;
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (enabledToggle) enabledToggle.checked = !!settings.teacher_enabled;
    // teacher_model is stored as "model@endpoint_name". Split on the
    // LAST `@` so model ids that contain @ aren't mangled.
    var spec = settings.teacher_model || '';
    var savedModel = spec;
    var savedEpName = '';
    var at = spec.lastIndexOf('@');
    if (at >= 0) {
      savedModel = spec.slice(0, at);
      savedEpName = spec.slice(at + 1);
    }
    if (savedEpName) {
      var match = _endpoints.find(function(ep) {
        return ep.name && ep.name.toLowerCase().indexOf(savedEpName.toLowerCase()) >= 0;
      });
      if (match) epSel.value = match.id;
    }
    refreshModels(savedModel);
    syncEnabled();
  } catch (e) { console.warn('Failed to load teacher model settings', e); }

  async function saveTeacher() {
    try {
      var spec = '';
      if (epSel.value && modelSel.value) {
        var ep = _endpoints.find(function(e) { return e.id === epSel.value; });
        spec = ep ? (modelSel.value + '@' + ep.name) : modelSel.value;
      }
      var enabled = enabledToggle ? !!enabledToggle.checked : false;
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_enabled: enabled, teacher_model: spec })
      });
      msg.textContent = enabled ? (spec ? 'Saved' : 'Pick an endpoint + model') : 'Disabled';
      msg.style.color = enabled && !spec ? 'var(--red)' : 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  if (enabledToggle) {
    enabledToggle.addEventListener('change', function() {
      syncEnabled();
      saveTeacher();
    });
  }
  epSel.addEventListener('change', function() { refreshModels(''); saveTeacher(); });
  modelSel.addEventListener('change', saveTeacher);

  _registerAiEndpointRefresh(function(endpoints) {
    _endpoints = endpoints;
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
    refreshModels(modelSel.value);
  });
}

/* ── Image Generation ── */
async function initImageSettings() {
  const modelSel = el('set-imgModelSelect');
  const qualSel = el('set-imgQualitySelect');
  const msg = el('set-imgSettingsMsg');
  const enabledToggle = el('set-imgEnabledToggle');
  const configWrap = modelSel ? modelSel.closest('div[style*="flex-direction"]') : null;
  try {
    const modelsRes = await fetch('/api/models', { credentials: 'same-origin' });
    const modelsData = await modelsRes.json();
    // Inpaint-compat allowlist — image gen here is scoped to inpainting only,
    // so DALL-E / GPT-Image-1 (no inpaint API) are excluded. Currently:
    //   - any model with 'inpaint' in the id
    //   - Stable Diffusion 3.5 Medium (inpaint via diffusers pipeline)
    const _isInpaintModel = (mid) => {
      const lower = String(mid || '').toLowerCase();
      return lower.includes('inpaint')
        || lower.includes('3.5-medium')
        || lower.includes('3-5-medium')
        || lower.includes('sd-3.5-med');
    };
    const imageModels = [];
    (modelsData.items || []).forEach(item => {
      (item.models || []).forEach(mid => {
        if (_isInpaintModel(mid)) imageModels.push(mid);
      });
    });
    sortModelIds(imageModels).forEach(mid => { const opt = document.createElement('option'); opt.value = mid; opt.textContent = mid; modelSel.appendChild(opt); });
    // Hardcoded fallbacks shown as "(not detected)" so users know what to
    // download/serve to enable inpaint here.
    ['stable-diffusion-3.5-medium', 'stable-diffusion-inpainting'].forEach(mid => {
      if (!imageModels.includes(mid)) { const opt = document.createElement('option'); opt.value = mid; opt.textContent = mid + ' (not detected)'; modelSel.appendChild(opt); }
    });
  } catch (e) { console.warn('Failed to load models for image settings', e); }
  try {
    const settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const settings = await settingsRes.json();
    if (settings.image_model) modelSel.value = settings.image_model;
    if (settings.image_quality) qualSel.value = settings.image_quality;
    if (enabledToggle) enabledToggle.checked = settings.image_gen_enabled === true;
  } catch (e) { console.warn('Failed to load settings', e); }

  function syncImgDisabled() {
    var off = enabledToggle && !enabledToggle.checked;
    var card = enabledToggle ? enabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (configWrap) configWrap.style.pointerEvents = off ? 'none' : '';
  }
  syncImgDisabled();

  async function saveSettings() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_gen_enabled: enabledToggle ? enabledToggle.checked : false, image_model: modelSel.value, image_quality: qualSel.value }) });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)'; setTimeout(() => { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }
  modelSel.addEventListener('change', saveSettings);
  qualSel.addEventListener('change', saveSettings);
  if (enabledToggle) enabledToggle.addEventListener('change', function() { syncImgDisabled(); saveSettings(); });
}

/* ── Vision ── */
async function initVisionSettings() {
  const vlSel = el('set-vlModelSelect');
  const msg = el('set-visionSettingsMsg');
  const enabledToggle = el('set-visionEnabledToggle');
  const configWrap = vlSel ? vlSel.closest('div[style*="flex-direction"]') : null;
  var _visionEndpoints = [];
  var visionFallbackWidget = null;
  var _vlExclude = ['audio', 'realtime', 'tts', 'dall-e', 'embedding', 'search', 'whisper'];
  function _isVisionModel(mid) {
    var lower = String(mid || '').toLowerCase();
    return !_vlExclude.some(function(kw) { return lower.includes(kw); });
  }
  try {
    const modelsRes = await fetch('/api/models', { credentials: 'same-origin' });
    const modelsData = await modelsRes.json();
    const visionModels = [];
    (modelsData.items || []).forEach(item => {
      if (item.offline) return;
      (item.models || []).forEach(mid => {
        if (_isVisionModel(mid)) {
          visionModels.push(mid);
        }
      });
    });
    sortModelIds(visionModels).forEach(mid => {
      var opt = document.createElement('option'); opt.value = mid; opt.textContent = mid; vlSel.appendChild(opt);
    });
  } catch (e) { console.warn('Failed to load models for vision settings', e); }
  // Also pull the raw endpoint list so the fallback widget can resolve
  // endpoint-id → models the same way the other cards do.
  try {
    _visionEndpoints = await _fetchModelEndpoints();
  } catch (e) { console.warn('Failed to load endpoints for vision fallback', e); }
  try {
    const settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const settings = await settingsRes.json();
    if (settings.vision_model) vlSel.value = settings.vision_model;
    _syncModelLogo(vlSel);
    if (enabledToggle) enabledToggle.checked = settings.vision_enabled !== false;
    visionFallbackWidget = _bindFallbackWidget({
      containerId: 'set-visionFallbacks',
      addBtnId: 'set-visionAddFallback',
      endpoints: function() { return _visionEndpoints; },
      // Vision fallback list filters to vision-capable models (same heuristic
      // as the primary select above — exclude audio/tts/embedding/etc.).
      modelsFilter: function(mid) { return _isVisionModel(mid); },
      settingKey: 'vision_model_fallbacks',
      initial: Array.isArray(settings.vision_model_fallbacks)
        ? settings.vision_model_fallbacks.map(function(f) { return { endpoint_id: (f && f.endpoint_id) || '', model: (f && f.model) || '' }; })
        : [],
    });
  } catch (e) { console.warn('Failed to load vision settings', e); }

  function syncVisionDisabled() {
    var off = enabledToggle && !enabledToggle.checked;
    var card = enabledToggle ? enabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (configWrap) configWrap.style.pointerEvents = off ? 'none' : '';
  }
  syncVisionDisabled();

  async function saveSettings() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vision_enabled: enabledToggle ? enabledToggle.checked : true, vision_model: vlSel.value }) });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)'; setTimeout(() => { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }
  vlSel.addEventListener('change', saveSettings);
  if (enabledToggle) enabledToggle.addEventListener('change', function() { syncVisionDisabled(); saveSettings(); });

  _registerAiEndpointRefresh(function(endpoints) {
    _visionEndpoints = endpoints;
    if (visionFallbackWidget && visionFallbackWidget.refresh) visionFallbackWidget.refresh();
  });
}

/* ── Face Recognition ── */

/* ── Text to Speech ── */
async function initTtsSettings() {
  var provSel = el('set-ttsProviderSelect');
  var modelSelect = el('set-ttsModelSelect');
  var modelInput = el('set-ttsModelInput');
  var voiceSelect = el('set-ttsVoiceSelect');
  var voiceInput = el('set-ttsVoiceInput');
  var modelRow = el('set-ttsModelRow');
  var voiceRow = el('set-ttsVoiceRow');
  var speedSelect = el('set-ttsSpeedSelect');
  var speedRow = el('set-ttsSpeedRow');
  var ttsMsg = el('set-ttsSettingsMsg');
  var ttsEnabledToggle = el('set-ttsEnabledToggle');
  var ttsConfigWrap = provSel ? provSel.closest('div[style*="flex-direction"]') : null;

  function isEndpoint() { return provSel.value.startsWith('endpoint:'); }
  function getModel() { return isEndpoint() ? modelSelect.value : modelInput.value; }
  function getVoice() { return isEndpoint() ? voiceSelect.value : voiceInput.value; }

  function updateVisibility() {
    var prov = provSel.value;
    modelRow.style.display = prov.startsWith('endpoint:') ? 'flex' : 'none';
    voiceRow.style.display = prov === 'disabled' ? 'none' : 'flex';
    speedRow.style.display = prov === 'disabled' ? 'none' : 'flex';
    if (isEndpoint()) {
      modelSelect.style.display = ''; modelInput.style.display = 'none';
      voiceSelect.style.display = ''; voiceInput.style.display = 'none';
    } else {
      modelSelect.style.display = 'none'; modelInput.style.display = '';
      voiceSelect.style.display = 'none'; voiceInput.style.display = prov === 'disabled' ? 'none' : '';
    }
  }

  var ttsKeywords = ['tts', 'audio'];
  try {
    var epRes = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
    var endpoints = await epRes.json();
    endpoints.forEach(function(ep) {
      if (!ep.is_enabled) return;
      var hasTTS = (ep.models || []).some(m => ttsKeywords.some(kw => m.toLowerCase().includes(kw)));
      if (!hasTTS) return;
      var opt = document.createElement('option'); opt.value = 'endpoint:' + ep.id; opt.textContent = ep.name + ' (API)'; provSel.appendChild(opt);
    });
  } catch (e) { console.warn('Failed to load endpoints for TTS', e); }

  try {
    var settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await settingsRes.json();
    if (settings.tts_provider) provSel.value = settings.tts_provider;
    if (settings.tts_model) { modelSelect.value = settings.tts_model; modelInput.value = settings.tts_model; }
    if (settings.tts_voice) { voiceSelect.value = settings.tts_voice; voiceInput.value = settings.tts_voice; }
    if (settings.tts_speed) { speedSelect.value = settings.tts_speed; }
    if (ttsEnabledToggle) ttsEnabledToggle.checked = settings.tts_enabled !== false;
  } catch (e) { console.warn('Failed to load TTS settings', e); }

  function syncTtsDisabled() {
    var off = ttsEnabledToggle && !ttsEnabledToggle.checked;
    var card = ttsEnabledToggle ? ttsEnabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (ttsConfigWrap) ttsConfigWrap.style.pointerEvents = off ? 'none' : '';
  }
  syncTtsDisabled();
  updateVisibility();

  async function saveTTS() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts_enabled: ttsEnabledToggle ? ttsEnabledToggle.checked : true, tts_provider: provSel.value, tts_model: getModel() || 'tts-1', tts_voice: getVoice() || 'alloy', tts_speed: speedSelect.value || '1' }) });
      ttsMsg.textContent = 'Saved'; ttsMsg.style.color = 'var(--fg)'; setTimeout(() => { ttsMsg.textContent = ''; }, 2000);
      if (window.aiTTSManager) window.aiTTSManager.checkAvailability();
    } catch (e) { ttsMsg.textContent = 'Failed to save'; ttsMsg.style.color = 'var(--red)'; }
  }

  async function saveAndClearCache() {
    await saveTTS();
    fetch('/api/tts/clear-cache', { method: 'POST', credentials: 'same-origin' }).catch(function(){});
  }

  provSel.addEventListener('change', function() {
    var prov = provSel.value;
    if (prov === 'local') voiceInput.value = 'af_heart';
    else if (isEndpoint()) { voiceSelect.value = 'alloy'; modelSelect.value = 'tts-1'; }
    else if (prov === 'browser') { voiceInput.value = ''; voiceInput.placeholder = 'OS default voice'; }
    updateVisibility();
    saveTTS();
  });
  modelSelect.addEventListener('change', saveAndClearCache);
  modelInput.addEventListener('change', saveTTS);
  voiceSelect.addEventListener('change', saveAndClearCache);
  voiceInput.addEventListener('change', saveTTS);
  speedSelect.addEventListener('change', saveAndClearCache);
  if (ttsEnabledToggle) ttsEnabledToggle.addEventListener('change', function() { syncTtsDisabled(); saveTTS(); });

  // Preview / test button
  var previewBtn = el('set-ttsPreviewBtn');
  if (previewBtn) {
    var previewAudio = null;
    var previewPlaying = false;
    function resetPreview() { previewPlaying = false; previewBtn.textContent = 'Preview'; previewBtn.style.borderColor = ''; }

    previewBtn.addEventListener('click', async function() {
      if (previewPlaying) {
        if (previewAudio) { previewAudio.pause(); previewAudio = null; }
        window.speechSynthesis.cancel();
        resetPreview(); return;
      }
      var prov = provSel.value;
      if (prov === 'disabled') {
        ttsMsg.textContent = 'Select a provider first'; ttsMsg.style.color = 'var(--red, #e55)';
        setTimeout(function() { ttsMsg.textContent = ''; }, 2000); return;
      }
      var testText = 'Hello, this is a test of text to speech.';
      previewPlaying = true; previewBtn.textContent = 'Loading...';
      try {
        if (prov === 'browser') {
          if (!('speechSynthesis' in window)) throw new Error('Browser TTS not supported');
          var utt = new SpeechSynthesisUtterance(testText);
          var voiceVal = getVoice();
          if (voiceVal) {
            var voices = window.speechSynthesis.getVoices();
            var target = voiceVal.toLowerCase();
            var match = voices.find(function(v) { return v.name.toLowerCase() === target; }) ||
                        voices.find(function(v) { return v.name.toLowerCase().includes(target); });
            if (match) utt.voice = match;
          }
          utt.rate = parseFloat(speedSelect.value) || 1;
          previewBtn.textContent = 'Stop'; previewBtn.style.borderColor = 'var(--red, #e55)';
          await new Promise(function(resolve, reject) {
            utt.onend = resolve;
            utt.onerror = function(e) { reject(new Error('Browser TTS: ' + e.error)); };
            window.speechSynthesis.speak(utt);
          });
        } else {
          var res = await fetch('/api/tts/synthesize', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: testText, format: 'audio' })
          });
          if (!res.ok) { var err = await res.json().catch(function() { return {}; }); throw new Error(err.detail?.message || 'Synthesis failed'); }
          var blob = await res.blob();
          var url = URL.createObjectURL(blob);
          previewAudio = new Audio(url);
          previewBtn.textContent = 'Stop'; previewBtn.style.borderColor = 'var(--red, #e55)';
          await new Promise(function(resolve, reject) {
            previewAudio.onended = function() { URL.revokeObjectURL(url); previewAudio = null; resolve(); };
            previewAudio.onerror = function() { URL.revokeObjectURL(url); previewAudio = null; reject(new Error('Playback failed')); };
            previewAudio.play().catch(reject);
          });
        }
      } catch (e) {
        ttsMsg.textContent = 'Preview failed: ' + e.message; ttsMsg.style.color = 'var(--red, #e55)';
        setTimeout(function() { ttsMsg.textContent = ''; }, 3000);
      } finally {
        resetPreview();
      }
    });
  }
}

/* ── Speech to Text ── */
async function initSttSettings() {
  var provSel = el('set-sttProviderSelect');
  var modelSelect = el('set-sttModelSelect');
  var modelInput = el('set-sttModelInput');
  var modelRow = el('set-sttModelRow');
  var langRow = el('set-sttLangRow');
  var langInput = el('set-sttLangInput');
  var sttMsg = el('set-sttSettingsMsg');
  var sttEnabledToggle = el('set-sttEnabledToggle');
  var sttConfigWrap = el('set-sttConfigWrap');
  // STT was removed from AI Defaults — bail if the UI isn't present.
  if (!provSel) return;

  function isEndpoint() { return provSel.value.startsWith('endpoint:'); }
  function getModel() { return isEndpoint() ? modelInput.value : modelSelect.value; }

  function updateVisibility() {
    var prov = provSel.value;
    var showModel = prov === 'local' || prov.startsWith('endpoint:');
    var showLang = prov !== 'disabled';
    modelRow.style.display = showModel ? 'flex' : 'none';
    langRow.style.display = showLang ? 'flex' : 'none';
    if (isEndpoint()) {
      modelSelect.style.display = 'none'; modelInput.style.display = '';
    } else {
      modelSelect.style.display = ''; modelInput.style.display = 'none';
    }
  }

  function syncSttDisabled() {
    var off = sttEnabledToggle && !sttEnabledToggle.checked;
    var card = sttEnabledToggle ? sttEnabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (sttConfigWrap) sttConfigWrap.style.pointerEvents = off ? 'none' : '';
  }

  // Effective provider: if toggle is off, treat as disabled regardless of provider select
  function effectiveProvider() {
    if (sttEnabledToggle && !sttEnabledToggle.checked) return 'disabled';
    return provSel.value;
  }

  // Add API endpoints that might support STT
  try {
    var epRes = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
    var endpoints = await epRes.json();
    endpoints.forEach(function(ep) {
      if (!ep.is_enabled) return;
      var opt = document.createElement('option'); opt.value = 'endpoint:' + ep.id; opt.textContent = ep.name + ' (API)'; provSel.appendChild(opt);
    });
  } catch (e) { console.warn('Failed to load endpoints for STT', e); }

  // Load saved settings
  try {
    var settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await settingsRes.json();
    if (settings.stt_provider) provSel.value = settings.stt_provider;
    if (settings.stt_model) { modelSelect.value = settings.stt_model; modelInput.value = settings.stt_model; }
    if (settings.stt_language) langInput.value = settings.stt_language;
    if (sttEnabledToggle) sttEnabledToggle.checked = settings.stt_enabled !== false;
  } catch (e) { console.warn('Failed to load STT settings', e); }

  syncSttDisabled();
  updateVisibility();

  async function saveSTT() {
    try {
      var enabled = sttEnabledToggle ? sttEnabledToggle.checked : false;
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stt_enabled: enabled, stt_provider: provSel.value, stt_model: getModel() || 'base', stt_language: langInput.value.trim() }) });
      sttMsg.textContent = 'Saved'; sttMsg.style.color = 'var(--fg)'; setTimeout(() => { sttMsg.textContent = ''; }, 2000);
      // Notify voiceRecorder of effective provider and update send button icon
      if (window.voiceRecorderModule) window.voiceRecorderModule._sttProvider = effectiveProvider();
      if (window._updateSendBtnIcon) window._updateSendBtnIcon();
    } catch (e) { sttMsg.textContent = 'Failed to save'; sttMsg.style.color = 'var(--red)'; }
  }

  provSel.addEventListener('change', function() { updateVisibility(); saveSTT(); });
  modelSelect.addEventListener('change', saveSTT);
  modelInput.addEventListener('change', saveSTT);
  langInput.addEventListener('change', saveSTT);
  if (sttEnabledToggle) sttEnabledToggle.addEventListener('change', function() { syncSttDisabled(); saveSTT(); });
}

/* ═══════════════════════════════════════════
   SEARCH TAB
   ═══════════════════════════════════════════ */

var _LINK = function(href, text) {
  return '<a href="' + href + '" target="_blank" rel="noopener noreferrer" style="color:var(--accent, var(--red));text-decoration:underline;">' + text + '</a>';
};
var _searchProviderHints = {
  searxng: 'Private, self-hosted instance. Leave URL empty to use the SEARXNG_INSTANCE env var.',
  duckduckgo: 'No API key needed, but rate-limited — heavy use can return empty results. Configure a fallback below.',
  brave: 'Get your API key from ' + _LINK('https://brave.com/search/api/', 'brave.com/search/api'),
  google_pse: 'Requires a Google API key and a Programmable Search Engine ID (CX). Create one at ' + _LINK('https://programmablesearchengine.google.com/', 'programmablesearchengine.google.com'),
  tavily: 'AI-optimized search. 1,000 free credits/month at ' + _LINK('https://tavily.com/', 'tavily.com'),
  serper: 'Google results via API. 2,500 free queries at ' + _LINK('https://serper.dev/', 'serper.dev'),
  disabled: 'Web search and deep research tools will be unavailable.',
};
var _searchNeedsKey = { brave: 1, google_pse: 1, tavily: 1, serper: 1 };
var _searchLabels = {
  searxng: 'SearXNG', duckduckgo: 'DuckDuckGo', brave: 'Brave Search',
  google_pse: 'Google PSE', tavily: 'Tavily', serper: 'Serper', disabled: 'Disabled',
};
var _searchKeyFields = {
  brave: 'brave_api_key', google_pse: 'google_pse_key',
  tavily: 'tavily_api_key', serper: 'serper_api_key',
};

async function initSearchSettings() {
  var provSel = el('set-searchProvider');
  var countSel = el('set-searchResultCount');
  var countCustomInput = el('set-searchResultCountCustom');
  var urlInput = el('set-searchUrl');
  var urlRow = el('set-searchUrlRow');
  var keyInput = el('set-searchApiKey');
  var keyRow = el('set-searchKeyRow');
  var cxInput = el('set-searchCx');
  var cxRow = el('set-searchCxRow');
  var hint = el('set-searchHint');
  var msg = el('set-searchMsg');
  var _settings = {};

  function keyFieldFor(prov) { return _searchKeyFields[prov] || ''; }

  function loadKeyForProvider(prov) {
    var field = keyFieldFor(prov);
    keyInput.value = field ? (_settings[field] || _settings.search_api_key || '') : '';
  }

  function updateVisibility() {
    var prov = provSel.value;
    urlRow.style.display = prov === 'searxng' ? 'flex' : 'none';
    keyRow.style.display = _searchNeedsKey[prov] ? 'flex' : 'none';
    cxRow.style.display = prov === 'google_pse' ? 'flex' : 'none';
    hint.innerHTML = _searchProviderHints[prov] || '';
    if (prov === 'brave') keyInput.placeholder = 'Brave API key';
    else if (prov === 'google_pse') keyInput.placeholder = 'Google API key';
    else if (prov === 'tavily') keyInput.placeholder = 'Tavily API key';
    else if (prov === 'serper') keyInput.placeholder = 'Serper API key';
    else keyInput.placeholder = 'API key';
    loadKeyForProvider(prov);
  }

  function updateCountDisplay() {
    var val = _settings.search_result_count || 5;
    var presets = ['3', '5', '10', '20'];
    if (presets.includes(String(val))) {
      countSel.value = String(val);
      countCustomInput.style.display = 'none';
    } else {
      countSel.value = 'custom';
      countCustomInput.value = Math.max(1, Math.min(100, val));
      countCustomInput.style.display = 'block';
    }
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    _settings = await res.json();
    if (_settings.search_provider) provSel.value = _settings.search_provider;
    updateCountDisplay();
    if (_settings.search_url) urlInput.value = _settings.search_url;
    if (_settings.google_pse_cx) cxInput.value = _settings.google_pse_cx;
  } catch (e) { console.warn('Failed to load search settings', e); }

  countSel.addEventListener('change', function() {
    if (this.value === 'custom') {
      countCustomInput.style.display = 'block';
      countCustomInput.focus();
    } else {
      countCustomInput.style.display = 'none';
    }
  });

  updateVisibility();

  async function refreshStatus() {
    try {
      var sRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
      var s = await sRes.json();
      _settings = s;
      var active = s.search_provider || 'searxng';
      var label = _searchLabels[active] || active;
      var extra = '';
      var kf = keyFieldFor(active);
      var hasKey = kf ? ((s[kf] || '').trim() || (s.search_api_key || '').trim()) : false;
      if (_searchNeedsKey[active]) {
        extra = hasKey ? ' (key set)' : ' (no key)';
      } else if (active === 'searxng' && (s.search_url || '').trim()) {
        extra = ' (' + s.search_url + ')';
      }
      var count = s.search_result_count || 5;
      msg.textContent = 'Active: ' + label + extra + ' \u00b7 ' + count + ' results';
      msg.style.color = active === 'disabled' ? 'var(--red)' : (_searchNeedsKey[active] && !hasKey) ? 'var(--red)' : 'var(--fg)';
    } catch (e) { /* ignore */ }
  }
  refreshStatus();

  async function saveSearch() {
    try {
      var prov = provSel.value;
      var resultCount;
      if (countSel.value === 'custom') {
        var customVal = parseInt(countCustomInput.value, 10);
        if (isNaN(customVal) || customVal < 1 || customVal > 100) {
          resultCount = _settings.search_result_count || 5;
        } else {
          resultCount = customVal;
        }
      } else {
        resultCount = parseInt(countSel.value, 10);
      }
      var payload = {
        search_provider: prov,
        search_result_count: resultCount,
        search_url: urlInput.value.trim(),
        google_pse_cx: cxInput.value.trim(),
      };
      var kf = keyFieldFor(prov);
      if (kf) {
        payload[kf] = keyInput.value.trim();
        _settings[kf] = keyInput.value.trim();
      }
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(refreshStatus, 2000);
      if (searchModule && searchModule.refresh) searchModule.refresh();
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  provSel.addEventListener('change', function() { updateVisibility(); saveSearch(); _syncSearchPicker(); });
  countSel.addEventListener('change', saveSearch);
  urlInput.addEventListener('change', saveSearch);
  keyInput.addEventListener('change', saveSearch);
  cxInput.addEventListener('change', saveSearch);

  // ── Provider picker with logos (mirrors the hidden <select>) ──
  var picker = el('search-provider-picker');
  var pickerBtn = el('search-provider-btn');
  var pickerMenu = el('search-provider-menu');
  var pickerCurrent = picker ? picker.querySelector('.adm-provider-current') : null;
  function _searchProviderLogoSvg(key) {
    return _SEARCH_PROVIDER_LOGOS[key] || '';
  }
  function _renderSearchPickerMenu() {
    if (!pickerMenu) return;
    pickerMenu.innerHTML = Array.from(provSel.options).map(function(o) {
      var logo = _searchProviderLogoSvg(o.dataset.searchLogo);
      var active = o.value === provSel.value ? ' active' : '';
      return '<div class="adm-provider-item' + active + '" role="option" data-value="' + o.value.replace(/"/g, '&quot;') + '">' +
        '<span class="adm-provider-logo">' + logo + '</span>' +
        '<span>' + o.textContent + '</span>' +
      '</div>';
    }).join('');
  }
  function _syncSearchPicker() {
    if (!pickerCurrent) return;
    var opt = provSel.selectedOptions[0] || provSel.options[0];
    var logo = _searchProviderLogoSvg(opt.dataset.searchLogo);
    pickerCurrent.querySelector('.adm-provider-logo').innerHTML = logo;
    pickerCurrent.querySelector('.adm-provider-name').textContent = opt.textContent;
  }
  if (picker && pickerBtn && pickerMenu && pickerCurrent) {
    _renderSearchPickerMenu();
    _syncSearchPicker();
    pickerBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      pickerMenu.classList.toggle('hidden');
    });
    pickerMenu.addEventListener('click', function(e) {
      var item = e.target.closest('.adm-provider-item');
      if (!item) return;
      provSel.value = item.dataset.value;
      provSel.dispatchEvent(new Event('change', { bubbles: true }));
      pickerMenu.classList.add('hidden');
      _renderSearchPickerMenu();
    });
    document.addEventListener('click', function(e) {
      if (!picker.contains(e.target)) pickerMenu.classList.add('hidden');
    });
  }

  // ── Fallback chain ──
  // Stored as an ordered array of provider IDs (primary not included).
  // When the primary fails or hits rate-limit, the backend walks this
  // list in order trying each one.
  var fbWrap = el('set-searchFallbackChain');
  function _availableFallbackOptions() {
    var primary = provSel.value;
    var chain = _settings.search_fallback_chain || [];
    var inChain = new Set(chain.concat([primary, 'disabled']));
    return Array.from(provSel.options)
      .map(function(o) { return { value: o.value, label: o.textContent, logo: o.dataset.searchLogo }; })
      .filter(function(o) { return !inChain.has(o.value); });
  }
  var addBtn = el('set-searchAddFallback');
  var TRASH_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
  function _renderFallbackChain() {
    if (!fbWrap) return;
    var chain = (_settings.search_fallback_chain || []).slice();
    fbWrap.innerHTML = '';
    chain.forEach(function(p, idx) {
      var row = document.createElement('div');
      row.className = 'settings-fallback-row';

      var num = document.createElement('span');
      num.className = 'settings-fallback-num';
      num.textContent = (idx + 1) + '.';
      row.appendChild(num);

      // Inline logo so the row identifies its provider at a glance even
      // before opening the dropdown. The <select> below still drives
      // selection; we just mirror its value into the logo span.
      var logoWrap = document.createElement('span');
      logoWrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex-shrink:0;color:var(--fg);';
      var setLogo = function(val) {
        var srcOpt = Array.from(provSel.options).find(function(o) { return o.value === val; });
        logoWrap.innerHTML = srcOpt ? _searchProviderLogoSvg(srcOpt.dataset.searchLogo) : '';
      };
      setLogo(p);
      row.appendChild(logoWrap);

      var sel = document.createElement('select');
      sel.className = 'settings-select';
      // Options: this row's current value + every other provider not yet in the chain (and not the primary or 'disabled').
      var primary = provSel.value;
      var others = new Set(chain.filter(function(x) { return x !== p; }).concat([primary, 'disabled']));
      Array.from(provSel.options).forEach(function(o) {
        if (o.value !== p && others.has(o.value)) return;
        var opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.textContent;
        sel.appendChild(opt);
      });
      sel.value = p;
      sel.addEventListener('change', function() {
        setLogo(sel.value);
        var next = (_settings.search_fallback_chain || []).slice();
        next[idx] = sel.value;
        _saveFallbackChain(next);
      });
      row.appendChild(sel);

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'settings-fallback-remove';
      rm.title = 'Remove fallback';
      rm.innerHTML = TRASH_SVG;
      rm.addEventListener('click', function() {
        var next = (_settings.search_fallback_chain || []).filter(function(x, i) { return i !== idx; });
        _saveFallbackChain(next);
      });
      row.appendChild(rm);

      fbWrap.appendChild(row);
    });
    // Add-fallback button: disabled when there are no remaining providers to add.
    if (addBtn) {
      var hasMore = _availableFallbackOptions().length > 0;
      addBtn.style.display = hasMore ? '' : 'none';
    }
  }
  if (addBtn && !addBtn._wired) {
    addBtn._wired = true;
    addBtn.addEventListener('click', function() {
      var avail = _availableFallbackOptions();
      if (!avail.length) return;
      var next = (_settings.search_fallback_chain || []).slice();
      next.push(avail[0].value);
      _saveFallbackChain(next);
    });
  }
  async function _saveFallbackChain(chain) {
    _settings.search_fallback_chain = chain;
    try {
      await fetch('/api/auth/settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search_fallback_chain: chain }),
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(refreshStatus, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
    _renderFallbackChain();
  }
  _renderFallbackChain();
  // Re-render whenever the primary changes (it gets filtered out of "Add").
  provSel.addEventListener('change', _renderFallbackChain);

  // ── Test button ── runs a one-off query against the configured provider.
  var testBtn = el('set-searchTestBtn');
  if (testBtn) {
    testBtn.addEventListener('click', async function() {
      var prov = provSel.value;
      if (!prov || prov === 'disabled') {
        msg.textContent = 'Pick a provider first';
        msg.style.color = 'var(--red)';
        return;
      }
      // Persist current form values first so the test uses what's on screen.
      await saveSearch();
      testBtn.disabled = true;
      var origHtml = testBtn.innerHTML;
      var wp = null;
      try {
        var sp = window.spinnerModule || (await import('./spinner.js')).default;
        wp = sp.createWhirlpool(11);
        wp.element.style.cssText = 'display:inline-flex;width:11px;height:11px;margin:0 4px 0 0;';
        testBtn.innerHTML = '';
        testBtn.appendChild(wp.element);
        testBtn.appendChild(document.createTextNode('Testing'));
      } catch (_) {
        testBtn.innerHTML = origHtml.replace(/>Test\s*$/, '>Testing...');
      }
      msg.textContent = '';
      var t0 = performance.now();
      try {
        var fd = new FormData();
        fd.append('query', 'hello world');
        fd.append('provider', prov);
        fd.append('count', '3');
        var r = await fetch('/api/search/query', { method: 'POST', body: fd, credentials: 'same-origin' });
        var d = await r.json();
        var ms = Math.round(performance.now() - t0);
        if (d.error) {
          msg.textContent = '✗ ' + d.error + ' (' + ms + 'ms)';
          msg.style.color = 'var(--red)';
        } else if (!d.results || !d.results.length) {
          msg.textContent = '⚠ No results returned (' + ms + 'ms)';
          msg.style.color = 'var(--red)';
        } else {
          var topTitle = (d.results[0].title || d.results[0].url || '').slice(0, 60);
          msg.textContent = '✓ ' + d.results.length + ' result' + (d.results.length === 1 ? '' : 's') + ' · ' + ms + 'ms · top: ' + topTitle;
          msg.style.color = 'var(--fg)';
        }
      } catch (e) {
        msg.textContent = '✗ Test failed: ' + (e && e.message ? e.message : e);
        msg.style.color = 'var(--red)';
      } finally {
        if (wp) { try { wp.destroy(); } catch (_) {} }
        testBtn.disabled = false; testBtn.innerHTML = origHtml;
      }
    });
  }
}

// SVG logos for each search provider (16×16 viewBox normalised to 24×24).
var _SEARCH_PROVIDER_LOGOS = {
  searxng:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0-2a8 8 0 1 1-4.93 14.32l-3.4 3.4a1 1 0 1 1-1.4-1.4l3.4-3.4A8 8 0 0 1 10 2zM13 8.5L11.5 10 13 11.5l-1 1L10.5 11 9 12.5l-1-1L9.5 10 8 8.5l1-1L10.5 9 12 7.5z"/></svg>',
  duckduckgo:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.5 5.5a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zm5 0a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zM12 13c-1.5 0-3.6.8-3.6 2.5C8.4 17.2 10.4 18 12 18s3.6-.8 3.6-2.5C15.6 13.8 13.5 13 12 13z"/></svg>',
  brave:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 4l-1.5 1L15 3l-3 .5L9 3 6.5 5 5 4 3 7l1.5 2L4 12l3 5 4 3 1 1 1-1 4-3 3-5-.5-3L21 7l-2-3zM12 17l-2.5-2 .5-3-2-1.5 2-1.5L11 7l3-1 3 1-.5 2 2 1.5-2 1.5.5 3L14.5 17 12 17z"/></svg>',
  google_pse:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.35 11.1H12v3.2h5.35c-.5 2.4-2.55 4-5.35 4-3.25 0-5.9-2.65-5.9-5.9s2.65-5.9 5.9-5.9c1.55 0 2.95.55 4.05 1.55l2.4-2.4C16.85 4.05 14.55 3 12 3 7 3 3 7 3 12s4 9 9 9c5.2 0 8.65-3.65 8.65-8.8 0-.4-.05-.7-.3-1.1z"/></svg>',
  tavily:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 8.5l4 2.5v6l6 3.5 6-3.5v-6l4-2.5L12 2zm-4 9.5L12 14l4-2.5V16l-4 2.5L8 16v-4.5z"/></svg>',
  serper:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 4a7 7 0 1 0 4.2 12.6l4.5 4.5 1.4-1.4-4.5-4.5A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm-1 2v2H8v2h2v2h2v-2h2V10h-2V8h-2z"/></svg>',
  disabled:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

/* ── Deep Research Model (AI tab) ── */
async function initResearchSettings() {
  var epSel = el('set-researchEndpoint');
  var modelSel = el('set-researchModel');
  var tokensInput = el('set-researchMaxTokens');
  var extractTimeoutInput = el('set-researchExtractTimeout');
  var extractConcurrencyInput = el('set-researchExtractConcurrency');
  var runTimeoutInput = el('set-researchRunTimeout');
  var msg = el('set-researchMsg');
  var endpoints = [];

  try {
    endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, endpoints, epSel.value, true);
  } catch (e) { console.warn('Failed to load endpoints for research', e); }

  function refreshModels(selectedModel) {
    var epId = epSel.value;
    var ep = endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true);
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.research_endpoint_id) epSel.value = settings.research_endpoint_id;
    refreshModels(settings.research_model || '');
    if (settings.research_max_tokens) tokensInput.value = settings.research_max_tokens;
    if (settings.research_extraction_timeout_seconds) extractTimeoutInput.value = settings.research_extraction_timeout_seconds;
    if (settings.research_extraction_concurrency) extractConcurrencyInput.value = settings.research_extraction_concurrency;
    if (settings.research_run_timeout_seconds !== undefined && settings.research_run_timeout_seconds !== null) {
      runTimeoutInput.value = settings.research_run_timeout_seconds;
    }
  } catch (e) { console.warn('Failed to load research settings', e); }

  function showStatus() {
    var parts = [];
    if (epSel.value) {
      var epName = epSel.options[epSel.selectedIndex].textContent;
      var mName = modelSel.value ? modelSel.value.split('/').pop() : 'auto';
      parts.push(epName + ' / ' + mName);
    }
    if (tokensInput.value) {
      parts.push('Max tokens: ' + tokensInput.value);
    }
    if (extractTimeoutInput.value) {
      parts.push('Extract: ' + extractTimeoutInput.value + 's');
    }
    if (extractConcurrencyInput.value) {
      parts.push('Parallel: ' + extractConcurrencyInput.value);
    }
    if (runTimeoutInput.value !== '') {
      var rtv = parseInt(runTimeoutInput.value, 10);
      if (!isNaN(rtv)) {
        parts.push(rtv === 0 ? 'Max time: no limit' : 'Max time: ' + rtv + 's');
      }
    }
    if (parts.length) {
      msg.textContent = parts.join(' · ');
      msg.style.color = 'var(--fg)';
    } else {
      msg.textContent = 'Using chat defaults';
      msg.style.color = 'var(--fg)';
    }
  }
  showStatus();

  async function saveResearch() {
    var payload = {
      research_endpoint_id: epSel.value,
      research_model: modelSel.value,
    };
    var tv = parseInt(tokensInput.value, 10);
    if (tv && tv >= 1024) payload.research_max_tokens = tv;
    var et = parseInt(extractTimeoutInput.value, 10);
    if (et && et >= 15 && et <= 3600) payload.research_extraction_timeout_seconds = et;
    var ec = parseInt(extractConcurrencyInput.value, 10);
    if (ec && ec >= 1 && ec <= 12) payload.research_extraction_concurrency = ec;
    if (runTimeoutInput.value !== '') {
      var rt = parseInt(runTimeoutInput.value, 10);
      // 0 = no limit (disables the hard timeout); otherwise 60s..86400s (24h)
      if (!isNaN(rt) && (rt === 0 || (rt >= 60 && rt <= 86400))) {
        payload.research_run_timeout_seconds = rt;
      }
    }
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(showStatus, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  epSel.addEventListener('change', async function() {
    refreshModels('');
    saveResearch();
  });
  modelSel.addEventListener('change', saveResearch);
  tokensInput.addEventListener('change', saveResearch);
  extractTimeoutInput.addEventListener('change', saveResearch);
  extractConcurrencyInput.addEventListener('change', saveResearch);
  runTimeoutInput.addEventListener('change', saveResearch);

  _registerAiEndpointRefresh(function(nextEndpoints) {
    endpoints = nextEndpoints;
    _fillEndpointSelect(epSel, endpoints, epSel.value, true);
    refreshModels(modelSel.value);
  });
}

/* ── Deep Research Search (Search tab) ── */
async function initResearchSearchSettings() {
  var searchSel = el('set-researchSearch');
  var msg = el('set-researchSearchMsg');
  var logoEl = el('set-researchSearch-logo');

  function updateSearchLogo() {
    if (!logoEl) return;
    var opt = searchSel.selectedOptions[0];
    var key = opt && opt.dataset ? opt.dataset.searchLogo : '';
    logoEl.innerHTML = key ? (_SEARCH_PROVIDER_LOGOS[key] || '') : '';
  }

  function updateSearchOptions(settings) {
    var options = searchSel.querySelectorAll('option');
    options.forEach(function(opt) {
      var prov = opt.value;
      if (!prov) return;
      var kf = _searchKeyFields[prov];
      if (!kf) return;
      var hasKey = ((settings[kf] || '').trim() || (settings.search_api_key || '').trim());
      if (!hasKey) {
        opt.textContent = (_searchLabels[prov] || prov) + ' (no key)';
        opt.style.color = 'var(--red)';
      } else {
        opt.textContent = _searchLabels[prov] || prov;
        opt.style.color = '';
      }
    });
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.research_search_provider) searchSel.value = settings.research_search_provider;
    updateSearchOptions(settings);
    updateSearchLogo();
  } catch (e) { console.warn('Failed to load research search settings', e); }

  async function saveResearchSearch() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ research_search_provider: searchSel.value })
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  searchSel.addEventListener('change', function() { updateSearchLogo(); saveResearchSearch(); });
}

/* ── Agent Settings (AI tab) ── */
async function initAgentSettings() {
  var toolsInput = el('set-agentMaxTools');
  var roundsInput = el('set-agentMaxRounds');
  var supInput = el('set-agentSupervisorLadder');
  var msg = el('set-agentMsg');
  if (!toolsInput) return;

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.agent_max_tool_calls) toolsInput.value = settings.agent_max_tool_calls;
    if (roundsInput && settings.agent_max_rounds) roundsInput.value = settings.agent_max_rounds;
    if (supInput) supInput.checked = !!settings.agent_supervisor_ladder;
  } catch (e) {}

  // Clamp + coerce a raw input to an int in [lo, hi]; falls back to `dflt`
  // when blank/non-numeric. Mirrors the server-side validation.
  function clampInt(raw, lo, hi, dflt) {
    var n = parseInt(raw, 10);
    if (isNaN(n)) return dflt;
    return Math.max(lo, Math.min(n, hi));
  }

  async function save() {
    var tools = clampInt(toolsInput.value, 0, 1000, 0);
    var rounds = roundsInput ? clampInt(roundsInput.value, 1, 200, 20) : null;
    toolsInput.value = tools;                       // reflect the clamped value
    if (roundsInput) roundsInput.value = rounds;
    var payload = { agent_max_tool_calls: tools };
    if (rounds != null) payload.agent_max_rounds = rounds;
    if (supInput) payload.agent_supervisor_ladder = !!supInput.checked;
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      msg.textContent = (tools > 0 ? 'Limit: ' + tools + ' tool calls' : 'Unlimited tool calls') +
        (rounds != null ? ' · ' + rounds + ' steps/message' : '') +
        (supInput && supInput.checked ? ' · supervisor on' : '');
      msg.style.color = 'var(--fg)';
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  toolsInput.addEventListener('change', save);
  if (roundsInput) roundsInput.addEventListener('change', save);
  if (supInput) supInput.addEventListener('change', save);
  var cur = parseInt(toolsInput.value, 10) || 0;
  var curR = roundsInput ? (parseInt(roundsInput.value, 10) || 20) : null;
  msg.textContent = (cur > 0 ? 'Limit: ' + cur + ' tool calls' : 'Unlimited tool calls') +
    (curR != null ? ' · ' + curR + ' steps/message' : '') +
    (supInput && supInput.checked ? ' · supervisor on' : '');

}

/* ═══════════════════════════════════════════
   APPEARANCE TAB
   ═══════════════════════════════════════════ */
function initAppearance() {
  syncAppearanceCheckboxes();
  syncPrivacyCheckboxes();

  modalEl.querySelectorAll('[data-ui-key]').forEach(function(chk) {
    chk.addEventListener('change', async function() {
      var key = chk.dataset.uiKey;

      if (window.UI_VIS_ADMIN_ONLY && window.UI_VIS_ADMIN_ONLY.has(key) && !chk.checked && !window._isAdmin) {
        chk.checked = true;
        if (uiModule && uiModule.showToast) {
          uiModule.showToast('Only admins can hide Settings.');
        }
        return;
      }

      // Hiding the Settings cog removes the only visible way to re-open this
      // panel. Warn the user and remind them about the `/settings` slash
      // command so they don't lock themselves out.
      if (key === 'sidebar-settings-btn' && !chk.checked) {
        var ok = true;
        try {
          ok = await (uiModule && uiModule.styledConfirm
            ? uiModule.styledConfirm(
                'Hide the Settings cog?\n\nYou can re-open this panel any time by typing /settings in the chat input.',
                { confirmText: 'Hide', cancelText: 'Cancel' }
              )
            : Promise.resolve(window.confirm('Hide the Settings cog?\n\nYou can re-open this panel any time by typing /settings in the chat input.')));
        } catch (_) { ok = false; }
        if (!ok) {
          chk.checked = true;
          return;
        }
        if (uiModule && uiModule.showToast) {
          uiModule.showToast('Settings cog hidden — type /settings to bring it back.', 5000);
        }
      }

      var s = window.loadUIVis();
      s[key] = chk.checked;
      window.saveUIVis(s);
      window.applyUIVis(s);
    });
  });

  modalEl.querySelectorAll('[data-privacy-key]').forEach(function(chk) {
    chk.addEventListener('change', function() {
      if (chk.dataset.privacyKey !== 'sensitive-blur') return;
      localStorage.setItem('odysseus-sensitive-blur', chk.checked ? 'on' : 'off');
      window.dispatchEvent(new CustomEvent('odysseus-sensitive-blur-change', {
        detail: { enabled: chk.checked }
      }));
    });
  });

  // Per-section reset buttons (arrow-circle-back icon in each card's h2).
  // Removes only the keys belonging to this section from the persisted
  // visibility map so other sections keep their user settings.
  modalEl.querySelectorAll('[data-vis-reset]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var card = btn.closest('.admin-card');
      if (!card) return;
      var keys = Array.from(card.querySelectorAll('[data-ui-key]'))
        .map(function(c) { return c.dataset.uiKey; })
        .filter(Boolean);
      if (!keys.length) return;
      var s = window.loadUIVis ? window.loadUIVis() : {};
      keys.forEach(function(k) { delete s[k]; });
      if (window.saveUIVis) window.saveUIVis(s);
      syncAppearanceCheckboxes();
      syncPrivacyCheckboxes();
      if (window.applyUIVis) window.applyUIVis(s);
    });
  });
}

function syncAppearanceCheckboxes() {
  var s = window.loadUIVis ? window.loadUIVis() : {};
  var defaultOff = window.UI_VIS_DEFAULT_OFF || new Set();
  modalEl.querySelectorAll('[data-ui-key]').forEach(function(chk) {
    var key = chk.dataset.uiKey;
    chk.checked = key in s ? s[key] !== false : !defaultOff.has(key);
  });
}

function syncPrivacyCheckboxes() {
  modalEl.querySelectorAll('[data-privacy-key="sensitive-blur"]').forEach(function(chk) {
    chk.checked = localStorage.getItem('odysseus-sensitive-blur') === 'on';
  });
}

/* ═══════════════════════════════════════════
   SHORTCUTS TAB
   ═══════════════════════════════════════════ */

const SHORTCUT_DEFAULTS = {
  toggle_sidebar: 'ctrl+b',
  new_session:    'ctrl+alt+n',
  fav_session:    'ctrl+alt+f',
  delete_session: 'ctrl+alt+d',
  cancel:         'escape',
  tts:            'alt+shift+t',
  incognito:      'ctrl+alt+i',
  settings:       'ctrl+,',
  focus_input:    'ctrl+/',
  // Open-tool shortcuts (all unbound by default).
  // unbound (empty) so the user can assign their own in the panel.
  open_research:  '',
  open_gallery:   '',
  open_library:   '',
  open_memory:    '',
  open_theme:     '',
};

const SHORTCUT_ICONS = {
  toggle_sidebar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  new_session:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  fav_session:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  delete_session: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  cancel:         '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  tts:            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
  incognito:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>',
  settings:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  focus_input:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  open_research:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
  open_gallery:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  open_library:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  open_memory:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.3C6.2 13.5 5 11.4 5 9a7 7 0 0 1 7-7z"/><line x1="10" y1="22" x2="14" y2="22"/></svg>',
  open_theme:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20 5 5 0 0 0 5-5 3 3 0 0 0-3-3h-2a3 3 0 0 1-3-3 5 5 0 0 1 5-5"/></svg>',
};

const SHORTCUT_LABELS = {
  toggle_sidebar: 'Toggle sidebar',
  new_session:    'New session',
  fav_session:    'Favorite session',
  delete_session: 'Delete session',
  cancel:         'Cancel / close',
  tts:            'Play/stop TTS',
  incognito:      'Toggle incognito',
  settings:       'Toggle Window',
  focus_input:    'Focus chat input',
  open_research:  'Open Deep Research',
  open_gallery:   'Open Gallery',
  open_library:   'Open RAG',
  open_memory:    'Open Skills',
  open_theme:     'Open Theme',
};

const SHORTCUT_CATEGORIES = [
  { name: 'Navigation', keys: ['search', 'toggle_sidebar', 'focus_input', 'settings'] },
  { name: 'Sessions', keys: ['new_session', 'fav_session', 'delete_session'] },
  { name: 'Tools', keys: ['incognito', 'tts', 'cancel'] },
  { name: 'Open Tools', keys: ['open_research', 'open_gallery', 'open_library', 'open_memory', 'open_theme'] },
];

function _formatKeyCaps(combo) {
  return combo.split('+').map(p => {
    let label;
    if (p === 'ctrl') label = 'Ctrl';
    else if (p === 'alt') label = 'Alt';
    else if (p === 'shift') label = 'Shift';
    else if (p === 'meta') label = 'Cmd';
    else if (p === 'escape') label = 'Esc';
    else if (p === ',') label = ',';
    else if (p === '/') label = '/';
    else if (p === 'space') label = 'Space';
    else label = p.charAt(0).toUpperCase() + p.slice(1);
    return `<kbd>${label}</kbd>`;
  }).join('');
}

function _comboFromEvent(e) {
  // Drop a stray AltGr keystroke (e.g. AltGr+E to type €) so it isn't recorded
  // as a bogus ctrl+alt+<char> binding — onKey ignores empty combos. See
  // platform.js for the macOS carve-out and Windows trade-off.
  if (isAltGrEvent(e)) return '';
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const key = e.key.toLowerCase();
  if (!['control', 'alt', 'shift', 'meta'].includes(key)) {
    parts.push(key === ' ' ? 'space' : key);
  }
  return parts.join('+');
}

async function initShortcuts() {
  const listEl = el('shortcuts-list');
  const resetBtn = el('shortcuts-reset-btn');
  if (!listEl) return;

  // Load saved keybinds
  let keybinds = { ...SHORTCUT_DEFAULTS };
  try {
    const res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const settings = await res.json();
    if (settings.keybinds) keybinds = { ...keybinds, ...settings.keybinds };
  } catch (e) {}

  function _findConflicts() {
    const comboMap = {};
    for (const [action, combo] of Object.entries(keybinds)) {
      if (!comboMap[combo]) comboMap[combo] = [];
      comboMap[combo].push(action);
    }
    const conflicts = new Set();
    for (const actions of Object.values(comboMap)) {
      if (actions.length > 1) actions.forEach(a => conflicts.add(a));
    }
    return conflicts;
  }

  function render() {
    listEl.innerHTML = '';
    const conflicts = _findConflicts();

    for (const cat of SHORTCUT_CATEGORIES) {
      const catHeader = document.createElement('div');
      catHeader.className = 'shortcut-category';
      catHeader.textContent = cat.name;
      listEl.appendChild(catHeader);

      for (const action of cat.keys) {
        if (!(action in keybinds)) continue;
        const combo = keybinds[action];
        // Unbound shortcuts (empty combo) still render so the user can
        // assign one \u2014 they show a "Set" affordance instead of keycaps.
        const label = SHORTCUT_LABELS[action] || action;
        const icon = SHORTCUT_ICONS[action] || '';
        const isCustom = combo !== (SHORTCUT_DEFAULTS[action] || '');
        const hasConflict = combo && conflicts.has(action);
        const row = document.createElement('div');
        row.className = 'shortcut-row' + (hasConflict ? ' shortcut-conflict' : '');
        row.dataset.action = action;
        const keyContent = combo ? _formatKeyCaps(combo) : '<span class="shortcut-unset">Set</span>';
        row.innerHTML = `
          <span class="shortcut-label"><span class="shortcut-icon">${icon}</span>${esc(label)}${hasConflict ? '<span class="shortcut-warn" title="Duplicate shortcut">!</span>' : ''}</span>
          <div class="shortcut-controls">
            <span class="shortcut-hint" hidden></span>
            <button class="shortcut-key${combo ? '' : ' shortcut-key-unset'}" data-action="${action}" title="Click to rebind">${keyContent}</button>
            <button class="shortcut-action-btn ${isCustom ? 'is-reset' : ''}" data-action="${action}" title="${isCustom ? 'Reset to default' : 'Confirm'}" style="${isCustom ? '' : 'visibility:hidden'}">
              ${isCustom
                ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>'
                : '\u2713'}
            </button>
          </div>
        `;
        listEl.appendChild(row);
      }
    }

    listEl.querySelectorAll('.shortcut-key').forEach(btn => {
      btn.addEventListener('click', () => startRebind(btn));
    });

    listEl.querySelectorAll('.shortcut-action-btn.is-reset').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        keybinds[action] = SHORTCUT_DEFAULTS[action];
        saveKeybinds();
        render();
      });
    });
  }

  function startRebind(btn) {
    const action = btn.dataset.action;
    const row = btn.closest('.shortcut-row');
    const actionBtn = row.querySelector('.shortcut-action-btn');
    const hintEl = row.querySelector('.shortcut-hint');

    // Remove any other active rebind
    listEl.querySelectorAll('.shortcut-key.listening').forEach(b => {
      b.classList.remove('listening');
      b.innerHTML = _formatKeyCaps(keybinds[b.dataset.action]);
      const otherRow = b.closest('.shortcut-row');
      const otherAction = otherRow.querySelector('.shortcut-action-btn');
      if (otherAction && !otherAction.classList.contains('is-reset')) otherAction.style.visibility = 'hidden';
    });

    btn.classList.add('listening');
    btn.textContent = 'Press keys...';
    // Show confirm button
    actionBtn.textContent = '\u2713';
    actionBtn.classList.remove('is-reset');
    actionBtn.style.visibility = 'visible';
    actionBtn.title = 'Confirm';
    // Hint: tell the user how to commit / cancel the rebind.
    if (hintEl) {
      hintEl.hidden = false;
      hintEl.textContent = 'press a key';
    }

    let pendingCombo = null;

    // Wire confirm button
    const confirmHandler = () => {
      if (pendingCombo) {
        keybinds[action] = pendingCombo;
        saveKeybinds();
      }
      cleanup();
      render();
    };
    actionBtn.addEventListener('click', confirmHandler, { once: true });

    function onKey(e) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        cleanup();
        btn.innerHTML = _formatKeyCaps(keybinds[action]);
        const isCustom = keybinds[action] !== SHORTCUT_DEFAULTS[action];
        if (isCustom) {
          actionBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
          actionBtn.classList.add('is-reset');
          actionBtn.title = 'Reset to default';
        } else {
          actionBtn.style.visibility = 'hidden';
        }
        return;
      }

      // Enter commits the previewed combo (same as clicking \u2713). Only acts
      // as commit once a combo has been captured \u2014 otherwise it would just
      // try to bind Enter itself.
      if (e.key === 'Enter' && pendingCombo) {
        confirmHandler();
        return;
      }

      const combo = _comboFromEvent(e);
      if (!combo || combo === 'ctrl' || combo === 'alt' || combo === 'shift' || combo === 'ctrl+alt' || combo === 'ctrl+shift' || combo === 'alt+shift' || combo === 'ctrl+alt+shift') return;

      // Preview the combo, wait for confirm
      pendingCombo = combo;
      btn.innerHTML = _formatKeyCaps(combo);
      // Now that a combo is captured, prompt to commit with Enter.
      if (hintEl) hintEl.textContent = '\u21B5 Enter to save';
    }

    function cleanup() {
      btn.classList.remove('listening');
      if (hintEl) { hintEl.hidden = true; hintEl.textContent = ''; }
      document.removeEventListener('keydown', onKey, true);
      actionBtn.removeEventListener('click', confirmHandler);
    }

    document.addEventListener('keydown', onKey, true);
  }

  async function saveKeybinds() {
    try {
      await fetch('/api/auth/settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keybinds }),
      });
      // Update global keybinds so they take effect immediately
      window._odysseusKeybinds = keybinds;
      if (uiModule && uiModule.showToast) uiModule.showToast('Shortcut saved');
    } catch (e) {
      console.error('Failed to save keybinds:', e);
    }
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      keybinds = { ...SHORTCUT_DEFAULTS };
      render();
      await saveKeybinds();
      if (uiModule && uiModule.showToast) uiModule.showToast('Shortcuts reset to defaults');
    });
  }

  render();
}

/* ═══════════════════════════════════════════
   INIT & REFRESH
   ═══════════════════════════════════════════ */
function initAll() {
  modalEl = el('settings-modal');
  initTabs();
  initDrag();
  initClose();
  initOpenPromptModalLink();
  initOpacityToggle();
  initialized = true;
  initDefaultChat();
  initTeacherModel();
  initUtilityModel();
  initImageSettings();
  initVisionSettings();
  initTtsSettings();
  initSttSettings();
  initSearchSettings();
  initResearchSettings();
  initResearchSearchSettings();
  initAgentSettings();
  initAppearance();
  initShortcuts();
  initIntegrations();
  initUnifiedIntegrations();
}

function notifyIntegrationsChanged() {
  try {
    window.dispatchEvent(new CustomEvent('odysseus-integrations-changed'));
  } catch (_) {}
}

async function initIntegrations() {
  const listEl = el('integrations-list');
  const formCard = el('integration-form-card');
  const addBtn = el('intg-add-btn');
  if (!listEl || !formCard) return;

  const presetSel = el('intg-preset');
  const nameIn = el('intg-name');
  const urlIn = el('intg-url');
  const authTypeSel = el('intg-auth-type');
  const authHeaderRow = el('intg-auth-header-row');
  const authHeaderIn = el('intg-auth-header');
  const keyIn = el('intg-key');
  const descIn = el('intg-description');
  const saveBtn = el('intg-save-btn');
  const cancelBtn = el('intg-cancel-btn');
  const testBtn = el('intg-test-btn');
  const statusEl = el('intg-status');
  const formTitle = el('integration-form-title');

  let editingId = null;
  let presets = {};

  // Presets where the secret is embedded in the URL — no separate key or
  // auth header is used, so hiding those fields avoids confusion.
  const URL_AUTH_PRESETS = ['discord_webhook'];

  // Toggle auth header + key row visibility based on auth type and preset.
  function syncAuthRow() {
    const v = authTypeSel.value;
    authHeaderRow.style.display = (v === 'header' || v === 'query') ? 'flex' : 'none';
    if (v === 'query') authHeaderIn.placeholder = 'api_key';
    else authHeaderIn.placeholder = 'X-Auth-Token';
    const keyRow = keyIn?.closest('.settings-row');
    if (keyRow) keyRow.style.display = URL_AUTH_PRESETS.includes(presetSel?.value) ? 'none' : '';
  }
  authTypeSel.addEventListener('change', syncAuthRow);

  // Load presets
  try {
    const res = await fetch('/api/auth/integrations/presets', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      presets = data.presets || {};
      for (const [key, preset] of Object.entries(presets)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = preset.name || key;
        presetSel.appendChild(opt);
      }
    }
  } catch (e) {}

  // Preset auto-fill
  presetSel.addEventListener('change', () => {
    const p = presets[presetSel.value];
    if (!p) return;
    nameIn.value = p.name || '';
    authTypeSel.value = p.auth_type || 'none';
    authHeaderIn.value = p.auth_header || '';
    descIn.value = p.description || '';
    syncAuthRow();
  });

  // Render list
  async function renderList() {
    try {
      const res = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
      if (!res.ok) { listEl.innerHTML = '<div style="padding:12px;opacity:0.5;font-size:14px;">Admin access required</div>'; return; }
      const data = await res.json();
      const items = data.integrations || [];
      if (!items.length) {
        listEl.innerHTML = '<div style="padding:12px;opacity:0.5;font-size:14px;text-align:center;">No integrations configured</div>';
        return;
      }
      listEl.innerHTML = items.map(i => `
        <div class="admin-card" style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:600;">${_esc(i.name || i.id)}</div>
            <div style="font-size:14px;opacity:0.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(i.base_url || '')}</div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="admin-btn-sm intg-edit-btn" data-id="${i.id}" style="font-size:14px;">Edit</button>
            <button class="admin-btn-sm intg-del-btn" data-id="${i.id}" style="font-size:14px;opacity:0.6;">Del</button>
          </div>
        </div>
      `).join('');
      listEl.querySelectorAll('.intg-edit-btn').forEach(b => b.addEventListener('click', () => startEdit(b.dataset.id)));
      listEl.querySelectorAll('.intg-del-btn').forEach(b => b.addEventListener('click', () => doDelete(b.dataset.id)));
    } catch (e) { listEl.innerHTML = '<div style="padding:12px;color:var(--red);font-size:14px;">Failed to load</div>'; }
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // Start editing
  async function startEdit(id) {
    editingId = id;
    formTitle.textContent = 'Edit Integration';
    // Fetch full data (with unmasked key from a dedicated edit fetch — we'll just load what we have)
    try {
      const res = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
      const data = await res.json();
      const item = (data.integrations || []).find(i => i.id === id);
      if (!item) return;
      presetSel.value = item.preset || '';
      nameIn.value = item.name || '';
      urlIn.value = item.base_url || '';
      authTypeSel.value = item.auth_type || 'none';
      authHeaderIn.value = item.auth_header || '';
      keyIn.value = ''; // masked — user re-enters if changing
      keyIn.placeholder = item.api_key ? 'Leave blank to keep current' : 'API key or token';
      descIn.value = item.description || '';
      syncAuthRow();
      formCard.style.display = '';
    } catch (e) {}
  }

  // Show add form
  addBtn.addEventListener('click', () => {
    editingId = null;
    formTitle.textContent = 'Add Integration';
    presetSel.value = '';
    nameIn.value = '';
    urlIn.value = '';
    authTypeSel.value = 'header';
    authHeaderIn.value = '';
    keyIn.value = '';
    keyIn.placeholder = 'API key or token';
    descIn.value = '';
    statusEl.textContent = '';
    syncAuthRow();
    formCard.style.display = '';
  });

  cancelBtn.addEventListener('click', () => {
    formCard.style.display = 'none';
    statusEl.textContent = '';
  });

  // Save
  saveBtn.addEventListener('click', async () => {
    const payload = {
      name: nameIn.value.trim(),
      base_url: urlIn.value.trim().replace(/\/+$/, ''),
      auth_type: authTypeSel.value,
      auth_header: authHeaderIn.value.trim(),
      description: descIn.value.trim(),
    };
    if (presetSel.value) payload.preset = presetSel.value;
    if (keyIn.value.trim()) payload.api_key = keyIn.value.trim();
    if (!payload.name) { statusEl.textContent = 'Name required'; statusEl.style.color = 'var(--red)'; return; }
    if (!payload.base_url) { statusEl.textContent = 'URL required'; statusEl.style.color = 'var(--red)'; return; }

    try {
      const url = editingId ? `/api/auth/integrations/${editingId}` : '/api/auth/integrations';
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin' });
      if (res.ok) {
        statusEl.textContent = 'Saved';
        statusEl.style.color = 'var(--green, #98c379)';
        formCard.style.display = 'none';
        await renderList();
        notifyIntegrationsChanged();
      } else {
        const err = await res.json().catch(() => ({}));
        statusEl.textContent = err.detail || 'Save failed';
        statusEl.style.color = 'var(--red)';
      }
    } catch (e) {
      statusEl.textContent = 'Error saving';
      statusEl.style.color = 'var(--red)';
    }
  });

  // Test
  testBtn.addEventListener('click', async () => {
    if (!editingId) { statusEl.textContent = 'Save first, then test'; statusEl.style.color = 'var(--fg)'; return; }
    statusEl.textContent = 'Testing...';
    statusEl.style.color = 'var(--fg)';
    try {
      const res = await fetch(`/api/auth/integrations/${editingId}/test`, { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      statusEl.textContent = data.message || (data.ok ? 'OK' : 'Failed');
      statusEl.style.color = data.ok ? 'var(--green, #98c379)' : 'var(--red)';
    } catch (e) {
      statusEl.textContent = 'Connection failed';
      statusEl.style.color = 'var(--red)';
    }
  });

  // Delete
  async function doDelete(id) {
    if (!await window.styledConfirm('Delete this integration?', { confirmText: 'Delete', danger: true })) return;
    try {
      await fetch(`/api/auth/integrations/${id}`, { method: 'DELETE', credentials: 'same-origin' });
      if (editingId === id) { formCard.style.display = 'none'; editingId = null; }
      await renderList();
      notifyIntegrationsChanged();
    } catch (e) {}
  }

  syncAuthRow();
  renderList();
}

/* ══ Unified Integrations ══ */

const INTG_TYPES = {
  api:     { label: 'API',     icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' },
  contacts: { label: 'Contacts', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
  carddav: { label: 'CardDAV', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
  mcp:     { label: 'MCP',     icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' },
  codex:   { label: 'Codex',   icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 10.696.453a6.023 6.023 0 0 0-5.75 4.172 6.061 6.061 0 0 0-3.946 2.945 6.024 6.024 0 0 0 .742 7.099 5.98 5.98 0 0 0 .516 4.911 6.046 6.046 0 0 0 6.51 2.9A5.996 5.996 0 0 0 13.26 23.547a6.023 6.023 0 0 0 5.75-4.172 6.061 6.061 0 0 0 3.946-2.945 6.024 6.024 0 0 0-.674-6.609zM13.26 21.047a4.508 4.508 0 0 1-2.886-1.041l.143-.082 4.793-2.769a.777.777 0 0 0 .391-.676V10.34l2.026 1.17a.072.072 0 0 1 .039.061v5.596a4.532 4.532 0 0 1-4.506 4.48zM3.968 17.64a4.473 4.473 0 0 1-.537-3.018l.143.086 4.793 2.769a.79.79 0 0 0 .782 0l5.852-3.379v2.34a.072.072 0 0 1-.029.062l-4.845 2.796a4.532 4.532 0 0 1-6.159-1.656zM2.804 7.922a4.49 4.49 0 0 1 2.348-1.973V11.6a.778.778 0 0 0 .391.676l5.852 3.378-2.026 1.17a.072.072 0 0 1-.068 0L4.456 14.03a4.532 4.532 0 0 1-1.652-6.108zm16.423 3.823L13.375 8.367l2.026-1.17a.072.072 0 0 1 .068 0l4.845 2.796a4.525 4.525 0 0 1-.7 8.08V12.42a.778.778 0 0 0-.387-.676zm2.015-3.025l-.143-.086-4.793-2.769a.79.79 0 0 0-.782 0L9.672 9.243V6.903a.072.072 0 0 1 .029-.062l4.845-2.796a4.525 4.525 0 0 1 6.696 4.675zM8.598 12.66L6.57 11.49a.072.072 0 0 1-.039-.061V5.833a4.525 4.525 0 0 1 7.413-3.48l-.143.082-4.793 2.769a.777.777 0 0 0-.391.676l-.019 6.78zm1.1-2.379l2.607-1.505 2.607 1.505v3.01l-2.607 1.505-2.607-1.505z"/></svg>' },
  claude:  { label: 'Claude',  icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>' },
  vault:   { label: 'Vault',   icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' },
};

// Config shared by the Codex Agent and Claude Agent forms. Both use the same
// scope-gated /api/codex/* backend; this just parameterizes the UI label,
// default token name, and the per-agent install commands.
const AGENT_CONFIGS = {
  codex: {
    label: 'Codex Agent',
    word: 'Codex',
    namePrefix: 'codex agent',
    defaultName: 'Codex Agent',
    pluginPath: '/api/codex/plugin.zip',
    setupDescription: 'Downloads a plugin bundle and registers it.',
    buildSetup: (origin, token) => `export AD_URL=${origin}
export AD_API_TOKEN='${token}'
mkdir -p ~/plugins
curl -fsSL -H "Authorization: Bearer $AD_API_TOKEN" "$AD_URL/api/codex/plugin.zip" -o /tmp/odysseus-codex-plugin.zip
python3 -m zipfile -e /tmp/odysseus-codex-plugin.zip ~/plugins
python3 - <<'PY'
import json
from pathlib import Path

p = Path.home() / ".agents" / "plugins" / "marketplace.json"
p.parent.mkdir(parents=True, exist_ok=True)
if p.exists():
    data = json.loads(p.read_text())
else:
    data = {"name": "personal", "interface": {"displayName": "Personal"}, "plugins": []}

data.setdefault("name", "personal")
data.setdefault("interface", {}).setdefault("displayName", "Personal")
plugins = data.setdefault("plugins", [])
entry = {
    "name": "odysseus",
    "source": {"source": "local", "path": "./plugins/odysseus"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
    "category": "Productivity",
}
data["plugins"] = [item for item in plugins if item.get("name") != "odysseus"] + [entry]
p.write_text(json.dumps(data, indent=2) + "\\n")
PY
codex plugin add odysseus@personal
python3 ~/plugins/odysseus/scripts/odysseus_api.py capabilities`,
  },
  claude: {
    label: 'Claude Agent',
    word: 'Claude',
    namePrefix: 'claude agent',
    defaultName: 'Claude Agent',
    pluginPath: '/api/claude/plugin.zip',
    setupDescription: 'Downloads a plugin bundle and registers it.',
    buildSetup: (origin, token) => `export AD_URL=${origin}
export AD_API_TOKEN='${token}'
mkdir -p ~/.claude
curl -fsSL -H "Authorization: Bearer $AD_API_TOKEN" "$AD_URL/api/claude/plugin.zip" -o /tmp/odysseus-claude-skill.zip
python3 -m zipfile -e /tmp/odysseus-claude-skill.zip ~/.claude/
python3 ~/.claude/skills/odysseus/scripts/odysseus_api.py capabilities`,
  },
};

let _unifiedInited = false;

async function initUnifiedIntegrations() {
  if (_unifiedInited) return;
  _unifiedInited = true;

  const listEl = el('unified-integrations-list');
  const formEl = el('unified-intg-form');
  const addBtn = el('unified-intg-add-btn');
  if (!listEl) return;
  let integrationNotice = '';

  // Hide the "+ Add Integration" button whenever the per-type create form
  // is open so it doesn't compete visually with the in-progress form.
  // Many call sites toggle formEl.style.display directly; observe instead
  // of patching every one of them.
  if (formEl && addBtn && addBtn.parentElement && !formEl._addBtnObserved) {
    formEl._addBtnObserved = true;
    const addBtnWrap = addBtn.parentElement;
    const _syncAddBtnWrap = () => {
      const formOpen = formEl.style.display && formEl.style.display !== 'none';
      addBtnWrap.style.display = formOpen ? 'none' : '';
    };
    new MutationObserver(_syncAddBtnWrap).observe(formEl, { attributes: true, attributeFilter: ['style'] });
    _syncAddBtnWrap();
  }

  async function fetchAll() {
    const [apiRes, cardRes, contactsRes, mcpRes, vaultRes, tokenRes] = await Promise.all([
      fetch('/api/auth/integrations', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { integrations: [] }).catch(() => ({ integrations: [] })),
      fetch('/api/contacts/config', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('/api/contacts/list', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { contacts: [], count: 0 }).catch(() => ({ contacts: [], count: 0 })),
      fetch('/api/mcp/servers', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/vault/config', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('/api/tokens', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    const items = [];
    // API integrations
    for (const intg of (apiRes.integrations || [])) {
      items.push({ type: 'api', id: intg.id, name: intg.name || 'Unnamed', detail: intg.base_url || '', enabled: intg.enabled !== false, data: intg });
    }
    // Contacts import first, then the optional CardDAV sync account.
    const contactCount = Number(contactsRes.count || (contactsRes.contacts || []).length || 0);
    if (contactCount > 0) {
      items.push({
        type: 'contacts',
        id: '__contacts__',
        name: 'Contacts Import',
        detail: `${contactCount} contact${contactCount === 1 ? '' : 's'}`,
        enabled: true,
        data: contactsRes,
      });
    }
    if (cardRes.url) {
      items.push({
        type: 'carddav',
        id: '__carddav__',
        name: 'Contacts (CardDAV)',
        detail: cardRes.url,
        enabled: true,
        data: cardRes,
      });
    }
    // MCP servers
    const mcpList = Array.isArray(mcpRes) ? mcpRes : (mcpRes.servers || []);
    for (const srv of mcpList) {
      const statusText = srv.needs_oauth ? 'needs auth' : srv.status === 'connected' ? `${srv.enabled_tool_count}/${srv.tool_count} tools` : srv.status === 'error' ? 'error' : 'disconnected';
      items.push({ type: 'mcp', id: srv.id || srv.name, name: srv.name || 'MCP Server', detail: statusText, enabled: srv.is_enabled !== false, data: srv });
    }
    for (const tok of (Array.isArray(tokenRes) ? tokenRes : [])) {
      const scopes = tok.scopes || [];
      const lowerName = (tok.name || '').toLowerCase();
      let agentType = null;
      if (lowerName.startsWith('claude agent')) agentType = 'claude';
      else if (lowerName.startsWith('codex agent')) agentType = 'codex';
      else if (scopes.some(s => String(s || '').startsWith('todos:') || String(s || '').startsWith('documents:'))) {
        // Legacy / un-prefixed scoped tokens fall back to Codex for backwards compat.
        agentType = 'codex';
      }
      if (!agentType) continue;
      const detail = `${tok.token_prefix || 'token'}... - ${scopes.join(', ') || 'chat'}`;
      items.push({ type: agentType, id: tok.id, name: tok.name || (agentType === 'claude' ? 'Claude Agent' : 'Codex Agent'), detail, enabled: true, data: tok });
    }
    // Vaultwarden removed as an integration option.
    return items;
  }

  function renderCard(item) {
    const t = INTG_TYPES[item.type] || INTG_TYPES.api;
    // Static enabled/disabled indicator — same dot every integration
    // type gets (matches the API/CalDAV/MCP pattern).
    const statusDot = item.enabled
      ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--color-success,#50fa7b);flex-shrink:0;--notif-glow:var(--color-success,#50fa7b);animation:cookbook-notif-pulse 2s ease-in-out infinite;" title="Active"></span>'
      : '<span style="width:8px;height:8px;border-radius:50%;background:var(--fg);opacity:0.3;flex-shrink:0" title="Disabled"></span>';
    return `<div class="intg-card" data-intg-id="${item.id}" data-intg-type="${item.type}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:color-mix(in srgb, var(--fg) 3%, transparent);margin-bottom:6px;cursor:pointer;transition:all 0.15s;" title="Click to edit">
      <span style="color:var(--accent, var(--red));flex-shrink:0">${t.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px">${item.name} <span style="font-size:14px;text-transform:uppercase;letter-spacing:0.5px;padding:1px 5px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 50%, transparent);border-radius:3px;color:var(--accent, var(--red));background:color-mix(in srgb, var(--accent, var(--red)) 12%, transparent);">${t.label}</span></div>
        <div style="font-size:14px;opacity:0.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.detail || ''}</div>
      </div>
      ${statusDot}
      <button class="admin-btn-sm intg-del-btn" data-intg-id="${item.id}" data-intg-type="${item.type}" data-intg-name="${(item.name || '').replace(/"/g, '&quot;')}" title="Remove" style="background:none;border:none;padding:4px;cursor:pointer;color:var(--red);opacity:0.55;display:inline-flex;align-items:center;justify-content:center;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>`;
  }

  async function renderList() {
    const items = await fetchAll();
    const noticeHtml = integrationNotice ? `
      <div class="intg-followup-note" style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:8px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 35%, transparent);border-left:3px solid var(--accent, var(--red));border-radius:5px;background:color-mix(in srgb, var(--accent, var(--red)) 8%, transparent);font-size:14px;">
        <span style="flex:1;line-height:1.35">${integrationNotice}</span>
      </div>` : '';
    if (items.length === 0) {
      listEl.innerHTML = noticeHtml + '<div style="padding:12px;opacity:0.5;font-size:14px;text-align:center">No integrations configured</div>';
    } else {
      listEl.innerHTML = noticeHtml + items.map(renderCard).join('');
    }
    // Wire edit clicks
    listEl.querySelectorAll('.intg-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.intg-del-btn')) return;
        const type = card.dataset.intgType;
        const id = card.dataset.intgId;
        // Toggle a class instead of mutating inline borderColor — the
        // inline border shorthand made the reset unreliable, leaving
        // stale accent borders on previously-clicked cards.
        listEl.querySelectorAll('.intg-card.intg-card-active').forEach(c => c.classList.remove('intg-card-active'));
        card.classList.add('intg-card-active');
        showForm(type, id);
      });
    });
    // Wire delete
    listEl.querySelectorAll('.intg-del-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const intgName = btn.dataset.intgName || 'this integration';
        if (!await window.styledConfirm(`Remove "${intgName}"?`, { confirmText: 'Remove', danger: true })) return;
        const type = btn.dataset.intgType;
        const id = btn.dataset.intgId;
        try {
          if (type === 'api') await fetch(`/api/auth/integrations/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'contacts') {
            await fetch('/api/contacts/clear', { method: 'DELETE', credentials: 'same-origin' });
          }
          else if (type === 'carddav') {
            await fetch('/api/contacts/config', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ carddav_url: '', carddav_username: '', carddav_password: '' }) });
          }
          else if (type === 'mcp') await fetch(`/api/mcp/servers/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'codex' || type === 'claude') await fetch(`/api/tokens/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'vault') await fetch('/api/vault/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (_) {}
        formEl.style.display = 'none';
        await renderList();
        notifyIntegrationsChanged();
      });
    });
  }

  function showForm(type, editId) {
    formEl.style.display = '';
    if (type === 'api') showApiForm(editId);
    else if (type === 'contacts' || type === 'carddav') showCardDavForm();
    else if (type === 'mcp') showMcpForm(editId);
    else if (type === 'codex') showAgentForm('codex', editId);
    else if (type === 'claude') showAgentForm('claude', editId);
    else if (type === 'vault') showVaultForm();
  }

  // ── API form ──
  async function showApiForm(editId) {
    let presets = {};
    try {
      const r = await fetch('/api/auth/integrations/presets', { credentials: 'same-origin' });
      if (r.ok) { const d = await r.json(); presets = d.presets || {}; }
    } catch (_) {}
    const presetEntries = Object.entries(presets);
    // Same `?` hint helper as the email form. Native title tooltip,
    // tabbable for keyboard users. Inline-styled so it doesn't need
    // a CSS dependency.
    const _apiHint = (tip) =>
      `<span class="uf-hint" title="${esc(tip.replace(/<[^>]+>/g, ''))}" aria-label="${esc(tip.replace(/<[^>]+>/g, ''))}" tabindex="0" `
      + `style="display:inline-block;width:13px;height:13px;border-radius:50%;`
      + `border:1px solid currentColor;font-size:14px;line-height:11px;text-align:center;`
      + `opacity:0.45;margin-left:5px;cursor:help;vertical-align:1px;font-weight:600;">?</span>`;
    // Real <select> instead of <datalist>: datalists are silently
    // suppressed in Firefox when autocomplete="off" is on the input,
    // and they're patchy on mobile browsers. A native select renders
    // the same everywhere and makes the available options visible
    // without needing the user to type.
    const sortedPresets = presetEntries.sort((a, b) => (a[1].name || a[0]).localeCompare(b[1].name || b[0]));
    const selectOpts = sortedPresets
      .map(([k, p]) => `<option value="${k}">${esc(p.name || k)}</option>`)
      .join('');
    // Letter-in-brand-color logo for each API preset; outline plug icon for
    // "Custom (no preset)". Matches the email-provider dropdown pattern.
    const _apiLetter = (letter, bg) => `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style="flex-shrink:0"><circle cx="12" cy="12" r="11" fill="${bg}"/><text x="12" y="16.5" font-size="13" font-weight="700" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif">${letter}</text></svg>`;
    const _apiCustomIco = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;opacity:0.7"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    const API_PRESET_LOGO = {
      miniflux:        _apiLetter('M', '#214c87'),
      gitea:           _apiLetter('G', '#609926'),
      linkding:        _apiLetter('L', '#1f2937'),
      home_assistant:  _apiLetter('H', '#41bdf5'),
      ntfy:            _apiLetter('n', '#317f43'),
      vaultwarden:     _apiLetter('V', '#175ddc'),
      freshrss:        _apiLetter('R', '#ef6c00'),
    };
    const _apiIconFor = (k) => {
      if (!k) return _apiCustomIco;
      if (API_PRESET_LOGO[k]) return API_PRESET_LOGO[k];
      const first = (presets[k]?.name || k).trim().charAt(0).toUpperCase() || '?';
      return _apiLetter(first, '#6b7280');
    };
    const _apiRows = [['', 'Custom (no preset)'], ...sortedPresets.map(([k, p]) => [k, p.name || k])]
      .map(([k, label]) => `<button type="button" class="ufapi-option" data-value="${esc(k)}" style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;background:transparent;border:0;color:var(--fg);font:inherit;cursor:pointer;text-align:left;">${_apiIconFor(k)}<span>${esc(label)}</span></button>`).join('');
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:14px;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>API Integration</h2>
        <div class="settings-col">
          <div class="settings-row"><label class="settings-label">Preset</label>
            <div style="position:relative;flex:1;min-width:0;">
              <select id="uf-api-preset" tabindex="-1" aria-hidden="true" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;"><option value="">Custom (no preset)</option>${selectOpts}</select>
              <button type="button" id="uf-api-preset-trigger" class="settings-select" style="display:flex;align-items:center;gap:10px;cursor:pointer;text-align:left;width:100%;padding-right:24px;position:relative;">
                <span class="ufapi-icon" style="display:inline-flex;align-items:center;">${_apiCustomIco}</span>
                <span class="ufapi-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Custom (no preset)</span>
                <span aria-hidden="true" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);opacity:0.5;font-size:14px;pointer-events:none;">▾</span>
              </button>
              <div id="uf-api-preset-menu" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:1000;background:var(--panel);border:1px solid var(--border);border-radius:6px;max-height:340px;overflow-y:auto;box-shadow:0 6px 18px rgba(0,0,0,0.25);">${_apiRows}</div>
            </div>
          </div>
          <div class="settings-row"><label class="settings-label">Name</label><input id="uf-api-name" class="settings-input" placeholder="My Service"></div>
          <div class="settings-row"><label class="settings-label">Base URL</label><input id="uf-api-url" class="settings-input" placeholder="http://localhost:8080"></div>
          <div id="uf-api-ntfy-hint" style="display:none;font-size:14px;line-height:1.35;opacity:0.68;margin:-2px 0 2px 106px;"></div>
          <div class="settings-row"><label class="settings-label">Auth${_apiHint('How this service expects the credential to be sent. <b>Bearer</b> = sends "Authorization: Bearer YOUR_KEY" (most modern APIs, ntfy, OpenAI-style). <b>Header</b> = sends YOUR_KEY verbatim under a header name you choose (Miniflux uses X-Auth-Token). <b>Basic</b> = HTTP basic auth (user:pass). <b>None</b> = the API is open / no auth.')}</label><select id="uf-api-auth" class="settings-input"><option value="bearer">Bearer (most common)</option><option value="header">Header</option><option value="basic">Basic</option><option value="none">None</option></select></div>
          <div class="settings-row" id="uf-api-header-row"><label class="settings-label">Header${_apiHint('The HTTP header name the key goes under (Miniflux: X-Auth-Token; most others: Authorization). Only used when Auth = Header.')}</label><input id="uf-api-header" class="settings-input" placeholder="X-Auth-Token"></div>
          <div class="settings-row"><label class="settings-label">API Key${_apiHint('The secret token the service issued you (generated in its admin panel / settings). Used to prove your identity on each request. Required for any Auth mode except None.')}</label><input id="uf-api-key" class="settings-input" type="password" placeholder="Token/key"></div>
          <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;">
            <span id="uf-api-msg" style="font-size:14px;flex:1;margin-right:8px"></span>
            <button class="admin-btn-add" id="uf-api-test" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Test</button>
            <button class="admin-btn-add" id="uf-api-save" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">Save</button>
            <button class="admin-btn-add" id="uf-api-cancel" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Cancel</button>
          </div>
        </div>
      </div>`;
    // Custom preset dropdown wire-up (hidden select stays as data source).
    (() => {
      const trig = el('uf-api-preset-trigger');
      const menu = el('uf-api-preset-menu');
      const sel = el('uf-api-preset');
      if (!trig || !menu || !sel) return;
      const lbl = trig.querySelector('.ufapi-label');
      const ico = trig.querySelector('.ufapi-icon');
      const _setFromKey = (k) => {
        const row = menu.querySelector(`.ufapi-option[data-value="${k}"]`);
        const text = row?.querySelector('span')?.textContent || 'Custom (no preset)';
        if (lbl) lbl.textContent = text;
        if (ico) ico.innerHTML = _apiIconFor(k);
      };
      // Menu is reused (hidden, not recreated). close() hides it and tears down
      // its outside-click listener + Escape-stack entry; bindMenuDismiss is
      // re-registered fresh on each open (see _open).
      let _close = () => { menu.style.display = 'none'; };
      const _open = () => {
        menu.style.display = 'block';
        const tRect = trig.getBoundingClientRect();
        const mRect = menu.getBoundingClientRect();
        const below = window.innerHeight - tRect.bottom;
        const above = tRect.top;
        if (mRect.height > below && above > below) { menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 2px)'; }
        else { menu.style.top = 'calc(100% + 2px)'; menu.style.bottom = 'auto'; }
        _close = bindMenuDismiss(menu, () => { menu.style.display = 'none'; }, (ev) => !menu.contains(ev.target) && ev.target !== trig);
      };
      trig.addEventListener('click', (e) => { e.stopPropagation(); menu.style.display === 'block' ? _close() : _open(); });
      menu.querySelectorAll('.ufapi-option').forEach(btn => {
        btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const k = btn.dataset.value || '';
          sel.value = k;
          _setFromKey(k);
          _close();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      _setFromKey(sel.value || '');
    })();

    const preset = el('uf-api-preset'), name = el('uf-api-name'), url = el('uf-api-url'), auth = el('uf-api-auth'), header = el('uf-api-header'), key = el('uf-api-key'), ntfyHint = el('uf-api-ntfy-hint');
    let _editId = editId && editId !== 'new' ? editId : null;
    // Load existing
    if (_editId) {
      try {
        const r = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
        const d = await r.json();
        const item = (d.integrations || []).find(i => i.id === _editId);
        if (item) { name.value = item.name || ''; url.value = item.base_url || ''; auth.value = item.auth_type || 'none'; header.value = item.auth_header || ''; }
      } catch (_) {}
    }
    // Native <select>: the option `value` is the preset key directly, so
    // no typed-name → key lookup is needed (datalist-era leftover).
    const _applyPreset = () => {
      const p = presets[preset.value];
      const isNtfy = preset.value === 'ntfy' || (p && (p.name || '').toLowerCase() === 'ntfy');
      const isUrlAuth = preset.value === 'discord_webhook'; // secret embedded in URL — no key/auth fields needed
      if (ntfyHint) {
        ntfyHint.style.display = isNtfy ? 'block' : 'none';
        if (isNtfy) {
          ntfyHint.innerHTML = 'Enter the ntfy server URL AD can reach. Examples: <code>http://127.0.0.1:8091</code>, <code>http://100.x.y.z:8091</code>, or <code>https://ntfy.example.com</code>.';
        }
      }
      if (url) {
        url.placeholder = isNtfy ? 'http://127.0.0.1:8091' : isUrlAuth ? 'https://discord.com/api/webhooks/...' : 'http://localhost:8080';
      }
      // For presets that embed the secret in the URL, hide auth/key/header rows
      // so users aren't confused into thinking they need to fill them in.
      const keyRow = key?.closest('.settings-row');
      const authRow = auth?.closest('.settings-row');
      const headerRow = el('uf-api-header-row');
      if (keyRow) keyRow.style.display = isUrlAuth ? 'none' : '';
      if (authRow) authRow.style.display = isUrlAuth ? 'none' : '';
      if (headerRow) headerRow.style.display = isUrlAuth ? 'none' : '';
      if (!p) return;
      name.value = p.name || '';
      auth.value = p.auth_type || 'none';
      header.value = p.auth_header || '';
    };
    preset.addEventListener('change', _applyPreset);
    _applyPreset();
    el('uf-api-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
    el('uf-api-save').addEventListener('click', async () => {
      const presetKey = preset.value || undefined;
      const nameValue = name.value.trim();
      const urlValue = url.value.trim();
      if (!nameValue) { el('uf-api-msg').textContent = 'Name required'; el('uf-api-msg').style.color = 'var(--red)'; return; }
      if (!urlValue) { el('uf-api-msg').textContent = 'Base URL required'; el('uf-api-msg').style.color = 'var(--red)'; return; }
      const body = { name: nameValue, base_url: urlValue, auth_type: auth.value, auth_header: header.value, preset: presetKey };
      if (key.value) body.api_key = key.value;
      try {
        const u = _editId ? `/api/auth/integrations/${_editId}` : '/api/auth/integrations';
        const m = _editId ? 'PUT' : 'POST';
        const r = await fetch(u, { method: m, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error();
        const saved = await r.json().catch(() => null);
        // If this was a create, capture the new ID so Test works
        // immediately without needing a form reopen. The POST response
        // shape is {ok, integration: {id, ...}} — saved.id at the top
        // level would silently miss, leaving Test perpetually stuck on
        // "Save first" until the form was reopened.
        if (!_editId && saved) _editId = saved.integration?.id || saved.id;
        el('uf-api-msg').textContent = 'Saved'; el('uf-api-msg').style.color = 'var(--green,#50fa7b)';
        await renderList();
        notifyIntegrationsChanged();
      } catch (_) { el('uf-api-msg').textContent = 'Failed'; el('uf-api-msg').style.color = 'var(--red)'; }
    });
    el('uf-api-test').addEventListener('click', async () => {
      if (!_editId) { el('uf-api-msg').textContent = 'Save first'; return; }
      try {
        const r = await fetch(`/api/auth/integrations/${_editId}/test`, { method: 'POST', credentials: 'same-origin' });
        const d = await r.json();
        // Backend returns {ok: bool, message: str}
        if (d.ok) {
          el('uf-api-msg').textContent = d.message || 'Connected';
          el('uf-api-msg').style.color = 'var(--green,#50fa7b)';
        } else {
          el('uf-api-msg').textContent = (d.message || d.error || d.detail || `HTTP ${r.status}`).slice(0, 360);
          el('uf-api-msg').style.color = 'var(--red)';
        }
      } catch (e) { el('uf-api-msg').textContent = 'Error: ' + e.message; el('uf-api-msg').style.color = 'var(--red)'; }
    });
  }

  // ── CardDAV form + contacts manager ──
  async function showCardDavForm() {
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:14px;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Contacts (CardDAV)</h2>
        <div class="settings-col">
          <div class="settings-row"><label class="settings-label">URL</label><input id="uf-carddav-url" class="settings-input" placeholder="http://localhost:5232/user/contacts/"></div>
          <div class="settings-row"><label class="settings-label">Username</label><input id="uf-carddav-user" class="settings-input"></div>
          <div class="settings-row"><label class="settings-label">Password</label><input id="uf-carddav-pass" class="settings-input" type="password"></div>
          <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;">
            <span id="uf-carddav-msg" style="font-size:14px;flex:1;margin-right:8px"></span>
            <button class="admin-btn-add" id="uf-carddav-save" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              Save
            </button>
            <button class="admin-btn-add" id="uf-carddav-cancel" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Cancel
            </button>
          </div>
        </div>
      </div>
      <div class="admin-card contacts-manager" style="margin-top:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <h2 style="font-size:14px;margin:0;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Contacts Import <span id="cm-count" style="opacity:0.5;font-weight:normal;font-size:14px;"></span></h2>
          <button class="admin-btn-sm" id="cm-import-btn" style="margin-left:auto;">Import</button>
          <button class="admin-btn-sm" id="cm-export-vcf-btn">Export .vcf</button>
          <button class="admin-btn-sm" id="cm-export-csv-btn">Export .csv</button>
          <button class="admin-btn-sm" id="cm-add-toggle">+ Add</button>
          <input type="file" id="cm-import-file" accept=".vcf,.csv,text/vcard,text/csv" multiple style="display:none">
        </div>
        <div id="cm-add-row" class="contacts-add-row" style="display:none;flex-direction:column;gap:4px;">
          <input id="cm-add-name" class="settings-input" placeholder="Name">
          <input id="cm-add-email" class="settings-input" placeholder="email@example.com">
          <input id="cm-add-phone" class="settings-input" placeholder="Phone (optional)">
          <input id="cm-add-address" class="settings-input" placeholder="Address (optional)">
          <div style="display:flex;gap:6px;justify-content:flex-end;"><button class="admin-btn-sm" id="cm-add-save">Save</button></div>
        </div>
        <input type="text" id="cm-search" class="settings-input" placeholder="Search contacts (name, email, phone, address)" style="margin-top:6px;">
        <div id="cm-list" class="contacts-list"><div style="opacity:0.4;font-size:14px;padding:8px 2px;">Loading…</div></div>
      </div>`;
    try {
      const r = await fetch('/api/contacts/config', { credentials: 'same-origin' }); const d = await r.json();
      el('uf-carddav-url').value = d.url || ''; el('uf-carddav-user').value = d.username || '';
      // Server masks the password as '***' when one is saved (or '' when
      // none). Surface that state via the input's placeholder so users
      // can tell their password is already on file without us echoing it.
      const passInput = el('uf-carddav-pass');
      if (passInput && d.password) passInput.placeholder = '(unchanged)';
    } catch (_) {}
    el('uf-carddav-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
    el('uf-carddav-save').addEventListener('click', async () => {
      const body = { carddav_url: el('uf-carddav-url').value, carddav_username: el('uf-carddav-user').value };
      if (el('uf-carddav-pass').value) body.carddav_password = el('uf-carddav-pass').value;
      try {
        await fetch('/api/contacts/config', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        el('uf-carddav-msg').textContent = 'Saved';
        el('uf-carddav-msg').style.color = 'var(--green, #50fa7b)';
        // Refresh both the sub-panel (contacts manager) AND the
        // outer integrations list so the CardDAV row appears
        // immediately instead of waiting for a page reload.
        await _renderContactsManager();
        await renderList();
        notifyIntegrationsChanged();
      } catch (_) {
        el('uf-carddav-msg').textContent = 'Failed';
        el('uf-carddav-msg').style.color = 'var(--red)';
      }
    });
    // Add-row toggle + save
    el('cm-add-toggle')?.addEventListener('click', () => {
      const row = el('cm-add-row');
      const open = row.style.display !== 'none';
      row.style.display = open ? 'none' : 'flex';
      if (!open) el('cm-add-name')?.focus();
    });
    el('cm-add-save')?.addEventListener('click', async () => {
      const name = el('cm-add-name').value.trim();
      const email = el('cm-add-email').value.trim();
      const phone = el('cm-add-phone')?.value.trim() || '';
      const address = el('cm-add-address')?.value.trim() || '';
      // Need at least a name or email; address-only entries without a
      // name aren't useful as a contact.
      if (!name && !email) { (name ? el('cm-add-email') : el('cm-add-name')).focus(); return; }
      try {
        await fetch('/api/contacts/add', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, phone, address }) });
      } catch (_) {}
      el('cm-add-name').value = '';
      el('cm-add-email').value = '';
      if (el('cm-add-phone')) el('cm-add-phone').value = '';
      if (el('cm-add-address')) el('cm-add-address').value = '';
      el('cm-add-row').style.display = 'none';
      await _renderContactsManager();
    });
    const _downloadContacts = async (format) => {
      const btn = el(format === 'csv' ? 'cm-export-csv-btn' : 'cm-export-vcf-btn');
      const orig = btn ? btn.textContent : '';
      if (btn) { btn.textContent = 'Exporting...'; btn.disabled = true; }
      try {
        const res = await fetch(`/api/contacts/export?format=${encodeURIComponent(format)}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = format === 'csv' ? 'odysseus-contacts.csv' : 'odysseus-contacts.vcf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (_) {
        uiModule.showError ? uiModule.showError('Export failed') : alert('Export failed');
      } finally {
        if (btn) { btn.textContent = orig; btn.disabled = false; }
      }
    };
    el('cm-export-vcf-btn')?.addEventListener('click', () => _downloadContacts('vcf'));
    el('cm-export-csv-btn')?.addEventListener('click', () => _downloadContacts('csv'));

    // Import .vcf/.csv — read each selected file as text, concatenate by type,
    // then POST. Imported CardDAV contacts immediately feed email autocomplete
    // because compose searches /api/contacts/search.
    el('cm-import-btn')?.addEventListener('click', () => el('cm-import-file')?.click());
    el('cm-import-file')?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const btn = el('cm-import-btn');
      const orig = btn ? btn.textContent : '';
      if (btn) { btn.textContent = 'Importing…'; btn.disabled = true; }
      try {
        const texts = await Promise.all(files.map(f => f.text()));
        const vcfParts = [];
        const csvParts = [];
        texts.forEach((text, idx) => {
          const name = (files[idx]?.name || '').toLowerCase();
          if (name.endsWith('.csv') || !String(text || '').toUpperCase().includes('BEGIN:VCARD')) csvParts.push(text);
          else vcfParts.push(text);
        });
        let imported = 0, total = 0, failed = 0;
        const _postImport = async (body) => {
          const r = await fetch('/api/contacts/import', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const d = await r.json();
          if (d.error) throw new Error(d.error);
          imported += Number(d.imported || 0);
          total += Number(d.total || 0);
          failed += Number(d.failed || 0);
        };
        if (vcfParts.length) await _postImport({ vcf: vcfParts.join('\n') });
        if (csvParts.length) await _postImport({ csv: csvParts.join('\n') });
        if (!vcfParts.length && !csvParts.length) throw new Error('No contact data found');
        const msg = `Imported ${imported}/${total}` + (failed ? ` (${failed} failed)` : '');
        uiModule.showToast ? uiModule.showToast(msg) : null;
      } catch (err) {
        uiModule.showError ? uiModule.showError(err?.message || 'Import failed') : alert(err?.message || 'Import failed');
      } finally {
        if (btn) { btn.textContent = orig; btn.disabled = false; }
        e.target.value = '';
        await _renderContactsManager();
      }
    });
    await _renderContactsManager();
  }

  // Render the contacts list inside the manager card with inline edit +
  // delete. Each row: name + emails; pencil flips to editable inputs.
  async function _renderContactsManager() {
    const list = el('cm-list');
    if (!list) return;
    let contacts = [];
    try {
      const r = await fetch('/api/contacts/list', { credentials: 'same-origin' });
      const d = await r.json();
      contacts = d.contacts || [];
    } catch (_) {
      list.innerHTML = '<div style="opacity:0.5;font-size:14px;padding:8px 2px;">Failed to load contacts (check CardDAV config above).</div>';
      return;
    }
    const cnt = el('cm-count');
    if (cnt) cnt.textContent = contacts.length ? `(${contacts.length})` : '';
    if (!contacts.length) {
      list.innerHTML = '<div style="opacity:0.4;font-size:14px;padding:8px 2px;">No contacts yet.</div>';
      return;
    }
    // Sort by name for a stable list.
    contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Live filter — search across name/emails/phones/address.
    const searchInput = el('cm-search');
    const q = (searchInput?.value || '').trim().toLowerCase();
    const filtered = !q ? contacts : contacts.filter(c => {
      const hay = [
        c.name || '',
        (c.emails || []).join(' '),
        (c.phones || []).join(' '),
        c.address || '',
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
    if (cnt) cnt.textContent = contacts.length ? `(${filtered.length}/${contacts.length})` : '';

    if (!filtered.length) {
      list.innerHTML = `<div style="opacity:0.4;font-size:14px;padding:8px 2px;">${q ? 'No matches.' : 'No contacts yet.'}</div>`;
    } else {
      list.innerHTML = filtered.map(c => {
        const emails = (c.emails || []).join(', ');
        const phones = (c.phones || []).join(', ');
        const address = c.address || '';
        const sub = [emails, phones, address].filter(Boolean).join(' · ');
        return `<div class="contact-row" data-uid="${esc(c.uid)}">
          <div class="contact-row-view" style="display:flex;align-items:center;gap:8px;">
            <div style="flex:1;min-width:0;">
              <div class="contact-name" style="font-size:14px;font-weight:600;">${esc(c.name || '(no name)')}</div>
              <div class="contact-sub" style="font-size:14px;opacity:0.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(sub)}</div>
            </div>
            <button class="admin-btn-sm contact-edit" title="Edit" style="display:inline-flex;align-items:center;gap:4px;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 35%, var(--border));">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>
            <button class="admin-btn-sm contact-del" title="Delete" style="opacity:0.85;display:inline-flex;align-items:center;gap:4px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              Delete
            </button>
          </div>
          <div class="contact-row-edit" style="display:none;flex-direction:column;gap:4px;">
            <input class="settings-input contact-edit-name" value="${esc(c.name || '')}" placeholder="Name">
            <input class="settings-input contact-edit-emails" value="${esc(emails)}" placeholder="email1, email2">
            <input class="settings-input contact-edit-phones" value="${esc(phones)}" placeholder="phone1, phone2">
            <input class="settings-input contact-edit-address" value="${esc(address)}" placeholder="Address">
            <div style="display:flex;gap:6px;"><button class="admin-btn-sm contact-save">Save</button><button class="admin-btn-sm contact-cancel" style="opacity:0.7;">Cancel</button></div>
          </div>
        </div>`;
      }).join('');
    }

    // Wire the search input — debounced so we don't refetch on every key.
    if (searchInput && !searchInput._wired) {
      searchInput._wired = true;
      let _t;
      searchInput.addEventListener('input', () => {
        clearTimeout(_t);
        _t = setTimeout(() => _renderContactsManager(), 80);
      });
    }
    // Stash latest contacts so the search input doesn't have to refetch.
    list._lastContacts = contacts;
    // Wire each row's edit / delete / save / cancel.
    list.querySelectorAll('.contact-row').forEach(row => {
      const uid = row.dataset.uid;
      const view = row.querySelector('.contact-row-view');
      const editForm = row.querySelector('.contact-row-edit');
      row.querySelector('.contact-edit')?.addEventListener('click', () => {
        view.style.display = 'none';
        editForm.style.display = 'flex';
      });
      row.querySelector('.contact-cancel')?.addEventListener('click', () => {
        editForm.style.display = 'none';
        view.style.display = 'flex';
      });
      row.querySelector('.contact-save')?.addEventListener('click', async () => {
        const body = {
          name: row.querySelector('.contact-edit-name').value.trim(),
          emails: row.querySelector('.contact-edit-emails').value.split(',').map(s => s.trim()).filter(Boolean),
          phones: row.querySelector('.contact-edit-phones').value.split(',').map(s => s.trim()).filter(Boolean),
          address: row.querySelector('.contact-edit-address')?.value.trim() || '',
        };
        try {
          await fetch('/api/contacts/' + encodeURIComponent(uid), { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        } catch (_) {}
        await _renderContactsManager();
      });
      row.querySelector('.contact-del')?.addEventListener('click', async () => {
        const ok = uiModule.styledConfirm
          ? await uiModule.styledConfirm('Delete this contact?', { confirmText: 'Delete', danger: true })
          : window.confirm('Delete this contact?');
        if (!ok) return;
        try {
          await fetch('/api/contacts/' + encodeURIComponent(uid), { method: 'DELETE', credentials: 'same-origin' });
        } catch (_) {}
        await _renderContactsManager();
      });
    });
  }


  // ── Vaultwarden form ──
  async function showVaultForm() {
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:14px">Vaultwarden (Password Vault)</h2>
        <div id="uf-vault-status" style="font-size:14px;opacity:0.7;margin-bottom:8px">Loading...</div>
        <div class="settings-col">
          <div class="settings-row"><label class="settings-label">Server URL</label><input id="uf-vault-url" class="settings-input" placeholder="https://vault.example.com"></div>
          <div class="settings-row"><label class="settings-label">Email</label><input id="uf-vault-email" class="settings-input" placeholder="you@example.com"></div>
          <div class="settings-row"><label class="settings-label">Master Password</label><input id="uf-vault-pass" class="settings-input" type="password" placeholder="Only required for Login / Unlock"></div>
          <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;">
            <span id="uf-vault-msg" style="font-size:14px;flex:1;margin-right:8px"></span>
            <button class="admin-btn-add" id="uf-vault-save" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">Save Config</button>
            <button class="admin-btn-add" id="uf-vault-login" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Login</button>
            <button class="admin-btn-add" id="uf-vault-unlock" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Unlock</button>
            <button class="admin-btn-add" id="uf-vault-lock" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Lock</button>
            <button class="admin-btn-add" id="uf-vault-logout" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Logout</button>
            <button class="admin-btn-add" id="uf-vault-cancel" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Cancel</button>
          </div>
          <div style="font-size:14px;opacity:0.5;margin-top:6px;line-height:1.4">
            <strong>Login</strong> registers this device with your Vaultwarden account (once per account).<br>
            <strong>Unlock</strong> decrypts the vault — required after restart or Lock. Session is saved so the assistant can read passwords.
          </div>
        </div>
      </div>`;

    const msg = (text, color) => {
      const m = el('uf-vault-msg');
      m.textContent = text || '';
      m.style.color = color || '';
    };

    async function refreshStatus() {
      try {
        const r = await fetch('/api/vault/config', { credentials: 'same-origin' });
        const d = await r.json();
        el('uf-vault-url').value = d.server_url || '';
        el('uf-vault-email').value = d.email || '';
        const installed = d.bw_installed;
        const parts = [];
        parts.push(installed ? 'bw CLI: installed' : 'bw CLI: NOT installed (install nodejs-bitwarden-cli)');
        parts.push(d.unlocked ? 'Status: UNLOCKED' : 'Status: locked');
        if (d.unlocked_at) parts.push(`Last unlock: ${d.unlocked_at.replace('T',' ').slice(0,19)}`);
        const statusEl = el('uf-vault-status');
        statusEl.textContent = parts.join(' — ');
        statusEl.style.color = !installed ? 'var(--red)' : d.unlocked ? 'var(--green,#50fa7b)' : '';
      } catch (_) {
        el('uf-vault-status').textContent = 'Failed to load vault status';
      }
    }
    await refreshStatus();

    el('uf-vault-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });

    el('uf-vault-save').addEventListener('click', async () => {
      msg('Saving...');
      try {
        const r = await fetch('/api/vault/config', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server_url: el('uf-vault-url').value, email: el('uf-vault-email').value }),
        });
        const d = await r.json();
        if (d.ok) { msg('Saved', 'var(--green,#50fa7b)'); await refreshStatus(); await renderList(); }
        else msg(d.error || 'Failed', 'var(--red)');
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });

    el('uf-vault-login').addEventListener('click', async () => {
      const email = el('uf-vault-email').value.trim();
      const pass = el('uf-vault-pass').value;
      if (!email || !pass) { msg('Email + master password required', 'var(--red)'); return; }
      msg('Logging in...');
      try {
        const r = await fetch('/api/vault/login', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, master_password: pass }),
        });
        const d = await r.json();
        if (d.ok) {
          msg(d.already ? 'Already logged in — use Unlock' : 'Logged in', 'var(--green,#50fa7b)');
          el('uf-vault-pass').value = '';
          await refreshStatus(); await renderList();
        } else msg(d.error || 'Login failed', 'var(--red)');
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });

    el('uf-vault-unlock').addEventListener('click', async () => {
      const pass = el('uf-vault-pass').value;
      if (!pass) { msg('Master password required', 'var(--red)'); return; }
      msg('Unlocking...');
      try {
        const r = await fetch('/api/vault/unlock', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ master_password: pass }),
        });
        const d = await r.json();
        if (d.ok) {
          msg('Vault unlocked', 'var(--green,#50fa7b)');
          el('uf-vault-pass').value = '';
          await refreshStatus(); await renderList();
        } else msg(d.error || 'Unlock failed', 'var(--red)');
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });

    el('uf-vault-lock').addEventListener('click', async () => {
      msg('Locking...');
      try {
        await fetch('/api/vault/lock', { method: 'POST', credentials: 'same-origin' });
        msg('Locked', 'var(--green,#50fa7b)');
        await refreshStatus(); await renderList();
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });

    el('uf-vault-logout').addEventListener('click', async () => {
      if (!await window.styledConfirm('Log out of Bitwarden CLI? You\'ll need to re-enter your master password to log back in.', { confirmText: 'Log out' })) return;
      msg('Logging out...');
      try {
        await fetch('/api/vault/logout', { method: 'POST', credentials: 'same-origin' });
        msg('Logged out', 'var(--green,#50fa7b)');
        await refreshStatus(); await renderList();
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });
  }

  // ── MCP form — full management view ──
  async function showMcpForm(editId) {
    // Toggle an in-flight loading state on a button (disabled + dimmed + label).
    function _setBtnLoading(btn, loading, label) {
      if (!btn) return;
      btn.disabled = loading;
      btn.style.opacity = loading ? '0.6' : '';
      btn.style.cursor = loading ? 'progress' : '';
      if (label != null) btn.textContent = label;
    }
    function _showMcpPasteback(id) {
      const msg = el('uf-mcp-msg'); if (!msg) return;
      if (el('uf-mcp-pasteback')) return;  // already shown
      msg.innerHTML =
        'Authorize in the opened tab. If the redirect fails (remote access), paste the resulting URL here: ' +
        '<input id="uf-mcp-pasteback" class="settings-input" placeholder="http://localhost:7000/api/mcp/oauth/callback?code=..." style="margin-top:4px">' +
        '<button class="admin-btn-sm" id="uf-mcp-paste-go" style="margin-top:4px">Submit</button>';
      const pasteGo = el('uf-mcp-paste-go');
      if (pasteGo) pasteGo.addEventListener('click', async () => {
        const cb = el('uf-mcp-pasteback').value.trim();
        if (!cb) return;
        const pf = new FormData(); pf.append('callback_url', cb);
        _setBtnLoading(pasteGo, true, 'Submitting…');
        try {
          await fetch(`/api/mcp/oauth/exchange/${id}`, { method: 'POST', credentials: 'same-origin', body: pf });
        } finally {
          _setBtnLoading(pasteGo, false, 'Submit');
        }
      });
    }

    // Drives the OAuth flow: waits for the auth_url (discovery+DCR may lag),
    // opens it once, then resolves on connected/error.
    async function _handleMcpAuth(id, initialAuthUrl, tries = 90) {
      let opened = false;
      const openAuth = (u) => { if (!opened && u) { opened = true; window.open(u, '_blank', 'noopener'); _showMcpPasteback(id); } };
      openAuth(initialAuthUrl);
      const msg = el('uf-mcp-msg');
      let fails = 0;
      for (let i = 0; i < tries; i++) {
        await new Promise(res => setTimeout(res, 2000));
        try {
          const r = await fetch('/api/mcp/servers', { credentials: 'same-origin' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const list = await r.json();
          fails = 0;
          const s = Array.isArray(list) ? list.find(x => x.id === id) : null;
          if (!s) continue;
          if (s.auth_url) openAuth(s.auth_url);
          if (s.status === 'connected') {
            if (msg) msg.textContent = `Connected (${s.tool_count || 0} tools)`;
            await renderList(); return;
          }
          if (s.status === 'error') {
            if (msg) msg.textContent = `Failed: ${s.error || 'unknown'}`; return;
          }
        } catch (e) {
          // Tolerate a single blip, but surface persistent failures instead of
          // silently polling until timeout.
          if (++fails >= 5 && msg) msg.textContent = `Status check failing (${e.message || 'network error'}) — still retrying…`;
        }
      }
      if (msg) msg.textContent = 'Authorization timed out. Reconnect from the server list to retry.';
    }
    if (editId && editId !== 'new') {
      // Show management view for existing server
      formEl.innerHTML = '<div class="admin-card" style="margin-top:8px"><span style="opacity:0.5;font-size:14px">Loading...</span></div>';
      try {
        const res = await fetch('/api/mcp/servers', { credentials: 'same-origin' });
        const servers = await res.json();
        const srv = servers.find(s => (s.id || s.name) === editId);
        if (!srv) { formEl.innerHTML = '<div class="admin-card" style="margin-top:8px">Server not found</div>'; return; }
        const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
        const statusColor = srv.needs_oauth ? '#e5a33a' : srv.status === 'connected' ? 'var(--green,#50fa7b)' : srv.status === 'error' ? 'var(--red)' : 'var(--fg)';
        const toolInfo = srv.status === 'connected' ? `${srv.enabled_tool_count}/${srv.tool_count} tools` : '';
        const statusText = srv.needs_oauth ? 'Needs authorization' : srv.status === 'connected' ? `Connected (${toolInfo})` : srv.status === 'error' ? `Error: ${esc(srv.error || 'unknown')}` : 'Disconnected';
        formEl.innerHTML = `
          <div class="admin-card" style="margin-top:8px">
            <h2 style="font-size:14px">${esc(srv.name)}</h2>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor}"></span>
              <span style="font-size:14px;opacity:0.7">${statusText}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;justify-content:flex-end;">
              <span id="uf-mcp-msg" style="font-size:14px;flex:1;margin-right:8px"></span>
              ${srv.needs_oauth ? `<a href="/api/mcp/oauth/authorize/${srv.id}" target="_blank" class="admin-btn-add" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));text-decoration:none;font-weight:600;">Authorize</a>` : ''}
              <button class="admin-btn-add" id="uf-mcp-reconnect" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Reconnect</button>
              <button class="admin-btn-add" id="uf-mcp-toggle" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">${srv.is_enabled ? 'Disable' : 'Enable'}</button>
              <button class="admin-btn-add" id="uf-mcp-cancel" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Close</button>
            </div>
            <div id="uf-mcp-tools-panel"></div>
          </div>`;
        // Reconnect
        el('uf-mcp-reconnect').addEventListener('click', async () => {
          const msg = el('uf-mcp-msg'); msg.textContent = 'Reconnecting...';
          try {
            const r = await fetch(`/api/mcp/servers/${srv.id}/reconnect`, { method: 'POST', credentials: 'same-origin' });
            const d = await r.json();
            msg.textContent = d.connected ? `Connected (${d.tool_count} tools)` : `Failed: ${d.error || 'unknown'}`;
            await renderList();
            showMcpForm(editId); // refresh this view
          } catch (e) { msg.textContent = 'Failed'; }
        });
        // Toggle enable/disable
        el('uf-mcp-toggle').addEventListener('click', async () => {
          const fd = new FormData(); fd.append('is_enabled', String(!srv.is_enabled));
          await fetch(`/api/mcp/servers/${srv.id}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
          await renderList();
          showMcpForm(editId);
        });
        el('uf-mcp-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
        // Load tools list
        if (srv.status === 'connected' && srv.tool_count > 0) {
          const panel = el('uf-mcp-tools-panel');
          try {
            const tr = await fetch(`/api/mcp/servers/${srv.id}/tools`, { credentials: 'same-origin' });
            const tools = await tr.json();
            if (tools.length) {
              const disabled = new Set(tools.filter(t => t.is_disabled).map(t => t.name));
              panel.innerHTML = `<div class="mcp-tools-header"><span>Tools</span><span style="display:flex;gap:8px;align-items:center"><span class="mcp-tools-count">${tools.length - disabled.size}/${tools.length} enabled</span><a href="#" id="uf-mcp-all">All</a> <a href="#" id="uf-mcp-none">None</a></span></div><div class="mcp-tools-list">${tools.map(t => `<label title="${esc(t.description)}"><input type="checkbox" data-mcp-tool-name="${esc(t.name)}" ${!t.is_disabled ? 'checked' : ''}><span><strong>${esc(t.name)}</strong> <span style="opacity:0.5">— ${esc((t.description||'').slice(0,80))}</span></span></label>`).join('')}</div>`;
              const saveFn = async () => {
                const dis = [];
                panel.querySelectorAll('input[type=checkbox]').forEach(cb => { if (!cb.checked) dis.push(cb.dataset.mcpToolName); });
                await fetch(`/api/mcp/servers/${srv.id}/tools`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ disabled: dis }) });
                const cnt = panel.querySelector('.mcp-tools-count');
                if (cnt) cnt.textContent = `${tools.length - dis.length}/${tools.length} enabled`;
              };
              panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', saveFn));
              el('uf-mcp-all')?.addEventListener('click', (e) => { e.preventDefault(); panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true); saveFn(); });
              el('uf-mcp-none')?.addEventListener('click', (e) => { e.preventDefault(); panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false); saveFn(); });
            }
          } catch (_) { panel.innerHTML = '<span style="opacity:0.5;font-size:14px">Failed to load tools</span>'; }
        }
      } catch (_) { formEl.innerHTML = '<div class="admin-card" style="margin-top:8px">Failed to load server</div>'; }
    } else {
      // Add new MCP server form
      formEl.innerHTML = `
        <div class="admin-card" style="margin-top:8px">
          <h2 style="font-size:14px">Add MCP Server</h2>
          <div class="settings-col">
            <div class="settings-row"><label class="settings-label">Name</label><input id="uf-mcp-name" class="settings-input" placeholder="Server name"></div>
            <div class="settings-row"><label class="settings-label">Transport</label><select id="uf-mcp-transport" class="settings-input"><option value="stdio">stdio</option><option value="sse">SSE</option><option value="http">Streamable HTTP</option></select></div>
            <div id="uf-mcp-stdio-fields" style="display:flex;flex-direction:column;gap:6px;">
              <div class="settings-row"><label class="settings-label">Command</label><input id="uf-mcp-cmd" class="settings-input" placeholder="npx"></div>
              <div class="settings-row"><label class="settings-label">Args</label><input id="uf-mcp-args" class="settings-input" placeholder='["-y", "@modelcontextprotocol/server-filesystem"]'></div>
              <div class="settings-row"><label class="settings-label">Env</label><input id="uf-mcp-env" class="settings-input" placeholder='{"KEY": "value"}'></div>
            </div>
            <div id="uf-mcp-sse-fields" style="display:none;flex-direction:column;gap:6px;">
              <div class="settings-row"><label class="settings-label">URL</label><input id="uf-mcp-url" class="settings-input" placeholder="http://localhost:3001/sse"></div>
            </div>
            <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;">
              <span id="uf-mcp-msg" style="font-size:14px;flex:1;margin-right:8px"></span>
              <button class="admin-btn-add" id="uf-mcp-save" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">Save</button>
              <button class="admin-btn-add" id="uf-mcp-cancel" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Cancel</button>
            </div>
          </div>
        </div>`;
      el('uf-mcp-transport').addEventListener('change', () => {
        const v = el('uf-mcp-transport').value;
        const isUrl = (v === 'sse' || v === 'http');
        el('uf-mcp-stdio-fields').style.display = isUrl ? 'none' : 'flex';
        el('uf-mcp-sse-fields').style.display = isUrl ? 'flex' : 'none';
        const urlInput = el('uf-mcp-url');
        if (urlInput) urlInput.placeholder = (v === 'http') ? 'https://mcp.example.com/mcp' : 'http://localhost:3001/sse';
      });
      el('uf-mcp-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
      el('uf-mcp-save').addEventListener('click', async () => {
        const transport = el('uf-mcp-transport').value;
        // routes/mcp_routes.py uses FastAPI Form(...) — send multipart, not JSON.
        const fd = new FormData();
        fd.append('name', el('uf-mcp-name').value);
        fd.append('transport', transport);
        if (transport === 'stdio') {
          fd.append('command', el('uf-mcp-cmd').value);
          let args = '[]'; try { args = JSON.stringify(JSON.parse(el('uf-mcp-args').value || '[]')); } catch (_) {}
          let env  = '{}'; try { env  = JSON.stringify(JSON.parse(el('uf-mcp-env').value  || '{}')); } catch (_) {}
          fd.append('args', args);
          fd.append('env', env);
        } else {
          fd.append('url', el('uf-mcp-url').value);
        }
        const saveBtn = el('uf-mcp-save'), cancelBtn = el('uf-mcp-cancel');
        const _origLabel = saveBtn.textContent;
        _setBtnLoading(saveBtn, true, 'Saving…'); if (cancelBtn) cancelBtn.disabled = true;
        try {
          const r = await fetch('/api/mcp/servers', { method: 'POST', credentials: 'same-origin', body: fd });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.needs_auth) {
            el('uf-mcp-msg').textContent = 'Preparing authorization…';
            _handleMcpAuth(data.id, data.auth_url);
          } else if (r.ok && (data.connected || data.status === 'connected')) {
            el('uf-mcp-msg').textContent = `Connected (${data.tool_count || 0} tools)`;
            formEl.style.display = 'none'; await renderList();
          } else if (r.ok) {
            el('uf-mcp-msg').textContent = 'Saved'; formEl.style.display = 'none'; await renderList();
          } else {
            el('uf-mcp-msg').textContent = `Failed (${r.status})`;
          }
        } catch (_) { el('uf-mcp-msg').textContent = 'Failed'; }
        finally { _setBtnLoading(saveBtn, false, _origLabel); if (cancelBtn) cancelBtn.disabled = false; }
      });
    }
  }

  async function showAgentForm(kind, editId) {
    const cfg = AGENT_CONFIGS[kind] || AGENT_CONFIGS.codex;
    let tokens = [];
    try {
      const tokRes = await fetch('/api/tokens', { credentials: 'same-origin' });
      if (tokRes.ok) tokens = await tokRes.json();
    } catch (_) {}

    const toolScopes = [
      { key: 'todos:read', label: 'Todos', detail: 'Read notes and checklists' },
      { key: 'todos:write', label: 'Todos write', detail: 'Create, update, delete, and toggle todo items' },
      { key: 'documents:read', label: 'Documents', detail: 'Read documents when a document API is enabled' },
      { key: 'documents:write', label: 'Documents write', detail: 'Create and update draft documents' },
      { key: 'memory:read', label: 'Memory', detail: 'Read memory when enabled' },
      { key: 'memory:write', label: 'Memory write', detail: 'Write memory when enabled' },
      { key: 'cookbook:read', label: 'Cookbook', detail: 'List cookbook tasks + tail their tmux output (debug a model serve from outside the UI)' },
      { key: 'cookbook:launch', label: 'Cookbook launch', detail: 'Launch and stop cookbook serve tasks. Powerful: runs SSH commands on your configured servers, bounded by the same allowlist the UI uses (vllm/python3/sglang/llama-server/...)' },
    ];
    // Strict name-prefix match keeps Codex and Claude tokens in their own forms.
    const agentTokens = (Array.isArray(tokens) ? tokens : []).filter(tok =>
      (tok.name || '').toLowerCase().startsWith(cfg.namePrefix)
    );
    const current = agentTokens.find(t => String(t.id) === String(editId));
    const _scopeIcons = {
      todos: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
      documents: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
      memory: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-2.5 2.5A2.5 2.5 0 0 0 2 9.5v3A2.5 2.5 0 0 0 4.5 15a2.5 2.5 0 0 0 2.5 2.5A2.5 2.5 0 0 0 9.5 20H10V2z"/><path d="M14.5 2a2.5 2.5 0 0 1 2.5 2.5 2.5 2.5 0 0 1 2.5 2.5A2.5 2.5 0 0 1 22 9.5v3A2.5 2.5 0 0 1 19.5 15a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 14.5 20H14V2z"/></svg>',
      cookbook: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    };
    const _scopeNiceLabel = (label) => label.replace(/\s+(write|drafts?|send)$/i, '');
    const _scopeAction = (key) => (key.split(':')[1] || '').toLowerCase();
    const _pillStyle = (action) => {
      if (action === 'read') return 'background:rgba(150,150,150,0.18);color:var(--fg-muted,#888);';
      return 'background:color-mix(in srgb, var(--accent, var(--red)) 18%, transparent);color:var(--accent, var(--red));';
    };
    const scopeToggles = (t) => {
      const scopes = new Set(t.scopes || []);
      return toolScopes.map(scope => {
        const tool = scope.key.split(':')[0];
        const action = _scopeAction(scope.key);
        const icon = _scopeIcons[tool] || '';
        const niceLabel = _scopeNiceLabel(scope.label);
        return `
        <label class="settings-row" style="align-items:center;gap:8px;display:flex;min-height:30px;padding:2px 0;">
          <span style="opacity:0.7;display:inline-flex;align-items:center;justify-content:center;width:16px;flex-shrink:0;">${icon}</span>
          <span class="settings-label" style="width:75px;flex-shrink:0;padding:0;">${esc(niceLabel)}</span>
          <span style="font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;padding:1px 7px;border-radius:999px;flex-shrink:0;min-width:44px;text-align:center;margin-left:-3px;box-sizing:border-box;${_pillStyle(action)}">${esc(action)}</span>
          <span style="font-size:14px;line-height:1.35;opacity:0.62;flex:1;min-width:0;">${esc(scope.detail)}</span>
          <label class="admin-switch" style="margin-left:auto;flex-shrink:0;"><input type="checkbox" class="uf-codex-scope" data-token-id="${esc(t.id)}" data-scope="${esc(scope.key)}" ${scopes.has(scope.key) ? 'checked' : ''}><span class="admin-slider"></span></label>
        </label>`;
      }).join('');
    };
    const origin = window.location.origin || '';
    const setupForToken = (token) => cfg.buildSetup(origin, token);

    // Inline editor for the existing token the user clicked into (current).
    // Shows the rename input, the prefix/last-used, and scope toggles that
    // PATCH /api/tokens/{id} on change. The integration row's trash button
    // handles revoke, so no Revoke button in here.
    const editExistingHtml = current ? `
      <div style="border:1px solid var(--border);border-radius:6px;padding:9px 10px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <input type="text" id="uf-codex-existing-rename" data-token-id="${esc(current.id)}" value="${esc(current.name || cfg.defaultName)}" style="font-size:14px;font-weight:600;padding:3px 6px;flex:1;background:transparent;border:1px solid transparent;border-radius:4px;" title="Click to rename">
          <span style="font-size:14px;opacity:0.55;">${esc(current.token_prefix || 'token')}...${current.last_used_at ? ` · Last used ${new Date(current.last_used_at).toLocaleDateString()}` : ' · Never used'}</span>
        </div>
        <div style="font-size:14px;font-weight:600;opacity:0.62;margin-bottom:4px;">Permissions</div>
        ${scopeToggles(current)}
        <div id="uf-codex-existing-msg" style="font-size:14px;min-height:14px;margin-top:4px;"></div>
      </div>` : '';

    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <div class="settings-col">
          ${editExistingHtml}
          <div id="uf-codex-prompt" style="display:${current ? 'none' : 'block'};padding:6px 0;">
            <div style="font-size:14px;opacity:0.7;margin-bottom:6px;">Name this ${esc(cfg.word)} agent so you can tell it apart from other ones (e.g. "${esc(cfg.defaultName)} — laptop").</div>
            <input type="text" id="uf-codex-name-input" class="settings-select" placeholder="${esc(cfg.defaultName)}" style="width:100%;font-size:14px;padding:6px 8px;">
          </div>
          <div id="uf-codex-pending" style="display:none;align-items:center;gap:8px;padding:6px 0;font-size:14px;opacity:0.7;"></div>
          <div id="uf-codex-reveal" style="display:none;width:100%;box-sizing:border-box;">
            <div style="font-weight:600;font-size:14px;margin-bottom:6px;">Token</div>

            <div style="font-size:14px;opacity:0.62;margin-bottom:4px;">Copy this token, it won't be shown again.</div>
            <div style="position:relative;">
              <code id="uf-codex-token" style="display:block;word-break:break-all;font-size:14px;padding:6px 30px 6px 8px;background:rgba(0,0,0,0.08);border-radius:4px;"></code>
              <button type="button" class="admin-btn-sm" id="uf-codex-copy-token" title="Copy token" aria-label="Copy token" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);padding:3px 5px;background:none;border:none;color:inherit;opacity:0.7;cursor:pointer;display:inline-flex;align-items:center;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </div>

            <div style="margin-top:14px;font-weight:600;font-size:14px;margin-bottom:4px;">Quickstart &mdash; simply paste directly in your terminal.</div>
            <div style="font-size:14px;opacity:0.62;margin-bottom:6px;">${cfg.setupDescription}</div>
            <pre style="margin:0;white-space:pre;overflow-x:auto;max-height:220px;overflow-y:auto;font-size:14px;line-height:1.45;padding:8px 10px;background:rgba(0,0,0,0.08);border-radius:4px;width:100%;box-sizing:border-box;"><code id="uf-codex-setup-code"></code></pre>

            <div style="margin-top:14px;display:flex;align-items:center;gap:8px;">
              <span style="font-weight:600;font-size:14px;">Configure access</span>
              <span style="flex:1"></span>
              <button type="button" class="admin-btn-sm" id="uf-codex-copy-setup" title="Copy setup" aria-label="Copy setup" style="font-size:14px;font-weight:normal;display:inline-flex;align-items:center;gap:5px;opacity:0.85;">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>Copy</span>
              </button>
              <button type="button" class="admin-btn-sm" id="uf-codex-toggle-config" aria-expanded="false" style="font-size:14px;font-weight:normal;display:inline-flex;align-items:center;gap:5px;opacity:0.85;">
                <svg id="uf-codex-toggle-config-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition:transform 0.15s"><polyline points="6 9 12 15 18 9"/></svg>
                <span>Configure</span>
              </button>
            </div>
            <div id="uf-codex-config-body" style="display:none;">
              <div style="font-size:14px;opacity:0.62;margin:4px 0 6px;">Toggle which AD tools this agent can use. New agents start with chat only.</div>
              <div id="uf-codex-inline-scopes"></div>
            </div>
          </div>
          <div class="settings-row" style="margin-top:10px;align-items:center;gap:6px;">
            <button class="admin-btn-add" id="uf-codex-cancel" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Cancel
            </button>
            <span id="uf-codex-msg" style="font-size:14px;flex:1;text-align:center;"></span>
            <button class="admin-btn-add" id="uf-codex-revoke" style="display:none;align-items:center;gap:5px;background:color-mix(in srgb, var(--color-error) 10%, transparent);color:var(--color-error);border:1px solid var(--color-error);font-weight:600;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              Revoke
            </button>
            <button class="admin-btn-add" id="uf-codex-create-btn" style="display:${current ? 'none' : 'inline-flex'};align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/><path d="M15.5 7.5l3 3"/></svg>
              Create token
            </button>
            <button class="admin-btn-add" id="uf-codex-save" style="display:none;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              Save
            </button>
          </div>
        </div>
      </div>`;

    // Editing an existing token: surface Revoke alongside Cancel, and stash
    // the id so the Revoke handler knows what to DELETE.
    if (current) {
      formEl.dataset.createdTokenId = String(current.id);
      const revokeBtn = el('uf-codex-revoke');
      if (revokeBtn) revokeBtn.style.display = 'inline-flex';
      // Inline rename + per-scope PATCH on change.
      const renameInput = el('uf-codex-existing-rename');
      if (renameInput) {
        const original = renameInput.value;
        const commit = async () => {
          const name = (renameInput.value || '').trim();
          if (!name || name === original) return;
          try {
            const r = await fetch(`/api/tokens/${renameInput.dataset.tokenId}`, {
              method: 'PATCH', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            });
            if (!r.ok) throw new Error('Save failed');
            notifyIntegrationsChanged();
          } catch (_) { renameInput.value = original; }
        };
        renameInput.addEventListener('blur', commit);
        renameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); renameInput.blur(); } });
      }
      formEl.querySelectorAll('.uf-codex-scope').forEach(cb => {
        cb.addEventListener('change', async () => {
          const msg = el('uf-codex-existing-msg');
          const scopes = ['chat'].concat(
            Array.from(formEl.querySelectorAll('.uf-codex-scope:checked')).map(input => input.dataset.scope)
          );
          try {
            const r = await fetch(`/api/tokens/${cb.dataset.tokenId}`, {
              method: 'PATCH', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scopes }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.detail || 'Failed');
            if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; setTimeout(() => { msg.textContent = ''; }, 1200); }
            notifyIntegrationsChanged();
          } catch (err) {
            cb.checked = !cb.checked;
            if (msg) { msg.textContent = (err && err.message) || 'Failed'; msg.style.color = 'var(--red)'; }
          }
        });
      });
    }

    el('uf-codex-cancel')?.addEventListener('click', () => { formEl.style.display = 'none'; });

    // Configure access — collapsed by default so the reveal panel doesn't
    // dump 13 toggles at once. Click reveals + rotates the caret.
    el('uf-codex-toggle-config')?.addEventListener('click', () => {
      const body = el('uf-codex-config-body');
      const btn = el('uf-codex-toggle-config');
      const caret = el('uf-codex-toggle-config-caret');
      if (!body || !btn) return;
      const open = body.style.display === 'none';
      body.style.display = open ? '' : 'none';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (caret) caret.style.transform = open ? 'rotate(180deg)' : '';
    });

    el('uf-codex-save')?.addEventListener('click', async () => {
      const msg = el('uf-codex-msg');
      const tokenId = formEl.dataset.createdTokenId;
      if (!tokenId) { formEl.style.display = 'none'; return; }
      const scopes = ['chat'].concat(
        Array.from(formEl.querySelectorAll('#uf-codex-inline-scopes .uf-codex-scope:checked'))
          .map(input => input.dataset.scope)
      );
      try {
        const r = await fetch(`/api/tokens/${tokenId}`, {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scopes }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.detail || 'Failed');
        if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; }
        await renderList();
        setTimeout(() => { formEl.style.display = 'none'; }, 350);
      } catch (err) {
        if (msg) { msg.textContent = err?.message || 'Save failed'; msg.style.color = 'var(--red)'; }
      }
    });

    // Revoke = delete this agent token entirely. Confirmation prompt keeps
    // it from being a one-click footgun. Closes the form on success.
    el('uf-codex-revoke')?.addEventListener('click', async () => {
      const tokenId = formEl.dataset.createdTokenId;
      if (!tokenId) return;
      const ok = window.styledConfirm
        ? await window.styledConfirm(`Revoke this ${cfg.word} agent token? Integrations using it will lose access.`, { confirmText: 'Revoke', danger: true })
        : confirm(`Revoke this ${cfg.word} agent token? Integrations using it will lose access.`);
      if (!ok) return;
      const msg = el('uf-codex-msg');
      try {
        const r = await fetch(`/api/tokens/${tokenId}`, { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) throw new Error('Revoke failed');
        if (msg) { msg.textContent = 'Revoked'; msg.style.color = 'var(--color-error)'; }
        await renderList();
        setTimeout(() => { formEl.style.display = 'none'; }, 350);
      } catch (err) {
        if (msg) { msg.textContent = err?.message || 'Revoke failed'; msg.style.color = 'var(--red)'; }
      }
    });

    const _autoCreateCodex = async () => {
      const msg = el('uf-codex-msg');
      const prompt = el('uf-codex-prompt');
      const pending = el('uf-codex-pending');
      const createBtn = el('uf-codex-create-btn');
      if (prompt) prompt.style.display = 'none';
      if (createBtn) createBtn.style.display = 'none';
      // Whirlpool spinner while the POST is in flight.
      let _wp = null;
      if (pending) {
        pending.innerHTML = '';
        pending.style.display = 'flex';
        try {
          const sp = window.spinnerModule || (await import('./spinner.js')).default;
          _wp = sp.createWhirlpool(14);
          _wp.element.style.cssText = 'display:inline-flex;width:14px;height:14px;margin:0 4px 0 0;';
          pending.appendChild(_wp.element);
          pending.appendChild(document.createTextNode('Creating token…'));
        } catch (_) {
          pending.textContent = 'Creating token…';
        }
      }
      const existingNames = new Set(agentTokens.map(t => (t.name || '').trim()));
      const nameInput = el('uf-codex-name-input');
      // User-typed name wins. Empty / whitespace falls back to the default,
      // auto-suffixed with " 2", " 3"… so two tokens never collide.
      let name = (nameInput && nameInput.value || '').trim() || cfg.defaultName;
      if (existingNames.has(name)) {
        let n = 2;
        const base = name;
        while (existingNames.has(name)) { name = `${base} ${n++}`; }
      }
      // Minimum scope on creation so the token isn't effectively saved
      // with everything granted before the user has clicked Save. The
      // UI toggles below are pre-checked as a preview of what *will*
      // be granted; nothing else is persisted server-side until Save.
      const fd = new FormData();
      fd.append('name', name);
      fd.append('scopes', 'chat');
      try {
        const r = await fetch('/api/tokens', { method: 'POST', credentials: 'same-origin', body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || 'Failed');
        if (_wp) { try { _wp.destroy(); } catch (_) {} }
        if (pending) pending.style.display = 'none';
        el('uf-codex-token').textContent = d.token || '';
        el('uf-codex-reveal').style.display = '';
        const setupBtn = el('uf-codex-copy-setup');
        if (setupBtn) setupBtn.dataset.token = d.token || '';
        const setupCode = el('uf-codex-setup-code');
        if (setupCode) setupCode.textContent = setupForToken(d.token || '');
        // Populate inline scope toggles for the just-created token with
        // ALL scopes pre-checked as a UI preview — the underlying token
        // still only has 'chat' until the user clicks Save below.
        const uiToken = { id: d.id, scopes: ['chat'].concat(toolScopes.map(s => s.key)) };
        const inlineEl = el('uf-codex-inline-scopes');
        if (inlineEl) {
          inlineEl.innerHTML = `
            <div class="uf-codex-token" data-token-id="${esc(uiToken.id)}">
              ${scopeToggles(uiToken)}
              <div class="uf-codex-scope-msg" data-token-id="${esc(uiToken.id)}" style="font-size:14px;min-height:14px;"></div>
            </div>`;
          // No auto-PATCH: scope toggles only persist on Save click below.
        }
        // Now that the token exists, surface the Save button.
        const saveBtn = el('uf-codex-save');
        if (saveBtn) saveBtn.style.display = 'inline-flex';
        // Remember the created token id so Save can PATCH its scopes.
        formEl.dataset.createdTokenId = String(uiToken.id);
        if (msg) {
          msg.textContent = `Created "${name}".`;
          msg.style.color = 'var(--green, #50fa7b)';
        }
        await renderList();
      } catch (err) {
        if (_wp) { try { _wp.destroy(); } catch (_) {} }
        if (pending) pending.style.display = 'none';
        if (msg) {
          msg.textContent = err?.message || 'Failed';
          msg.style.color = 'var(--red)';
        }
      }
    };
    // Bind the explicit Create button; no auto-creation.
    el('uf-codex-create-btn')?.addEventListener('click', () => { _autoCreateCodex(); });
    const _copyCodexToken = async (text) => {
      const value = String(text || '');
      if (!value) return false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch (_) {}
      }
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'readonly');
      ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:-1;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    };
    const _selectTextFallback = (text, containerId) => {
      const code = document.createElement('pre');
      code.textContent = text;
      code.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:14px;margin:6px 0 0;';
      el(containerId)?.appendChild(code);
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    el('uf-codex-copy-setup')?.addEventListener('click', async () => {
      const token = el('uf-codex-copy-setup')?.dataset.token || '';
      const btn = el('uf-codex-copy-setup');
      if (!token) return;
      const setup = setupForToken(token);
      const ok = await _copyCodexToken(setup);
      if (!btn) return;
      if (ok) {
        btn.innerHTML = CHECK_ICON;
        btn.style.color = 'var(--accent, var(--red))';
        btn.style.opacity = '1';
      } else {
        _selectTextFallback(setup, 'uf-codex-reveal');
      }
      setTimeout(() => {
        const latest = el('uf-codex-copy-setup');
        if (latest) { latest.innerHTML = COPY_ICON; latest.style.color = ''; latest.style.opacity = '0.7'; }
      }, 1600);
    });
    el('uf-codex-copy-token')?.addEventListener('click', async () => {
      const token = el('uf-codex-token')?.textContent || '';
      const ok = await _copyCodexToken(token);
      const btn = el('uf-codex-copy-token');
      if (!btn) return;
      if (ok) {
        btn.innerHTML = CHECK_ICON;
        btn.style.color = 'var(--accent, var(--red))';
        btn.style.opacity = '1';
      } else {
        _selectTextFallback(token, 'uf-codex-reveal');
      }
      setTimeout(() => {
        const latest = el('uf-codex-copy-token');
        if (latest) { latest.innerHTML = COPY_ICON; latest.style.color = ''; latest.style.opacity = '0.7'; }
      }, 1600);
    });
    function _wireScopeChange(scope) {
      scope.querySelectorAll('.uf-codex-scope').forEach(cb => {
        if (cb.dataset.wired === '1') return;
        cb.dataset.wired = '1';
        cb.addEventListener('change', async () => {
          const tokenId = cb.dataset.tokenId;
          const panel = formEl.querySelector(`.uf-codex-token[data-token-id="${CSS.escape(tokenId)}"]`);
          const msg = formEl.querySelector(`.uf-codex-scope-msg[data-token-id="${CSS.escape(tokenId)}"]`);
          const scopes = Array.from(panel.querySelectorAll('.uf-codex-scope:checked')).map(input => input.dataset.scope);
          try {
            const r = await fetch(`/api/tokens/${tokenId}`, {
              method: 'PATCH',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scopes }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.detail || 'Failed');
            if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; }
            await renderList();
          } catch (err) {
            cb.checked = !cb.checked;
            if (msg) { msg.textContent = err?.message || 'Failed'; msg.style.color = 'var(--red)'; }
          }
        });
      });
    }
    // Note: don't call _wireScopeChange(formEl) here. The existing-token
    // editor (current) already wires its own change handler that PATCHes
    // immediately. The inline scopes for a *just-created* token should
    // remain unwired so they only persist on Save click below.
  }

  // ── Add button now drops a type-picker menu directly anchored to itself ──
  if (addBtn) {
    const _typeOptions = [
      ['api', 'API Service'],
      ['mcp', 'MCP Tool Server'],
    ];
    const _iconFor = (k) => (INTG_TYPES[k]?.icon || '').replace(/width="14"/, 'width="16"').replace(/height="14"/, 'height="16"');
    const _rowsHtml = _typeOptions.map(([k, label]) => `<button type="button" class="uf-type-option" data-value="${k}" style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;background:transparent;border:0;color:var(--fg);font:inherit;cursor:pointer;text-align:left;"><span style="display:inline-flex;color:var(--accent, var(--red));flex-shrink:0;">${_iconFor(k)}</span><span>${esc(label)}</span></button>`).join('');

    // Anchor wrapper so the absolutely-positioned menu lands directly under
    // the add button. The button is the wrapper's only sibling.
    if (!addBtn.parentElement.classList.contains('uf-add-anchor')) {
      addBtn.parentElement.style.position = 'relative';
      addBtn.parentElement.classList.add('uf-add-anchor');
    }
    // Menu is created per open and removed on close. _closeMenu routes through
    // the bindMenuDismiss close() bound when the menu opens, so the outside-click
    // listener + Escape-stack entry are torn down alongside the node removal.
    let _menuEl = null;
    let _closeMenu = () => {};
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_menuEl) { _closeMenu(); return; }
      const menu = document.createElement('div');
      menu.className = 'uf-add-menu';
      menu.innerHTML = _rowsHtml;
      menu.style.cssText = 'position:absolute;right:0;z-index:1000;background:var(--panel);border:1px solid var(--border);border-radius:6px;max-height:340px;overflow-y:auto;box-shadow:0 6px 18px rgba(0,0,0,0.25);min-width:220px;';
      addBtn.parentElement.appendChild(menu);
      _menuEl = menu;
      // Drop-up when there isn't enough room below the button (modal near
      // the viewport bottom, mobile keyboard up, etc.).
      const tRect = addBtn.getBoundingClientRect();
      const mRect = menu.getBoundingClientRect();
      const below = window.innerHeight - tRect.bottom;
      const above = tRect.top;
      if (mRect.height > below && above > below) {
        menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 2px)';
      } else {
        menu.style.top = 'calc(100% + 2px)'; menu.style.bottom = 'auto';
      }
      menu.querySelectorAll('.uf-type-option').forEach(btn => {
        btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const k = btn.dataset.value;
          _closeMenu();
          formEl.style.display = '';
          showForm(k, 'new');
        });
      });
      _closeMenu = bindMenuDismiss(menu, () => { menu.remove(); _menuEl = null; }, (ev) => !menu.contains(ev.target) && ev.target !== addBtn);
    });
  }

  await renderList();
}

/* ── Admin visibility sync ── */
function syncAdminVisibility() {
  if (!modalEl) return;
  const isAdmin = !!window._isAdmin;
  modalEl.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
}

/* ═══════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════ */
export function open(tab) {
  if (!initialized) initAll();
  syncAppearanceCheckboxes();
  if (modalEl.classList.contains('hidden')) {
    resetWindowPlacement();
  }
  modalEl.classList.remove('hidden');
  syncAdminVisibility();
  const content = modalEl.querySelector('.settings-modal-content');
  if (tab) {
    modalEl.querySelectorAll('[data-settings-tab]').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tab));
    modalEl.querySelectorAll('[data-settings-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.settingsPanel !== tab));
  }
  // Narrow/page nav: an explicit tab deep-links into that panel; a plain
  // open() starts at the section list (CSS ignores this on wide layouts).
  _setPanelActive(!!tab);
  // Auto-init admin data if showing an admin tab
  const activeTab = tab || (modalEl.querySelector('[data-settings-tab].active') || {}).dataset?.settingsTab || 'services';
  document.body.classList.toggle('settings-appearance-open', activeTab === 'appearance');
  syncAppearanceOpacity(activeTab === 'appearance');
  if (activeTab === 'ai') refreshAiModelEndpoints();
  if (ADMIN_TABS.has(activeTab) && window.adminModule && !window.adminModule._initialized) {
    window.adminModule._initData();
  }
}

export function close() {
  if (!modalEl) return;
  // Always clear the appearance-tab body class so the rest of the app
  // doesn't keep its dimmed state if the modal got closed mid-tab.
  document.body.classList.remove('settings-appearance-open');
  syncAppearanceOpacity(false); // clear any opacity-slider fade
  const content = modalEl.querySelector('.modal-content, .settings-modal-content');
  if (content && !content.classList.contains('modal-closing')) {
    content.classList.add('modal-closing');
    content.addEventListener('animationend', () => {
      modalEl.classList.add('hidden');
      content.classList.remove('modal-closing');
    }, { once: true });
    setTimeout(() => { if (!modalEl.classList.contains('hidden')) { modalEl.classList.add('hidden'); content.classList.remove('modal-closing'); } }, 250);
  } else {
    modalEl.classList.add('hidden');
  }
}

const settingsModule = { open, close, initIntegrations, initUnifiedIntegrations, syncAdminVisibility, refreshAiModelEndpoints };


export default settingsModule;
