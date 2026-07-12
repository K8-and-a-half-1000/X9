/**
 * Improvement Queue page — plan skill / RAG / memory / test improvements
 * and run them one by one, top-down, through the deep-research pipeline.
 *
 * Server-state driven: the queue lives in /api/queue (so the model can add
 * items from chat too); this panel polls while open and renders cards in
 * queue order. Play on a card runs the queue from the top DOWN TO that card,
 * then pauses. Rendering reuses the research panel's card classes so the
 * page reads like Deep Research.
 */

let _open = false;
let _apiBase = '';
let _onDocKeydown = null;
let _pollTimer = null;
let _editingId = null;
let _state = { items: [], runner: { active: false, current_id: null, target_id: null, progress: {} } };

const _POLL_MS = 2500;

const _queueIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><polygon points="3,4 6,6 3,8" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/></svg>';
const _playIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
const _stopIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
const _cancelIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const _trashIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
const _pencilIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const _eyeIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const _eyeOffIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const _checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const _externalIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

const _TYPE_LABELS = { skill: 'Skill', rag: 'RAG', memory: 'Memory', test: 'Test' };

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function init(apiBase) {
  _apiBase = apiBase;
}

export function isOpen() { return _open; }

export function toggle() {
  if (_open) closePanel(); else openPanel();
}

export function openPanel() {
  if (_open) return;
  _open = true;

  document.body.classList.add('queue-panel-view');
  const btn = document.getElementById('tool-queue-btn');
  if (btn) btn.classList.add('active');

  const overlay = document.createElement('div');
  overlay.id = 'queue-overlay';
  overlay.className = 'modal queue-overlay';

  const pane = document.createElement('div');
  pane.id = 'queue-pane';
  pane.className = 'modal-content doclib-modal-content queue-pane';
  pane.style.cssText = (window.innerWidth <= 768)
    ? 'width:100vw;max-width:100vw;height:90dvh;max-height:90dvh;border-radius:14px 14px 0 0;background:var(--bg);'
    : 'width:min(640px, 92vw);max-height:85vh;background:var(--bg);';
  pane.innerHTML = _buildPanelHTML();

  overlay.appendChild(pane);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePanel();
  });
  _onDocKeydown = (e) => {
    if (e.key === 'Escape' && _open) { e.preventDefault(); closePanel(); }
  };
  document.addEventListener('keydown', _onDocKeydown);

  _wireEvents(pane);
  _refresh();
  _pollTimer = setInterval(_refresh, _POLL_MS);
}

export function closePanel() {
  if (!_open) return;
  _open = false;
  _editingId = null;

  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_onDocKeydown) {
    document.removeEventListener('keydown', _onDocKeydown);
    _onDocKeydown = null;
  }
  document.body.classList.remove('queue-panel-view');
  const btn = document.getElementById('tool-queue-btn');
  if (btn) btn.classList.remove('active');
  const overlay = document.getElementById('queue-overlay');
  if (overlay) overlay.remove();
}

function _buildPanelHTML() {
  return `
    <div class="modal-header queue-pane-header">
      <h4><span style="position:relative;top:-1px;left:6px;display:inline-flex;vertical-align:middle;">${_queueIcon}</span><span style="margin-left:6px;">Queue</span></h4>
      <div class="queue-pane-header-actions">
        <button id="queue-page-close" class="close-btn" title="Close">&#x2716;</button>
      </div>
    </div>
    <div class="modal-body queue-pane-body" data-no-swipe-dismiss>
      <div class="research-new-job queue-new-item">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">
          <h2 style="margin:0;padding:0;line-height:1;display:inline-flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent, var(--red))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Improvements <span id="queue-stats" class="memory-count"></span></h2>
        </div>
        <p class="memory-desc doclib-desc" style="margin-top:2px;">
          Plan skill, RAG, memory and test improvements — then run them top-down, one by one, like deep research. Tests become <code>test-</code> skills that prove a feature works.
        </p>
        <textarea id="queue-desc" class="research-query queue-desc-input" placeholder="What needs to improve? e.g. Add a test proving RAG answers cite their sources" rows="3"></textarea>
        <div class="queue-compose-row">
          <label class="research-setting queue-type-setting">
            <span class="research-setting-label">Type</span>
            <select id="queue-type">
              <option value="skill" selected>Skill</option>
              <option value="rag">RAG</option>
              <option value="memory">Memory</option>
              <option value="test">Test</option>
            </select>
          </label>
          <button id="queue-add-btn" class="research-add-btn"><span class="research-add-plus">+</span> Add to queue</button>
        </div>
        <div id="queue-error" class="queue-error" style="display:none;"></div>
      </div>
      <div id="queue-items-list" class="research-jobs-list queue-items-list" data-no-swipe-dismiss></div>
    </div>
  `;
}

function _wireEvents(pane) {
  pane.querySelector('#queue-page-close').addEventListener('click', closePanel);
  pane.querySelector('#queue-add-btn').addEventListener('click', _handleAdd);
  const descEl = pane.querySelector('#queue-desc');
  descEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      _handleAdd();
    }
  });
}

function _showError(msg) {
  const el = document.getElementById('queue-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = '';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

async function _api(method, path, body) {
  const res = await fetch(`${_apiBase}/api/queue${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

async function _refresh() {
  if (!_open) return;
  try {
    const data = await _api('GET', '');
    _state = data;
    _render();
  } catch {}
}

function _applyState(data) {
  if (data && data.items) { _state = data; _render(); }
  else _refresh();
}

async function _handleAdd() {
  const descEl = document.getElementById('queue-desc');
  const typeEl = document.getElementById('queue-type');
  const description = (descEl?.value || '').trim();
  if (!description) { descEl?.focus(); return; }
  try {
    const data = await _api('POST', '', { type: typeEl?.value || 'skill', description });
    descEl.value = '';
    descEl.focus();
    _applyState(data);
  } catch (e) {
    _showError(`Could not add: ${e.message}`);
  }
}

// ── rendering ──

function _render() {
  const container = document.getElementById('queue-items-list');
  if (!container) return;
  // Don't blow away an in-progress inline edit on a poll tick.
  if (_editingId && container.querySelector(`[data-item-id="${_editingId}"] .queue-edit-form`)) return;

  const items = _state.items || [];
  const stats = document.getElementById('queue-stats');
  if (stats) {
    const done = items.filter(i => i.status === 'done').length;
    stats.textContent = items.length
      ? `${done}/${items.length} done`
      : '';
  }

  container.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty memory-desc';
    empty.textContent = 'Nothing queued yet — describe an improvement above, or ask the model to queue one in chat.';
    container.appendChild(empty);
    return;
  }
  for (const item of items) container.appendChild(_buildCard(item));
}

function _formatPhase(progress) {
  if (!progress || !progress.phase) return 'Starting...';
  const p = progress;
  const rn = p.round ? `Round ${p.round}: ` : '';
  switch (p.phase) {
    case 'starting': return 'Starting...';
    case 'probing': return 'Probing model...';
    case 'planning': return 'Planning...';
    case 'searching': return `${rn}Searching (${p.queries || 0} queries)`;
    case 'reading': return `${rn}Reading ${p.total_sources || 0} sources`;
    case 'analyzing': return `${rn}Analyzing ${p.total_findings || 0} findings`;
    case 'writing': return `Writing report -- ${p.total_sources || 0} sources`;
    case 'action': return p.message || 'Applying improvement...';
    default: return p.phase;
  }}

function _confidenceChip(item) {
  if (item.type !== 'test' || item.confidence === null || item.confidence === undefined) return '';
  const n = Math.max(0, Math.min(100, item.confidence));
  const cls = n >= 70 ? 'queue-conf-high' : n >= 40 ? 'queue-conf-mid' : 'queue-conf-low';
  return `<span class="queue-conf-chip ${cls}" title="Test success confidence">${n}%</span>`;
}

function _buildCard(item) {
  const card = document.createElement('div');
  const runner = _state.runner || {};
  const isRunning = item.status === 'running';
  card.className = `research-job-card queue-card queue-${item.status}`;
  card.dataset.itemId = item.id;

  const typeBadge = `<span class="research-cat-badge queue-type-badge queue-type-${_esc(item.type)}">${_TYPE_LABELS[item.type] || _esc(item.type)}</span>`;
  const testSkill = (item.type === 'test' && item.test_skill)
    ? `<span class="queue-test-skill" title="Test skill">${_esc(item.test_skill)}</span>` : '';

  if (isRunning) {
    const phase = _formatPhase(runner.progress);
    const round = runner.progress?.round || 0;
    const pct = Math.min(100, Math.round((round / 8) * 100));
    card.innerHTML = `
      <div class="research-job-header">
        ${typeBadge}
        <span class="research-job-query">${_esc(item.description)}</span>
        <button class="research-job-cancel" data-action="stop" title="Pause the queue (this item goes back in line)">${_stopIcon}</button>
      </div>
      <div class="research-job-phase">${_esc(phase)}</div>
      <div class="research-progress-bar"><div class="research-progress-fill" style="width:${pct}%"></div></div>
    `;
    card.querySelector('[data-action="stop"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      try { _applyState(await _api('POST', '/stop')); } catch (err) { _showError(err.message); }
    });
    return card;
  }

  const doneMark = item.status === 'done'
    ? `<span class="queue-done-check" title="Completed">${_checkIcon}</span>` : '';
  const skipNote = item.status === 'skipped' ? '<span class="queue-skip-note">skipped</span>' : '';
  const errNote = item.status === 'error' && item.error
    ? `<div class="research-job-failnote">${_esc(item.error)}</div>` : '';
  const summary = item.status === 'done' && item.result_summary
    ? `<div class="queue-result-summary">${_esc(item.result_summary)}</div>` : '';

  const actions = [];
  const runnerActive = !!runner.active;
  if ((item.status === 'queued' || item.status === 'error') && !runnerActive) {
    const label = item.status === 'error' ? 'Retry' : 'Run to here';
    actions.push(`<button class="research-job-action" data-action="run" title="Run the queue from the top down to this item, then pause">${_playIcon} ${label}</button>`);
  }
  if (item.status !== 'done') {
    actions.push(`<button class="research-job-action" data-action="edit" title="Edit improvement">${_pencilIcon} Edit</button>`);
    const skipped = item.status === 'skipped';
    actions.push(`<button class="research-job-action${skipped ? ' active' : ''}" data-action="skip" title="${skipped ? 'Put back in the queue' : 'Skip this improvement'}">${skipped ? _eyeOffIcon : _eyeIcon}</button>`);
  }
  if (item.status === 'done' && item.research_session_id) {
    actions.push(`<button class="research-job-action research-job-action-report" data-action="report" title="Open the run's report">${_externalIcon} Report</button>`);
  }
  actions.push(`<button class="research-job-action research-job-action-dim" data-action="delete" title="Delete">${_trashIcon}</button>`);

  card.innerHTML = `
    <div class="research-job-header">
      ${typeBadge}
      <span class="research-job-query">${_esc(item.description)}</span>
      ${testSkill}${_confidenceChip(item)}${skipNote}${doneMark}
    </div>
    ${errNote}${summary}
    <div class="research-job-actions">${actions.join('')}</div>
  `;

  card.querySelector('[data-action="run"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { _applyState(await _api('POST', `/run/${item.id}`)); }
    catch (err) { _showError(`Could not start: ${err.message}`); }
  });
  card.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _startInlineEdit(card, item);
  });
  card.querySelector('[data-action="skip"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { _applyState(await _api('POST', `/${item.id}/skip`, { skipped: item.status !== 'skipped' })); }
    catch (err) { _showError(err.message); }
  });
  card.querySelector('[data-action="report"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.open(`${_apiBase}/api/research/report/${item.research_session_id}`, '_blank');
  });
  card.querySelector('[data-action="delete"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    card.style.opacity = '0';
    card.style.transform = 'translateX(-10px)';
    try {
      const data = await _api('DELETE', `/${item.id}`);
      setTimeout(() => _applyState(data), 300);
    } catch (err) {
      card.style.opacity = '';
      card.style.transform = '';
      _showError(err.message);
    }
  });
  return card;
}

function _startInlineEdit(card, item) {
  _editingId = item.id;
  const typeOpts = Object.entries(_TYPE_LABELS).map(([v, label]) =>
    `<option value="${v}"${v === item.type ? ' selected' : ''}>${label}</option>`).join('');
  card.innerHTML = `
    <div class="queue-edit-form">
      <textarea class="research-query queue-edit-desc" rows="3">${_esc(item.description)}</textarea>
      <div class="queue-compose-row">
        <label class="research-setting queue-type-setting">
          <span class="research-setting-label">Type</span>
          <select class="queue-edit-type">${typeOpts}</select>
        </label>
        <button class="research-job-action" data-action="save">${_checkIcon} Save</button>
        <button class="research-job-action research-job-action-dim" data-action="cancel">${_cancelIcon} Cancel</button>
      </div>
    </div>
  `;
  const ta = card.querySelector('.queue-edit-desc');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  card.querySelector('[data-action="save"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    const description = ta.value.trim();
    const type = card.querySelector('.queue-edit-type').value;
    if (!description) { ta.focus(); return; }
    try {
      const data = await _api('PATCH', `/${item.id}`, { description, type });
      _editingId = null;
      _applyState(data);
    } catch (err) {
      _showError(`Could not save: ${err.message}`);
    }
  });
  card.querySelector('[data-action="cancel"]').addEventListener('click', (e) => {
    e.stopPropagation();
    _editingId = null;
    _render();
  });
}

export default { init, toggle, openPanel, closePanel, isOpen };
