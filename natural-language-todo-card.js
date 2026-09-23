/*
 * Natural Language To-do Card for Home Assistant
 * https://github.com/joshmd/natural-language-Todo
 * ----------------------------------------------
 * A to-do list card with sections, natural-language quick add, a collapsible
 * add bar that closes after a period of no typing, optional completed items
 * and per-section hiding. Version 1 reads Todoist through the bridge package.
 *
 * Data comes from the todoist_bridge package (REST sensors + scripts against
 * the Todoist API v1). The card never holds your API token.
 *
 * No build step, no dependencies. Drop into /config/www and register as a
 * dashboard resource (type: JavaScript module).
 */

const CARD_VERSION = '0.1.0';

const DEFAULTS = {
  title: '',
  project_id: '',
  tasks_entity: 'sensor.todoist_tasks',
  sections_entity: 'sensor.todoist_sections',
  completed_entity: 'sensor.todoist_completed',
  add_script: 'script.todoist_bridge_add',
  done_script: 'script.todoist_bridge_set_done',
  show_completed: false,
  completed_limit: 10,
  completed_collapsed: true,
  hide_sections: [],
  collapsed_sections: [],
  hide_empty_sections: true,
  show_unsectioned: true,
  unsectioned_title: '',
  due_display: 'all', // all | soon | none
  add_timeout: 20, // seconds of no typing before the add bar closes; 0 = never
  show_count: true,
  count_suffix: 'open',
  show_hint: true,
  accent: null,
};

const DUE_DISPLAY = ['all', 'soon', 'none'];
const COMPLETED_KEY = '__completed';
const UNSECTIONED_KEY = '__none';

const ICON_PLUS =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_CHECK =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const ICON_TICK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const ICON_CHEV =
  '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const lower = (v) => String(v ?? '').toLowerCase();

const STYLES = `
  :host { --tsc-accent: var(--tsc-accent-override, var(--accent-color, #ff9800)); --tsc-field: rgba(0, 0, 0, 0.15); }
  ha-card { padding: 16px 16px 8px; }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--tsc-accent); outline-offset: 2px; border-radius: 8px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  .head { display: flex; align-items: center; gap: 8px; min-height: 44px; }
  .title { margin: 0; flex: 1; font-size: var(--ha-card-header-font-size, 24px); font-weight: 400; line-height: 1.3;
           color: var(--ha-card-header-color, var(--primary-text-color)); }
  .count { font-size: 13px; color: var(--secondary-text-color); }
  .toggle { width: 44px; height: 44px; margin-right: -8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .dot { width: 32px; height: 32px; border-radius: 50%; background: var(--tsc-accent); display: flex; align-items: center; justify-content: center; transition: background 0.15s; }
  .dot svg { stroke: var(--text-accent-color, #fff); transition: transform 0.2s; }
  .toggle[aria-expanded="true"] .dot { background: rgba(127, 127, 127, 0.3); }
  .toggle[aria-expanded="true"] .dot svg { stroke: var(--primary-text-color); transform: rotate(45deg); }

  .adder { padding-top: 8px; }
  .field { display: flex; align-items: center; gap: 4px; height: 52px; padding: 0 4px 0 16px; border-radius: 14px; background: var(--tsc-field); }
  .field input { flex: 1; min-width: 0; height: 100%; background: transparent; border: 0; outline: none; color: var(--primary-text-color); font-family: inherit; font-size: 16px; }
  .field input::placeholder { color: var(--secondary-text-color); }
  .save { width: 44px; height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .save svg { stroke: var(--secondary-text-color); }
  .save.ready svg { stroke: var(--tsc-accent); }
  .hint, .preview { font-size: 12px; color: var(--secondary-text-color); padding: 8px 4px 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--tsc-field); color: var(--primary-text-color); }
  .chip.warn { background: color-mix(in srgb, var(--warning-color, #ff9800) 20%, transparent); }
  .toast { font-size: 13px; padding: 8px 4px 0; color: var(--secondary-text-color); }
  .toast.err { color: var(--error-color, #db4437); }
  [hidden] { display: none !important; }

  .list { padding-top: 4px; }
  ul { list-style: none; margin: 0; padding: 0; }
  .sec { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 10px 4px 4px; margin-top: 6px;
         border-top: 1px solid var(--divider-color); color: var(--secondary-text-color); text-align: left; }
  .sec-name { flex: 1; font-size: 13px; font-weight: 500; }
  .pill { font-size: 12px; min-width: 20px; padding: 1px 7px; border-radius: 999px; background: var(--tsc-field); color: var(--primary-text-color); text-align: center; }
  .chev { transition: transform 0.15s; }
  .sec[aria-expanded="false"] .chev { transform: rotate(-90deg); }

  .item { display: flex; align-items: center; gap: 6px; min-height: 44px; }
  .box { width: 44px; height: 44px; margin-left: -8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .tick { width: 22px; height: 22px; box-sizing: border-box; border: 2px solid var(--secondary-text-color); border-radius: 6px; display: flex; align-items: center; justify-content: center; }
  .tick svg { visibility: hidden; }
  .item.done .tick { background: var(--tsc-accent); border-color: var(--tsc-accent); }
  .item.done .tick svg { visibility: visible; }
  .text { flex: 1; font-size: 16px; color: var(--primary-text-color); word-break: break-word; }
  .item.done .text { text-decoration: line-through; color: var(--secondary-text-color); }
  .item.busy { opacity: 0.55; }
  .due { font-size: 12px; padding: 3px 8px; border-radius: 999px; white-space: nowrap; background: var(--tsc-field); color: var(--primary-text-color); }
  .due.today { background: color-mix(in srgb, var(--tsc-accent) 24%, transparent); }
  .due.overdue { background: color-mix(in srgb, var(--error-color, #db4437) 30%, transparent); }
  .meta { font-size: 12px; color: var(--secondary-text-color); }
  .empty { padding: 12px 4px; font-size: 14px; color: var(--secondary-text-color); }

  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

class NaturalLanguageTodoCard extends HTMLElement {
  static getStubConfig() {
    return { title: 'Shopping', project_id: '' };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._pending = new Map(); // task id -> { done, recurring, resolved, at, task }
    this._pendingAdds = []; // { id, content, section_id }
    this._draft = '';
    this._timer = null;
    this._toastTimer = null;
    this._built = false;
    this._sig = '';
  }

  // ---------------------------------------------------------------- config

  setConfig(config) {
    if (!config || !config.project_id) {
      throw new Error('natural-language-todo-card: project_id is required');
    }
    const c = { ...DEFAULTS, ...config };
    for (const key of ['hide_sections', 'collapsed_sections']) {
      if (!Array.isArray(c[key])) throw new Error(`natural-language-todo-card: ${key} must be a list`);
    }
    if (!DUE_DISPLAY.includes(c.due_display)) {
      throw new Error(`natural-language-todo-card: due_display must be one of ${DUE_DISPLAY.join(', ')}`);
    }
    c.project_id = String(c.project_id);
    c.add_timeout = Math.max(0, Number(c.add_timeout) || 0);
    c.completed_limit = Math.max(1, Number(c.completed_limit) || DEFAULTS.completed_limit);
    this._config = c;
    this._storeKey = `natural-language-todo-card:${c.project_id}`;
    this._collapsed = this._loadCollapsed();
    this._built = false;
    this._sig = '';
    if (this._hass) this.hass = this._hass;
  }

  getCardSize() {
    return 3;
  }

  // ------------------------------------------------------------------ hass

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (!this._built) this._build();
    const sig = [this._config.tasks_entity, this._config.sections_entity, this._config.completed_entity]
      .map((id) => hass.states[id]?.last_updated ?? 'x')
      .join('|');
    if (sig !== this._sig) {
      this._sig = sig;
      this._renderList();
    }
  }

  // ----------------------------------------------------------------- shell

  _build() {
    const c = this._config;
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div class="head">
          <h2 class="title">${esc(c.title)}</h2>
          <span class="count"></span>
          <button class="toggle" type="button" aria-label="Add item" aria-expanded="false">
            <span class="dot">${ICON_PLUS}</span>
          </button>
        </div>
        <div class="adder" hidden>
          <div class="field">
            <label class="sr" for="tsc-input">Add item</label>
            <input id="tsc-input" type="text" autocomplete="off" enterkeyhint="done" placeholder="Add item">
            <button class="save" type="button" aria-label="Save item">${ICON_CHECK}</button>
          </div>
          <div class="hint"></div>
          <div class="preview" hidden></div>
        </div>
        <div class="toast" role="status" aria-live="polite" hidden></div>
        <div class="list"></div>
      </ha-card>`;

    const $ = (sel) => this.shadowRoot.querySelector(sel);
    this._$title = $('.title');
    this._$count = $('.count');
    this._$toggle = $('.toggle');
    this._$adder = $('.adder');
    this._$input = $('#tsc-input');
    this._$save = $('.save');
    this._$hint = $('.hint');
    this._$preview = $('.preview');
    this._$toast = $('.toast');
    this._$list = $('.list');

    this._$title.hidden = !c.title;
    this._$hint.hidden = !c.show_hint;
    if (c.accent) this.style.setProperty('--tsc-accent-override', c.accent);
    else this.style.removeProperty('--tsc-accent-override');

    this._$toggle.addEventListener('click', () => (this._isOpen() ? this._close(true) : this._open()));
    this._$save.addEventListener('click', () => this._add());
    this._$input.addEventListener('input', () => {
      this._armTimer();
      this._updatePreview();
    });
    this._$input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._add();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._close(true);
      } else {
        this._armTimer();
      }
    });
    this._$list.addEventListener('click', (e) => this._onListClick(e));

    this._built = true;
  }

  // -------------------------------------------------------------- add bar

  _isOpen() {
    return !this._$adder.hidden;
  }

  _open() {
    this._$adder.hidden = false;
    this._$toggle.setAttribute('aria-expanded', 'true');
    this._$toggle.setAttribute('aria-label', 'Close add item');
    this._$input.value = this._draft;
    this._updatePreview();
    this._armTimer();
    requestAnimationFrame(() => this._$input.focus());
  }

  // clear = true discards the draft (× or Escape). A timeout keeps it, so a
  // half-typed item is still there next time the bar opens.
  _close(clear) {
    clearTimeout(this._timer);
    this._draft = clear ? '' : this._$input.value;
    this._$input.value = '';
    this._$adder.hidden = true;
    this._$toggle.setAttribute('aria-expanded', 'false');
    this._$toggle.setAttribute('aria-label', 'Add item');
    this._$input.blur();
  }

  _armTimer() {
    clearTimeout(this._timer);
    const secs = this._config.add_timeout;
    if (secs > 0) this._timer = setTimeout(() => this._close(false), secs * 1000);
  }

  // Finds "/Section Name" against this project's visible sections, longest
  // name first so multi-word names work ("/Kitchen stuff" beats "/Kitchen").
  _extractSection(raw, sections) {
    const byLength = [...sections].sort((a, b) => b.name.length - a.name.length);
    const re = /(^|\s)\/(?=\S)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const slash = m.index + m[1].length;
      const rest = raw.slice(slash + 1);
      for (const s of byLength) {
        const n = s.name;
        const next = rest.charAt(n.length);
        if (lower(rest.slice(0, n.length)) === lower(n) && (next === '' || /\s/.test(next))) {
          return { section: s, text: (raw.slice(0, slash) + rest.slice(n.length)).replace(/\s+/g, ' ').trim() };
        }
      }
      const token = rest.split(/\s/)[0];
      return {
        section: null,
        unmatched: token,
        text: (raw.slice(0, slash) + rest.slice(token.length)).replace(/\s+/g, ' ').trim(),
      };
    }
    return { section: null, text: raw.trim() };
  }

  _updatePreview() {
    const raw = this._$input.value;
    const hasText = raw.trim().length > 0;
    this._$save.classList.toggle('ready', hasText);
    this._$hint.hidden = !this._config.show_hint || hasText;
    if (!hasText) {
      this._$preview.hidden = true;
      return;
    }
    const { section, unmatched } = this._extractSection(raw, this._visibleSections());
    if (section) {
      this._$preview.innerHTML = `Adds to <span class="chip">${esc(section.name)}</span>`;
    } else if (unmatched) {
      this._$preview.innerHTML = `<span class="chip warn">No section called ${esc(unmatched)}. Adds without a section.</span>`;
    } else {
      this._$preview.innerHTML = '';
    }
    this._$preview.hidden = !section && !unmatched;
  }

  async _add() {
    const raw = this._$input.value;
    if (!raw.trim()) return;
    const { section, text } = this._extractSection(raw, this._visibleSections());
    if (!text) {
      this._toast('Type an item name as well as the section.', true);
      return;
    }
    const c = this._config;
    const temp = { id: `tmp-${Date.now()}-${Math.random()}`, content: text, section_id: section ? section.id : null };
    this._pendingAdds.push(temp);
    this._$input.value = '';
    this._draft = '';
    this._updatePreview();
    this._armTimer();
    this._renderList(true);

    const [domain, service] = c.add_script.split('.');
    try {
      const res = await this._hass.connection.sendMessagePromise({
        type: 'call_service',
        domain,
        service,
        service_data: { text, project_id: c.project_id, section_id: section ? String(section.id) : '' },
        return_response: true,
      });
      const r = res?.response || {};
      let msg = `Added ${r.content || text}`;
      if (section) msg += ` to ${section.name}`;
      if (r.due) msg += `, due ${r.due}`;
      if (r.moved === false) msg += '. It could not be moved into this list, check Todoist.';
      this._toast(msg, r.moved === false);
    } catch (err) {
      if (!this._$input.value) this._$input.value = raw;
      this._updatePreview();
      this._toast(`Could not add ${text}: ${err?.message || 'Todoist request failed'}`, true);
    } finally {
      setTimeout(() => {
        this._pendingAdds = this._pendingAdds.filter((p) => p.id !== temp.id);
        this._renderList(true);
      }, 1500);
    }
  }

  _toast(msg, isError = false) {
    clearTimeout(this._toastTimer);
    this._$toast.textContent = msg;
    this._$toast.classList.toggle('err', isError);
    this._$toast.hidden = false;
    this._toastTimer = setTimeout(() => (this._$toast.hidden = true), isError ? 8000 : 4000);
  }

  // ------------------------------------------------------------------ data

  _attr(entityId, key) {
    const st = entityId ? this._hass.states[entityId] : undefined;
    const v = st?.attributes?.[key];
    return Array.isArray(v) ? v : null;
  }

  _hiddenSet() {
    return new Set(this._config.hide_sections.map((x) => lower(x)));
  }

  _projectSections() {
    const all = this._attr(this._config.sections_entity, 'results') || [];
    const order = (s) => s.section_order ?? s.order ?? 0;
    return all
      .filter((s) => String(s.project_id) === this._config.project_id && !s.is_archived && !s.is_deleted)
      .sort((a, b) => order(a) - order(b));
  }

  _visibleSections() {
    const hidden = this._hiddenSet();
    return this._projectSections().filter((s) => !hidden.has(lower(s.id)) && !hidden.has(lower(s.name)));
  }

  _data() {
    const c = this._config;
    const tasksRaw = this._attr(c.tasks_entity, 'results');
    if (!tasksRaw) {
      return { error: `${c.tasks_entity} is missing or has no task data. Check the todoist_bridge package is loaded.` };
    }

    const all = this._projectSections();
    const visible = this._visibleSections();
    const visibleIds = new Set(visible.map((s) => String(s.id)));
    const knownIds = new Set(all.map((s) => String(s.id)));
    // Hidden = in a section this card hides. Tasks in a section the sections
    // sensor does not know yet fall back to "no section" rather than vanish.
    const inHiddenSection = (t) => t.section_id && knownIds.has(String(t.section_id)) && !visibleIds.has(String(t.section_id));
    const sectionKey = (t) => (t.section_id && visibleIds.has(String(t.section_id)) ? String(t.section_id) : UNSECTIONED_KEY);

    const tasks = tasksRaw.filter((t) => String(t.project_id) === c.project_id && !inHiddenSection(t));
    const taskIds = new Set(tasks.map((t) => String(t.id)));

    const completedRaw = c.show_completed
      ? (this._attr(c.completed_entity, 'items') || this._attr(c.completed_entity, 'results') || [])
      : [];
    const completed = completedRaw
      .map((t) => ({ ...t, id: String(t.id ?? t.task_id) }))
      .filter((t) => String(t.project_id) === c.project_id && !inHiddenSection(t));

    // Expire optimistic state once the sensor has moved on, or after 60 s.
    const now = Date.now();
    const tasksUpdated = this._hass.states[c.tasks_entity]?.last_updated;
    for (const [id, p] of this._pending) {
      if (now - p.at > 60000 || (p.resolved && p.recurring) || (p.resolved && p.resolvedAt !== tasksUpdated)) {
        this._pending.delete(id);
      }
    }

    const open = [];
    const done = [];
    for (const t of tasks) {
      const p = this._pending.get(String(t.id));
      if (p && p.done && !p.recurring) done.push({ ...t, _busy: !p.resolved, _done: true });
      else open.push({ ...t, _busy: !!p && !p.resolved });
    }
    for (const t of completed) {
      const p = this._pending.get(t.id);
      if (p && !p.done) {
        if (!taskIds.has(t.id)) open.push({ ...t, _busy: !p.resolved });
      } else if (!taskIds.has(t.id)) {
        done.push({ ...t, _done: true });
      }
    }
    for (const t of this._pendingAdds) open.push({ ...t, _busy: true, _temp: true });

    const byOrder = (a, b) => (a.child_order ?? 1e9) - (b.child_order ?? 1e9);
    const groups = [];
    if (c.show_unsectioned) {
      const items = open.filter((t) => sectionKey(t) === UNSECTIONED_KEY).sort(byOrder);
      if (items.length || (c.unsectioned_title && !c.hide_empty_sections)) {
        const header = !!c.unsectioned_title;
        groups.push({ key: UNSECTIONED_KEY, name: c.unsectioned_title, header, items, collapsed: header && this._isCollapsed(UNSECTIONED_KEY) });
      }
    }
    for (const s of visible) {
      const key = String(s.id);
      const items = open.filter((t) => sectionKey(t) === key).sort(byOrder);
      if (!items.length && c.hide_empty_sections) continue;
      groups.push({ key, name: s.name, header: true, items, collapsed: this._isCollapsed(key, s.name) });
    }

    const doneSorted = done
      .sort((a, b) => (b._busy ? 1 : 0) - (a._busy ? 1 : 0) || String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')))
      .slice(0, c.completed_limit);

    const sectionName = new Map(all.map((s) => [String(s.id), s.name]));
    const openCount = groups.reduce((n, g) => n + g.items.length, 0);
    return { groups, done: doneSorted, openCount, sectionName, firstSection: visible[0]?.name };
  }

  _isCollapsed(key, name) {
    if (Object.prototype.hasOwnProperty.call(this._collapsed, key)) return this._collapsed[key];
    if (key === COMPLETED_KEY) return !!this._config.completed_collapsed;
    const initial = this._config.collapsed_sections.map((x) => lower(x));
    return initial.includes(lower(key)) || (name !== undefined && initial.includes(lower(name)));
  }

  _loadCollapsed() {
    try {
      return JSON.parse(localStorage.getItem(this._storeKey) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  _saveCollapsed() {
    try {
      localStorage.setItem(this._storeKey, JSON.stringify(this._collapsed));
    } catch (e) {
      /* storage unavailable: collapse state just won't persist */
    }
  }

  // ---------------------------------------------------------------- due

  // Todoist API v1 puts either "YYYY-MM-DD" or a datetime in due.date.
  _due(t) {
    const mode = this._config.due_display;
    const d = t.due;
    if (!d || mode === 'none') return null;
    const raw = d.datetime || d.date;
    if (!raw) return null;
    const hasTime = raw.length > 10;
    let when;
    if (hasTime) {
      when = new Date(raw); // ISO with Z = UTC; without offset = local (floating)
    } else {
      const [y, m, day] = raw.split('-').map(Number);
      when = new Date(y, m - 1, day);
    }
    if (isNaN(when)) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thatDay = new Date(when);
    thatDay.setHours(0, 0, 0, 0);
    const diff = Math.round((thatDay - today) / 86400000);
    const locale = this._locale();
    const time = hasTime ? when.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '';

    let kind = 'future';
    if (diff < 0 || (diff === 0 && hasTime && when < new Date())) kind = 'overdue';
    else if (diff === 0) kind = 'today';
    if (mode === 'soon' && !(kind !== 'future' || diff === 1)) return null;

    let label;
    if (diff === -1) label = 'Yesterday';
    else if (diff === 0) label = 'Today';
    else if (diff === 1) label = 'Tomorrow';
    else if (diff > 1 && diff < 7) label = when.toLocaleDateString(locale, { weekday: 'short' });
    else label = when.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    return { label: time ? `${label} ${time}` : label, kind };
  }

  // Follow the user's Home Assistant language, falling back to the browser's.
  _locale() {
    const lang = this._hass?.locale?.language || this._hass?.language;
    try {
      return lang ? Intl.DateTimeFormat.supportedLocalesOf(lang)[0] || undefined : undefined;
    } catch (e) {
      return undefined;
    }
  }

  // --------------------------------------------------------------- render

  _itemHtml(t, sectionName, showSection) {
    const done = !!t._done;
    const cls = ['item', done ? 'done' : '', t._busy ? 'busy' : ''].join(' ');
    const label = done ? `Mark ${t.content} as not done` : `Complete ${t.content}`;
    const due = done ? null : this._due(t);
    const dueHtml = due ? `<span class="due ${due.kind}">${esc(due.label)}</span>` : '';
    const secHtml = showSection && t.section_id && sectionName.get(String(t.section_id))
      ? `<span class="meta">${esc(sectionName.get(String(t.section_id)))}</span>`
      : '';
    const box = t._temp
      ? `<span class="box"><span class="tick"></span></span>`
      : `<button class="box" type="button" data-action="toggle" data-id="${esc(t.id)}" data-done="${done}" data-recurring="${!!t.due?.is_recurring}" aria-label="${esc(label)}"><span class="tick">${ICON_TICK}</span></button>`;
    return `<li class="${cls}">${box}<span class="text">${esc(t.content)}</span>${dueHtml}${secHtml}</li>`;
  }

  _renderList(force) {
    if (!this._built || !this._hass) return;
    if (force) this._sig = '';
    const c = this._config;
    const d = this._data();

    if (d.error) {
      this._$count.textContent = '';
      this._$list.innerHTML = `<div class="empty">${esc(d.error)}</div>`;
      return;
    }

    this._$count.textContent = c.show_count ? `${d.openCount} ${c.count_suffix}` : '';
    this._$hint.textContent = d.firstSection ? `Try: milk tomorrow /${d.firstSection}` : 'Try: milk tomorrow 5pm';

    // Remember keyboard focus so re-rendering doesn't throw it away.
    const active = this.shadowRoot.activeElement;
    const focusKey = active?.dataset?.action ? `${active.dataset.action}:${active.dataset.id ?? active.dataset.key}` : null;

    let html = '';
    for (const g of d.groups) {
      html += '<div class="group">';
      if (g.header) {
        html += `<button class="sec" type="button" data-action="collapse" data-key="${esc(g.key)}" aria-expanded="${!g.collapsed}">
          <span class="sec-name">${esc(g.name)}</span><span class="pill">${g.items.length}</span>${ICON_CHEV}</button>`;
      }
      if (!g.collapsed) html += `<ul>${g.items.map((t) => this._itemHtml(t, d.sectionName, false)).join('')}</ul>`;
      html += '</div>';
    }

    if (c.show_completed && d.done.length) {
      const collapsed = this._isCollapsed(COMPLETED_KEY);
      html += `<div class="group"><button class="sec" type="button" data-action="collapse" data-key="${COMPLETED_KEY}" aria-expanded="${!collapsed}">
        <span class="sec-name">Completed</span><span class="pill">${d.done.length}</span>${ICON_CHEV}</button>`;
      if (!collapsed) html += `<ul>${d.done.map((t) => this._itemHtml(t, d.sectionName, true)).join('')}</ul>`;
      html += '</div>';
    }

    if (!d.groups.length && !(c.show_completed && d.done.length)) {
      html = '<div class="empty">Nothing on this list. Tap + to add an item.</div>';
    }

    this._$list.innerHTML = html;

    if (focusKey) {
      const [action, id] = focusKey.split(':');
      const attr = action === 'collapse' ? 'data-key' : 'data-id';
      this._$list.querySelector(`[data-action="${action}"][${attr}="${CSS.escape(id)}"]`)?.focus();
    }
  }

  // --------------------------------------------------------------- events

  _onListClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'collapse') {
      const key = el.dataset.key;
      this._collapsed[key] = !this._isCollapsed(key, el.querySelector('.sec-name')?.textContent);
      this._saveCollapsed();
      this._renderList(true);
    } else if (el.dataset.action === 'toggle') {
      this._toggleTask(el.dataset.id, el.dataset.done !== 'true', el.dataset.recurring === 'true');
    }
  }

  async _toggleTask(id, done, recurring) {
    if (this._pending.has(id)) return;
    const entry = { done, recurring: done && recurring, resolved: false, at: Date.now() };
    this._pending.set(id, entry);
    this._renderList(true);
    const [domain, service] = this._config.done_script.split('.');
    try {
      await this._hass.callService(domain, service, { task_id: id, done });
      entry.resolved = true;
      entry.resolvedAt = this._hass.states[this._config.tasks_entity]?.last_updated;
    } catch (err) {
      this._pending.delete(id);
      this._toast(`Could not update the item: ${err?.message || 'Todoist request failed'}`, true);
    }
    this._renderList(true);
  }

  disconnectedCallback() {
    clearTimeout(this._timer);
    clearTimeout(this._toastTimer);
  }
}

if (!customElements.get('natural-language-todo-card')) {
  customElements.define('natural-language-todo-card', NaturalLanguageTodoCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'natural-language-todo-card',
    name: 'Natural Language To-do Card',
    description: 'To-do list with sections, natural-language quick add and optional completed items.',
    documentationURL: 'https://github.com/joshmd/natural-language-Todo',
  });
  console.info(`%c NATURAL-LANGUAGE-TODO-CARD %c v${CARD_VERSION} `, 'background:#e0585f;color:#fff', 'background:#444;color:#fff');
}

// Earlier name, kept so dashboards using custom:todoist-sections-card keep working.
if (!customElements.get('todoist-sections-card')) {
  customElements.define('todoist-sections-card', class extends NaturalLanguageTodoCard {});
}
