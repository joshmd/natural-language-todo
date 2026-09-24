/*
 * Natural Language To-do Card for Home Assistant
 * https://github.com/joshmd/natural-language-Todo
 * ----------------------------------------------
 * A to-do list card with sections, natural-language quick add, a collapsible
 * add bar that closes after a period of no typing, optional completed items
 * and per-section hiding.
 *
 * Data sources:
 *   todo            Any Home Assistant to-do list (todo.* entities). Several
 *                   lists can be shown as sections of one card. Lists from the
 *                   core Todoist integration add through todoist.new_task, so
 *                   Todoist parses dates, recurrence, labels and priority.
 *   todoist_bridge  The YAML bridge package (REST sensors + scripts against the
 *                   Todoist API v1) for real Todoist sections.
 *
 * The card never holds an API token. No build step, no dependencies.
 */

const CARD_VERSION = '0.2.0';

const DEFAULTS = {
  title: '',
  // todo source
  entity: '',
  entities: [],
  todoist_project: '',
  parse_dates: true,
  // todoist_bridge source
  project_id: '',
  tasks_entity: 'sensor.todoist_tasks',
  sections_entity: 'sensor.todoist_sections',
  completed_entity: 'sensor.todoist_completed',
  add_script: 'script.todoist_bridge_add',
  done_script: 'script.todoist_bridge_set_done',
  // shared
  source: 'auto', // auto | todo | todoist_bridge
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

const SOURCES = ['auto', 'todo', 'todoist_bridge'];
const DUE_DISPLAY = ['all', 'soon', 'none'];
const COMPLETED_KEY = '__completed';
const UNSECTIONED_KEY = '__none';

// TodoListEntityFeature bits.
const FEATURE_CREATE = 1;
const FEATURE_UPDATE = 4;
const FEATURE_DUE_DATE = 16;
const FEATURE_DUE_DATETIME = 32;

const PENDING_ADD_TIMEOUT = 90000;
const PENDING_TOGGLE_TIMEOUT = 60000;
const POLL_INTERVAL = 30000;

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const lower = (v) => String(v ?? '').toLowerCase();

// =============================================================================
// Input parser
// -----------------------------------------------------------------------------
// Pure functions, exported for tests. Splits what the user typed into the item
// text plus a section, due date/time, recurrence, labels and priority. Each
// part is only parsed when the target list can store it; anything else stays
// in the item text. "Quoted text" is never parsed.
// =============================================================================

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const WEEKDAYS_SHORT = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};
const COUNT_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const alt = (obj) => Object.keys(obj).sort((a, b) => b.length - a.length).join('|');
const P_WEEKDAY = alt(WEEKDAYS);
const P_WEEKDAY_SHORT = alt(WEEKDAYS_SHORT);
const P_MONTH = alt(MONTHS);
const P_COUNT = `\\d{1,3}|${alt(COUNT_WORDS)}`;
const P_TIME = '(?:at\\s+)?(?:\\d{1,2}(?::[0-5]\\d)?\\s*(?:am|pm)|(?:[01]?\\d|2[0-3]):[0-5]\\d|noon|midday)';
const END = '(?=$|\\s|[,.;!?])';
// Ambiguous forms ("sun", "25/12") only count at the very end, optionally
// followed by a time, so "sun cream" and "flour 1/2 kg" stay as typed.
const AT_END = `(?=\\s*(?:${P_TIME})?\\s*$)`;

const QUOTE_OPEN = '';
const QUOTE_CLOSE = '';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function validDate(y, m, d) {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? dt : null;
}

// Day and month without a year: the next time that date comes round.
function upcoming(now, m, d) {
  const today = startOfDay(now);
  const y = now.getFullYear();
  const thisYear = validDate(y, m, d);
  if (thisYear && thisYear >= today) return thisYear;
  return validDate(y + 1, m, d);
}

function weekdayFrom(now, target) {
  const today = startOfDay(now);
  return addDays(today, (target - today.getDay() + 7) % 7);
}

// "next friday" = that weekday in next week (weeks start on Monday).
function weekdayNextWeek(now, target) {
  const today = startOfDay(now);
  const mondayOffset = (today.getDay() + 6) % 7;
  const nextMonday = addDays(today, 7 - mondayOffset);
  return addDays(nextMonday, (target + 6) % 7);
}

function countOf(word) {
  const w = lower(word);
  return COUNT_WORDS[w] ?? Number(w);
}

function dateMatchers(dayFirst) {
  const w = (p) => new RegExp(`(^|\\s)((?:on\\s+)?(?:${p}))${END}`, 'i');
  const wEnd = (p) => new RegExp(`(^|\\s)((?:on\\s+)?(?:${p}))${AT_END}`, 'i');
  return [
    { re: w('(\\d{4})-(\\d{2})-(\\d{2})'), fn: (m) => validDate(+m[3], +m[4] - 1, +m[5]) },
    {
      re: wEnd('(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?'),
      fn: (m, now) => {
        const [a, b] = [+m[3], +m[4]];
        const [d, mo] = dayFirst ? [a, b] : [b, a];
        if (!m[5]) return upcoming(now, mo - 1, d);
        const y = m[5].length === 2 ? 2000 + +m[5] : +m[5];
        return validDate(y, mo - 1, d);
      },
    },
    {
      re: w(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${P_MONTH})(?:\\s+(\\d{4}))?`),
      fn: (m, now) => {
        const mo = MONTHS[lower(m[4])];
        return m[5] ? validDate(+m[5], mo, +m[3]) : upcoming(now, mo, +m[3]);
      },
    },
    {
      re: w(`(${P_MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`),
      fn: (m, now) => {
        const mo = MONTHS[lower(m[3])];
        return m[5] ? validDate(+m[5], mo, +m[4]) : upcoming(now, mo, +m[4]);
      },
    },
    { re: w('today|tonight'), fn: (m, now) => startOfDay(now) },
    { re: w('tomorrow|tmrw|tmr'), fn: (m, now) => addDays(startOfDay(now), 1) },
    { re: w('next\\s+week'), fn: (m, now) => weekdayNextWeek(now, 1) },
    { re: w('(?:this\\s+)?weekend'), fn: (m, now) => weekdayFrom(now, 6) },
    {
      re: w(`in\\s+(${P_COUNT})\\s+(days?|weeks?|months?)`),
      fn: (m, now) => {
        const n = countOf(m[3]);
        const unit = lower(m[4]);
        const today = startOfDay(now);
        if (unit.startsWith('day')) return addDays(today, n);
        if (unit.startsWith('week')) return addDays(today, n * 7);
        return new Date(today.getFullYear(), today.getMonth() + n, today.getDate());
      },
    },
    {
      re: w(`next\\s+(${P_WEEKDAY}|${P_WEEKDAY_SHORT})`),
      fn: (m, now) => weekdayNextWeek(now, WEEKDAYS[lower(m[3])] ?? WEEKDAYS_SHORT[lower(m[3])]),
    },
    { re: w(`(${P_WEEKDAY})`), fn: (m, now) => weekdayFrom(now, WEEKDAYS[lower(m[3])]) },
    { re: wEnd(`(${P_WEEKDAY_SHORT})`), fn: (m, now) => weekdayFrom(now, WEEKDAYS_SHORT[lower(m[3])]) },
  ];
}

const TIME_MATCHERS = [
  {
    re: new RegExp(`(^|\\s)((?:at\\s+)?(\\d{1,2})(?::([0-5]\\d))?\\s*(am|pm))${END}`, 'i'),
    fn: (m) => {
      const h = +m[3];
      if (h < 1 || h > 12) return null;
      const pm = lower(m[5]) === 'pm';
      return `${pad((h % 12) + (pm ? 12 : 0))}:${m[4] || '00'}`;
    },
  },
  {
    re: new RegExp(`(^|\\s)((?:at\\s+)?([01]?\\d|2[0-3]):([0-5]\\d))${END}`, 'i'),
    fn: (m) => `${pad(+m[3])}:${m[4]}`,
  },
  { re: new RegExp(`(^|\\s)((?:at\\s+)?(?:noon|midday))${END}`, 'i'), fn: () => '12:00' },
];

const RECURRENCE_RE =
  /(^|\s)((?:every|each)\s+\S.*|daily|weekly|fortnightly|monthly|yearly|annually|every\s+day)\s*$/i;

// Removes the first match of re from str, returning the match and the rest.
function cut(str, re) {
  const m = re.exec(str);
  if (!m) return null;
  const start = m.index + m[1].length;
  return { m, phrase: m[2], rest: `${str.slice(0, start)} ${str.slice(start + m[2].length)}` };
}

function protectQuotes(raw) {
  const quoted = [];
  const work = raw.replace(/"([^"]*)"/g, (_, inner) => {
    quoted.push(inner);
    return `${QUOTE_OPEN}${quoted.length - 1}${QUOTE_CLOSE}`;
  });
  const restore = (s) =>
    s.replace(new RegExp(`${QUOTE_OPEN}(\\d+)${QUOTE_CLOSE}`, 'g'), (_, i) => quoted[Number(i)]);
  return { work, restore };
}

const tidy = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Finds "/Section" in the text.
 *   mode "match": sections is a list of { key, name }; the longest name that
 *                 follows the slash wins, so "/Corner shop" beats "/Corner".
 *   mode "free":  any single word, or a quoted name (/"Corner shop"). Used
 *                 when the card can't see the list of sections.
 *   mode "none":  slashes are left alone.
 */
function extractSection(work, restore, mode, sections) {
  if (mode === 'none') return { work };
  const re = /(^|\s)\/(?=\S)/g;
  const quoteToken = new RegExp(`^${QUOTE_OPEN}\\d+${QUOTE_CLOSE}`);
  let m;
  while ((m = re.exec(work)) !== null) {
    const slash = m.index + m[1].length;
    const rest = work.slice(slash + 1);
    const remove = (len) => tidy(`${work.slice(0, slash)} ${rest.slice(len)}`);
    const q = quoteToken.exec(rest);
    const token = q ? q[0] : rest.split(/\s/)[0];
    const typed = restore(token);

    if (mode === 'free') return { work: remove(token.length), section: { key: null, name: typed } };

    if (q) {
      const s = sections.find((x) => lower(x.name) === lower(typed));
      return s ? { work: remove(token.length), section: s } : { work: remove(token.length), unmatched: typed };
    }
    const byLength = [...sections].sort((a, b) => b.name.length - a.name.length);
    for (const s of byLength) {
      const n = s.name;
      const next = rest.charAt(n.length);
      if (lower(rest.slice(0, n.length)) === lower(n) && (next === '' || /\s/.test(next))) {
        return { work: remove(n.length), section: s };
      }
    }
    return { work: remove(token.length), unmatched: typed };
  }
  return { work };
}

/**
 * Parses the add-bar text.
 * opts:
 *   sectionMode   "match" | "free" | "none"
 *   sections      [{ key, name }] for "match"
 *   capsFor(section) -> { dates, times, recurrence, labels, priority }
 *                 what the list the item lands in can store
 *   now           Date (defaults to the current time)
 *   dayFirst      true for 25/12, false for 12/25
 * Returns { text, section, unmatched, due: { date, time } | null, dueString,
 *           recurrence, recurrenceUnsupported, labels, priority }
 */
function parseInput(raw, opts = {}) {
  const now = opts.now || new Date();
  const { work: protectedWork, restore } = protectQuotes(String(raw ?? ''));
  const sec = extractSection(protectedWork, restore, opts.sectionMode || 'none', opts.sections || []);
  let work = sec.work;
  const caps = (opts.capsFor && opts.capsFor(sec.section || null)) || {};
  const out = {
    section: sec.section || null,
    unmatched: sec.unmatched || null,
    due: null,
    dueString: '',
    recurrence: '',
    recurrenceUnsupported: false,
    labels: [],
    priority: null,
  };

  if (caps.labels) {
    work = work.replace(/(^|\s)@([A-Za-z0-9_-]+)(?=$|\s)/g, (_, pre, label) => {
      out.labels.push(label);
      return pre;
    });
  }
  if (caps.priority) {
    const p = cut(work, /(^|\s)(p([1-4]))(?=$|\s)/i);
    if (p) {
      out.priority = Number(p.m[3]);
      work = p.rest;
    }
  }

  // A repeat ("every monday") is Todoist's to parse. Lists that can't repeat
  // keep it as text, and no date is read from inside it.
  const rec = cut(tidy(work), RECURRENCE_RE);
  let kept = '';
  if (rec) {
    if (caps.recurrence) {
      out.recurrence = restore(rec.phrase);
      out.dueString = out.recurrence;
    } else if (caps.dates) {
      out.recurrenceUnsupported = true;
      kept = rec.phrase;
    }
    if (caps.recurrence || caps.dates) work = rec.rest;
  }

  if (caps.dates && !out.recurrence) {
    let date = null;
    let datePhrase = '';
    for (const { re, fn } of dateMatchers(opts.dayFirst !== false)) {
      const hit = cut(work, re);
      if (!hit) continue;
      const d = fn(hit.m, now);
      if (!d) continue;
      date = d;
      datePhrase = hit.phrase;
      work = hit.rest;
      break;
    }
    let time = null;
    let timePhrase = '';
    if (caps.times) {
      for (const { re, fn } of TIME_MATCHERS) {
        const hit = cut(work, re);
        if (!hit) continue;
        const t = fn(hit.m);
        if (!t) continue;
        time = t;
        timePhrase = hit.phrase;
        work = hit.rest;
        break;
      }
    }
    if (time && !date) {
      // A time on its own means today, or tomorrow if it has already passed.
      const [h, mi] = time.split(':').map(Number);
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi);
      date = at > now ? startOfDay(now) : addDays(startOfDay(now), 1);
    }
    if (date) {
      out.due = { date: ymd(date), time };
      out.dueString = tidy(`${datePhrase} ${timePhrase}`).replace(/^on\s+/i, '');
    }
  }

  out.text = tidy(restore(`${work} ${kept}`));
  return out;
}

// =============================================================================
// Data sources
// -----------------------------------------------------------------------------
// Each source turns its data into one shape for the card:
//   { sections: [{ key, name }], items: [item], completed: [item] }
//   item = { id, content, sectionKey, due: { date?, datetime? } | null,
//            recurring, order, completedAt }
// and knows how to add an item and complete or reopen one.
// =============================================================================

// ---- YAML bridge (Todoist REST sensors + scripts) ---------------------------

class BridgeSource {
  constructor(config, onChange) {
    this.c = config;
    this.onChange = onChange;
  }

  connect() {}

  disconnect() {}

  version(hass) {
    const c = this.c;
    return [c.tasks_entity, c.sections_entity, c.completed_entity]
      .map((id) => hass.states[id]?.last_updated ?? 'x')
      .join('|');
  }

  // Optimistic state resolves when the tasks sensor moves on.
  resolveToken(hass) {
    return hass.states[this.c.tasks_entity]?.last_updated;
  }

  _attr(hass, entityId, key) {
    const v = entityId ? hass.states[entityId]?.attributes?.[key] : undefined;
    return Array.isArray(v) ? v : null;
  }

  _norm(t, completed) {
    const d = t.due;
    return {
      id: String(t.id ?? t.task_id),
      content: t.content,
      sectionKey: t.section_id ? String(t.section_id) : null,
      due: d ? { date: d.date, datetime: d.datetime } : null,
      recurring: !!d?.is_recurring,
      order: t.child_order ?? 1e9,
      completedAt: completed ? t.completed_at : null,
    };
  }

  snapshot(hass) {
    const c = this.c;
    const tasks = this._attr(hass, c.tasks_entity, 'results');
    if (!tasks) {
      return { error: `${c.tasks_entity} is missing or has no task data. Check the todoist_bridge package is loaded.` };
    }
    const mine = (x) => String(x.project_id) === c.project_id;
    const order = (s) => s.section_order ?? s.order ?? 0;
    const sections = (this._attr(hass, c.sections_entity, 'results') || [])
      .filter((s) => mine(s) && !s.is_archived && !s.is_deleted)
      .sort((a, b) => order(a) - order(b))
      .map((s) => ({ key: String(s.id), name: s.name }));
    const completedRaw = c.show_completed
      ? this._attr(hass, c.completed_entity, 'items') || this._attr(hass, c.completed_entity, 'results') || []
      : [];
    return {
      sections,
      items: tasks.filter(mine).map((t) => this._norm(t, false)),
      completed: completedRaw.filter(mine).map((t) => this._norm(t, true)),
    };
  }

  caps() {
    return { add: true, toggle: true, completed: true, sectionMode: 'match', parse: () => ({}) };
  }

  hint(firstSection) {
    return firstSection ? `Try: milk tomorrow 5pm /${firstSection}` : 'Try: milk tomorrow 5pm';
  }

  async add(hass, parsed) {
    const c = this.c;
    const [domain, service] = c.add_script.split('.');
    const res = await hass.connection.sendMessagePromise({
      type: 'call_service',
      domain,
      service,
      service_data: { text: parsed.text, project_id: c.project_id, section_id: parsed.section ? parsed.section.key : '' },
      return_response: true,
    });
    const r = res?.response || {};
    let msg = `Added ${r.content || parsed.text}`;
    if (parsed.section) msg += ` to ${parsed.section.name}`;
    if (r.due) msg += `, due ${r.due}`;
    if (r.moved === false) return { message: `${msg}. It could not be moved into this list, check Todoist.`, warn: true };
    return { message: msg };
  }

  async setDone(hass, item, done) {
    const [domain, service] = this.c.done_script.split('.');
    await hass.callService(domain, service, { task_id: item.id, done });
  }
}

// ---- Home Assistant to-do lists (todo.* entities) ---------------------------

class TodoSource {
  constructor(config, onChange) {
    this.c = config;
    this.onChange = onChange;
    this.lists = config._entities; // [{ entity, name }]
    this.items = new Map(); // entity_id -> raw items
    this.errors = new Map(); // entity_id -> message
    this.rev = 0;
    this.gen = 0;
    this.unsubs = [];
    this.pollTimer = null;
    this.connected = false;
  }

  _bump() {
    this.rev += 1;
    this.onChange();
  }

  connect(hass) {
    this._hass = hass;
    if (this.connected) return;
    this.connected = true;
    const gen = ++this.gen;
    for (const { entity } of this.lists) this._subscribe(hass, entity, gen);
  }

  disconnect() {
    this.connected = false;
    this.gen += 1;
    for (const u of this.unsubs) {
      try {
        u();
      } catch (e) {
        /* already closed */
      }
    }
    this.unsubs = [];
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async _subscribe(hass, entityId, gen) {
    try {
      const unsub = await hass.connection.subscribeMessage(
        (msg) => {
          if (gen !== this.gen) return;
          this.items.set(entityId, Array.isArray(msg?.items) ? msg.items : []);
          this.errors.delete(entityId);
          this._bump();
        },
        { type: 'todo/item/subscribe', entity_id: entityId },
      );
      if (gen !== this.gen) unsub();
      else this.unsubs.push(unsub);
    } catch (err) {
      if (gen !== this.gen) return;
      if (err?.code === 'unknown_command') {
        // Older Home Assistant: fetch the items on a timer instead.
        this._startPolling(gen);
      } else {
        this.errors.set(entityId, err?.message || 'could not be loaded');
        this._bump();
      }
    }
  }

  _startPolling(gen) {
    if (this.pollTimer) return;
    const poll = () => {
      if (gen === this.gen) this.refresh(this._hass);
    };
    this.pollTimer = setInterval(poll, POLL_INTERVAL);
    poll();
  }

  async refresh(hass) {
    if (!this.pollTimer || !hass) return;
    for (const { entity } of this.lists) {
      try {
        const res = await hass.connection.sendMessagePromise({
          type: 'call_service',
          domain: 'todo',
          service: 'get_items',
          target: { entity_id: entity },
          service_data: {},
          return_response: true,
        });
        this.items.set(entity, res?.response?.[entity]?.items || []);
        this.errors.delete(entity);
      } catch (err) {
        this.errors.set(entity, err?.message || 'could not be loaded');
      }
    }
    this._bump();
  }

  version(hass) {
    return `${this.rev}|${this.lists.map(({ entity }) => hass.states[entity]?.last_updated ?? 'x').join('|')}`;
  }

  resolveToken() {
    return this.rev;
  }

  _features(hass, entityId) {
    return Number(hass.states[entityId]?.attributes?.supported_features) || 0;
  }

  _isTodoist(hass, entityId) {
    return hass.entities?.[entityId]?.platform === 'todoist' && !!hass.services?.todoist?.new_task;
  }

  _name(hass, list) {
    return list.name || hass.states[list.entity]?.attributes?.friendly_name || list.entity;
  }

  get multi() {
    return this.lists.length > 1;
  }

  _target(section) {
    return section?.key || this.lists[0].entity;
  }

  snapshot(hass) {
    for (const { entity } of this.lists) {
      if (!hass.states[entity]) return { error: `${entity} was not found. Check the entity ID in the card configuration.` };
      if (this.errors.has(entity)) return { error: `${entity} ${this.errors.get(entity)}.` };
    }
    if (this.lists.some(({ entity }) => !this.items.has(entity))) return { loading: true };

    const sections = this.multi ? this.lists.map((l) => ({ key: l.entity, name: this._name(hass, l) })) : [];
    const items = [];
    const completed = [];
    for (const { entity } of this.lists) {
      (this.items.get(entity) || []).forEach((it, i) => {
        const due = it.due ? (String(it.due).length > 10 ? { datetime: it.due } : { date: it.due }) : null;
        const norm = {
          id: `${entity}|${it.uid}`,
          content: it.summary,
          sectionKey: this.multi ? entity : null,
          due,
          recurring: false,
          order: i,
          completedAt: it.completed || null,
        };
        (it.status === 'completed' ? completed : items).push(norm);
      });
    }
    return { sections, items, completed };
  }

  caps(hass) {
    const first = this.lists[0].entity;
    const all = (bit) => this.lists.every(({ entity }) => this._features(hass, entity) & bit);
    const single = !this.multi;
    const todoist = single && this._isTodoist(hass, first);
    return {
      add: all(FEATURE_CREATE) || todoist,
      toggle: all(FEATURE_UPDATE),
      completed: true,
      // One Todoist list: /Section goes to Todoist by name, unchecked.
      // Several lists: /Name picks the list.
      sectionMode: this.multi ? 'match' : todoist ? 'free' : 'none',
      parse: (section) => {
        const entity = this._target(section);
        const f = this._features(hass, entity);
        const viaTodoist = this._isTodoist(hass, entity);
        const dates = this.c.parse_dates && (viaTodoist || !!(f & (FEATURE_DUE_DATE | FEATURE_DUE_DATETIME)));
        return {
          dates,
          times: dates && (viaTodoist || !!(f & FEATURE_DUE_DATETIME)),
          recurrence: this.c.parse_dates && viaTodoist,
          labels: viaTodoist,
          priority: viaTodoist,
        };
      },
    };
  }

  targetName(hass, section) {
    if (!this.multi) return null;
    const entity = this._target(section);
    return this._name(hass, this.lists.find((l) => l.entity === entity));
  }

  hint(firstSection, hass) {
    const caps = this.caps(hass).parse(null);
    if (this.multi) return `Try: milk${caps.dates ? ' tomorrow' : ''} /${firstSection || 'List'}`;
    if (this._isTodoist(hass, this.lists[0].entity)) return 'Try: milk tomorrow 5pm /Section @label';
    if (caps.times) return 'Try: milk tomorrow 5pm';
    if (caps.dates) return 'Try: milk tomorrow';
    return 'Type an item and press Enter';
  }

  async add(hass, parsed) {
    const entity = this._target(parsed.section);
    const list = this.lists.find((l) => l.entity === entity);
    if (this._isTodoist(hass, entity)) {
      const data = { content: parsed.text, project: this.c.todoist_project || this._name(hass, list) };
      if (!this.multi && parsed.section) data.section = parsed.section.name;
      if (parsed.labels.length) data.labels = parsed.labels.join(',');
      // Todoist API: 4 is most urgent, shown as p1 in the apps.
      if (parsed.priority) data.priority = 5 - parsed.priority;
      if (parsed.dueString) {
        data.due_date_string = parsed.dueString;
        data.due_date_lang = 'en';
      }
      try {
        await hass.callService('todoist', 'new_task', data);
      } catch (err) {
        // The Todoist action looks the project up on every call, so a broken
        // Todoist connection shows up here as an unhelpful server error.
        const msg = err?.message || 'the request failed';
        throw new Error(`${msg}. If this keeps happening, check the Todoist integration in Settings → Devices & services`);
      }
    } else {
      const data = { item: parsed.text };
      const f = this._features(hass, entity);
      if (parsed.due) {
        if (parsed.due.time && f & FEATURE_DUE_DATETIME) data.due_datetime = `${parsed.due.date} ${parsed.due.time}:00`;
        else if (f & FEATURE_DUE_DATE) data.due_date = parsed.due.date;
        else if (f & FEATURE_DUE_DATETIME) data.due_datetime = `${parsed.due.date} 00:00:00`;
      }
      await hass.callService('todo', 'add_item', data, { entity_id: entity });
    }
    await this.refresh(hass);
    return {};
  }

  async setDone(hass, item, done) {
    const sep = item.id.indexOf('|');
    const entity = item.id.slice(0, sep);
    const uid = item.id.slice(sep + 1);
    await hass.callService('todo', 'update_item', { item: uid, status: done ? 'completed' : 'needs_action' }, { entity_id: entity });
    await this.refresh(hass);
  }
}

// =============================================================================
// Card
// =============================================================================

const ICON_PLUS =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_CHECK =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const ICON_TICK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const ICON_CHEV =
  '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

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

function normaliseConfig(config) {
  if (!config) throw new Error('natural-language-todo-card: configuration is missing');
  const c = { ...DEFAULTS, ...config };
  for (const key of ['hide_sections', 'collapsed_sections', 'entities']) {
    if (!Array.isArray(c[key])) throw new Error(`natural-language-todo-card: ${key} must be a list`);
  }
  if (!SOURCES.includes(c.source)) {
    throw new Error(`natural-language-todo-card: source must be one of ${SOURCES.join(', ')}`);
  }
  if (!DUE_DISPLAY.includes(c.due_display)) {
    throw new Error(`natural-language-todo-card: due_display must be one of ${DUE_DISPLAY.join(', ')}`);
  }
  c._entities = [
    ...(c.entity ? [{ entity: c.entity }] : []),
    ...c.entities.map((e) => (typeof e === 'string' ? { entity: e } : { entity: e?.entity, name: e?.name })),
  ];
  for (const { entity } of c._entities) {
    if (typeof entity !== 'string' || !/^todo\.[a-z0-9_]+$/.test(entity)) {
      throw new Error(`natural-language-todo-card: "${entity}" is not a to-do entity (todo.*)`);
    }
  }
  if (c.source === 'auto') c.source = c._entities.length ? 'todo' : 'todoist_bridge';
  if (c.source === 'todo' && !c._entities.length) {
    throw new Error('natural-language-todo-card: set entity (or entities) to a to-do list');
  }
  if (c.source === 'todoist_bridge' && !c.project_id) {
    throw new Error('natural-language-todo-card: set entity to a to-do list, or project_id for the Todoist bridge');
  }
  c.project_id = String(c.project_id);
  c.add_timeout = Math.max(0, Number(c.add_timeout) || 0);
  c.completed_limit = Math.max(1, Number(c.completed_limit) || DEFAULTS.completed_limit);
  return c;
}

const CardBase = typeof HTMLElement === 'undefined' ? class {} : HTMLElement;

class NaturalLanguageTodoCard extends CardBase {
  static getStubConfig(hass) {
    const entity = Object.keys(hass?.states || {}).find((id) => id.startsWith('todo.')) || 'todo.shopping_list';
    return { entity };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._pending = new Map(); // item id -> { done, recurring, resolved, at, token }
    this._pendingAdds = []; // { id, content, sectionKey, before, at }
    this._draft = '';
    this._timer = null;
    this._toastTimer = null;
    this._built = false;
    this._sig = '';
  }

  // ---------------------------------------------------------------- config

  setConfig(config) {
    const c = normaliseConfig(config);
    this._source?.disconnect();
    this._config = c;
    this._source =
      c.source === 'todo'
        ? new TodoSource(c, () => this._renderList(true))
        : new BridgeSource(c, () => this._renderList(true));
    const key = c.source === 'todo' ? c._entities.map((e) => e.entity).join(',') : c.project_id;
    this._storeKey = `natural-language-todo-card:${key}`;
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
    if (this.isConnected) this._source.connect(hass);
    const sig = this._source.version(hass);
    if (sig !== this._sig) {
      this._sig = sig;
      this._renderList();
    }
  }

  connectedCallback() {
    if (this._config && this._hass) this._source.connect(this._hass);
  }

  disconnectedCallback() {
    clearTimeout(this._timer);
    clearTimeout(this._toastTimer);
    this._source?.disconnect();
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

  _dayFirst() {
    const locale = this._hass?.locale;
    if (locale?.date_format === 'MDY') return false;
    if (locale?.date_format === 'DMY' || locale?.date_format === 'YMD') return true;
    // Home Assistant's "en" is US English.
    const lang = locale?.language || this._hass?.language || navigator.language || 'en-GB';
    return !/^en(-US|-PH)?$/i.test(lang);
  }

  _parse(raw) {
    const caps = this._source.caps(this._hass);
    return parseInput(raw, {
      sectionMode: caps.sectionMode,
      sections: this._visibleSections(),
      capsFor: caps.parse,
      dayFirst: this._dayFirst(),
    });
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
    const p = this._parse(raw);
    const chips = [];
    const target = this._source.targetName?.(this._hass, p.section);
    if (p.section && p.section.key === null) chips.push(`<span class="chip">Section ${esc(p.section.name)} (checked by Todoist)</span>`);
    else if (p.section) chips.push(`<span class="chip">${esc(p.section.name)}</span>`);
    else if (target) chips.push(`<span class="chip">${esc(target)}</span>`);
    if (p.unmatched) {
      const where = target ? `Adds to ${target}.` : 'Adds without a section.';
      chips.push(`<span class="chip warn">No section called ${esc(p.unmatched)}. ${esc(where)}</span>`);
    }
    if (p.due) {
      const due = this._dueLabel(p.due.time ? { datetime: `${p.due.date}T${p.due.time}:00` } : { date: p.due.date }, true);
      if (due) chips.push(`<span class="chip">Due ${esc(due.label)}</span>`);
    }
    if (p.recurrence) chips.push(`<span class="chip">Repeats ${esc(p.recurrence)}</span>`);
    if (p.recurrenceUnsupported) chips.push('<span class="chip warn">This list can\'t repeat items, so it stays in the text</span>');
    for (const l of p.labels) chips.push(`<span class="chip">@${esc(l)}</span>`);
    if (p.priority) chips.push(`<span class="chip">p${p.priority}</span>`);
    this._$preview.innerHTML = chips.join('');
    this._$preview.hidden = chips.length === 0;
  }

  async _add() {
    const raw = this._$input.value;
    if (!raw.trim()) return;
    const parsed = this._parse(raw);
    if (!parsed.text) {
      this._toast('Type an item name as well.', true);
      return;
    }
    const snap = this._source.snapshot(this._hass);
    const same = (t) => lower(t.content) === lower(parsed.text);
    const sectionKey = parsed.section?.key ?? (this._source.multi ? this._source._target(null) : null);
    const temp = {
      id: `tmp-${Date.now()}-${Math.random()}`,
      content: parsed.text,
      sectionKey,
      before: (snap.items || []).filter(same).length,
      at: Date.now(),
    };
    this._pendingAdds.push(temp);
    this._$input.value = '';
    this._draft = '';
    this._updatePreview();
    this._armTimer();
    this._renderList(true);
    setTimeout(() => this._dropPendingAdd(temp.id), PENDING_ADD_TIMEOUT);

    try {
      const res = await this._source.add(this._hass, parsed);
      this._toast(res.message || this._addedMessage(parsed), !!res.warn);
    } catch (err) {
      this._dropPendingAdd(temp.id);
      if (!this._$input.value) this._$input.value = raw;
      this._updatePreview();
      this._toast(`Could not add ${parsed.text}: ${err?.message || 'the request failed'}`, true);
    }
    this._renderList(true);
  }

  _addedMessage(p) {
    let msg = `Added ${p.text}`;
    const target = p.section?.name || this._source.targetName?.(this._hass, p.section);
    if (target) msg += ` to ${target}`;
    if (p.recurrence) msg += `, repeating ${p.recurrence}`;
    else if (p.due) {
      const due = this._dueLabel(p.due.time ? { datetime: `${p.due.date}T${p.due.time}:00` } : { date: p.due.date }, true);
      if (due) msg += `, due ${due.label}`;
    }
    return msg;
  }

  _dropPendingAdd(id) {
    const before = this._pendingAdds.length;
    this._pendingAdds = this._pendingAdds.filter((p) => p.id !== id);
    if (this._pendingAdds.length !== before) this._renderList(true);
  }

  _toast(msg, isError = false) {
    clearTimeout(this._toastTimer);
    this._$toast.textContent = msg;
    this._$toast.classList.toggle('err', isError);
    this._$toast.hidden = false;
    this._toastTimer = setTimeout(() => (this._$toast.hidden = true), isError ? 8000 : 4000);
  }

  // ------------------------------------------------------------------ data

  _hiddenSet() {
    return new Set(this._config.hide_sections.map((x) => lower(x)));
  }

  _visibleSections() {
    const snap = this._source.snapshot(this._hass);
    const hidden = this._hiddenSet();
    return (snap.sections || []).filter((s) => !hidden.has(lower(s.key)) && !hidden.has(lower(s.name)));
  }

  _data() {
    const c = this._config;
    const snap = this._source.snapshot(this._hass);
    if (snap.error || snap.loading) return snap;

    const visible = this._visibleSections();
    const visibleKeys = new Set(visible.map((s) => s.key));
    const knownKeys = new Set(snap.sections.map((s) => s.key));
    // Hidden = in a section this card hides. Items in a section the card does
    // not know yet fall back to "no section" rather than vanish.
    const inHidden = (t) => t.sectionKey && knownKeys.has(t.sectionKey) && !visibleKeys.has(t.sectionKey);
    const groupKey = (t) => (t.sectionKey && visibleKeys.has(t.sectionKey) ? t.sectionKey : UNSECTIONED_KEY);

    const items = snap.items.filter((t) => !inHidden(t));
    const itemIds = new Set(items.map((t) => t.id));
    const completed = c.show_completed ? snap.completed.filter((t) => !inHidden(t)) : [];

    // Expire optimistic state once the data has moved on, or after 60 s.
    const now = Date.now();
    const token = this._source.resolveToken(this._hass);
    for (const [id, p] of this._pending) {
      if (now - p.at > PENDING_TOGGLE_TIMEOUT || (p.resolved && p.recurring) || (p.resolved && p.token !== token)) {
        this._pending.delete(id);
      }
    }
    // A pending add is done once an item with the same text shows up.
    this._pendingAdds = this._pendingAdds.filter(
      (p) => snap.items.filter((t) => lower(t.content) === lower(p.content)).length <= p.before,
    );

    const open = [];
    const done = [];
    for (const t of items) {
      const p = this._pending.get(t.id);
      if (p && p.done && !p.recurring) done.push({ ...t, _busy: !p.resolved, _done: true });
      else open.push({ ...t, _busy: !!p && !p.resolved });
    }
    for (const t of completed) {
      const p = this._pending.get(t.id);
      if (p && !p.done) {
        if (!itemIds.has(t.id)) open.push({ ...t, _busy: !p.resolved });
      } else if (!itemIds.has(t.id)) {
        done.push({ ...t, _done: true });
      }
    }
    for (const t of this._pendingAdds) open.push({ ...t, due: null, order: 1e9, _busy: true, _temp: true });

    const byOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9);
    const groups = [];
    if (c.show_unsectioned) {
      const list = open.filter((t) => groupKey(t) === UNSECTIONED_KEY).sort(byOrder);
      if (list.length || (c.unsectioned_title && !c.hide_empty_sections)) {
        const header = !!c.unsectioned_title;
        groups.push({ key: UNSECTIONED_KEY, name: c.unsectioned_title, header, items: list, collapsed: header && this._isCollapsed(UNSECTIONED_KEY) });
      }
    }
    for (const s of visible) {
      const list = open.filter((t) => groupKey(t) === s.key).sort(byOrder);
      if (!list.length && c.hide_empty_sections) continue;
      groups.push({ key: s.key, name: s.name, header: true, items: list, collapsed: this._isCollapsed(s.key, s.name) });
    }

    const doneSorted = done
      .sort((a, b) => (b._busy ? 1 : 0) - (a._busy ? 1 : 0) || String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? '')))
      .slice(0, c.completed_limit);

    const sectionName = new Map(snap.sections.map((s) => [s.key, s.name]));
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

  // Follow the user's Home Assistant language, falling back to the browser's.
  _locale() {
    const lang = this._hass?.locale?.language || this._hass?.language;
    try {
      return lang ? Intl.DateTimeFormat.supportedLocalesOf(lang)[0] || undefined : undefined;
    } catch (e) {
      return undefined;
    }
  }

  // due = { date: "YYYY-MM-DD" } or { datetime: ISO string }.
  // ignoreMode = true always returns a label (for previews).
  _dueLabel(d, ignoreMode = false) {
    const mode = ignoreMode ? 'all' : this._config.due_display;
    if (!d || mode === 'none') return null;
    const raw = d.datetime || d.date;
    if (!raw) return null;
    const hasTime = String(raw).length > 10;
    let when;
    if (hasTime) {
      when = new Date(raw); // ISO with offset = exact; without = local (floating)
    } else {
      const [y, m, day] = String(raw).split('-').map(Number);
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

  // --------------------------------------------------------------- render

  _itemHtml(t, sectionName, showSection, canToggle) {
    const done = !!t._done;
    const cls = ['item', done ? 'done' : '', t._busy ? 'busy' : ''].join(' ');
    const label = done ? `Mark ${t.content} as not done` : `Complete ${t.content}`;
    const due = done ? null : this._dueLabel(t.due);
    const dueHtml = due ? `<span class="due ${due.kind}">${esc(due.label)}</span>` : '';
    const secHtml = showSection && t.sectionKey && sectionName.get(t.sectionKey)
      ? `<span class="meta">${esc(sectionName.get(t.sectionKey))}</span>`
      : '';
    const box = t._temp || !canToggle
      ? `<span class="box"><span class="tick">${done ? ICON_TICK : ''}</span></span>`
      : `<button class="box" type="button" data-action="toggle" data-id="${esc(t.id)}" data-done="${done}" data-recurring="${!!t.recurring}" aria-label="${esc(label)}"><span class="tick">${ICON_TICK}</span></button>`;
    return `<li class="${cls}">${box}<span class="text">${esc(t.content)}</span>${dueHtml}${secHtml}</li>`;
  }

  _renderList(force) {
    if (!this._built || !this._hass) return;
    if (force) this._sig = '';
    const c = this._config;
    const caps = this._source.caps(this._hass);
    this._$toggle.hidden = !caps.add;
    if (!caps.add && this._isOpen()) this._close(true);
    const d = this._data();

    if (d.error || d.loading) {
      this._$count.textContent = '';
      this._$list.innerHTML = `<div class="empty">${esc(d.error || 'Loading…')}</div>`;
      return;
    }

    this._$count.textContent = c.show_count ? `${d.openCount} ${c.count_suffix}` : '';
    this._$hint.textContent = this._source.hint(d.firstSection, this._hass);

    // Remember keyboard focus so re-rendering doesn't throw it away.
    const active = this.shadowRoot.activeElement;
    const focusKey = active?.dataset?.action ? [active.dataset.action, active.dataset.id ?? active.dataset.key] : null;

    let html = '';
    for (const g of d.groups) {
      html += '<div class="group">';
      if (g.header) {
        html += `<button class="sec" type="button" data-action="collapse" data-key="${esc(g.key)}" aria-expanded="${!g.collapsed}">
          <span class="sec-name">${esc(g.name)}</span><span class="pill">${g.items.length}</span>${ICON_CHEV}</button>`;
      }
      if (!g.collapsed) html += `<ul>${g.items.map((t) => this._itemHtml(t, d.sectionName, false, caps.toggle)).join('')}</ul>`;
      html += '</div>';
    }

    if (c.show_completed && d.done.length) {
      const collapsed = this._isCollapsed(COMPLETED_KEY);
      html += `<div class="group"><button class="sec" type="button" data-action="collapse" data-key="${COMPLETED_KEY}" aria-expanded="${!collapsed}">
        <span class="sec-name">Completed</span><span class="pill">${d.done.length}</span>${ICON_CHEV}</button>`;
      if (!collapsed) html += `<ul>${d.done.map((t) => this._itemHtml(t, d.sectionName, true, caps.toggle)).join('')}</ul>`;
      html += '</div>';
    }

    if (!d.groups.length && !(c.show_completed && d.done.length)) {
      html = `<div class="empty">Nothing on this list.${caps.add ? ' Tap + to add an item.' : ''}</div>`;
    }

    this._$list.innerHTML = html;

    if (focusKey) {
      const [action, id] = focusKey;
      const attr = action === 'collapse' ? 'data-key' : 'data-id';
      this._$list.querySelector(`[data-action="${CSS.escape(action)}"][${attr}="${CSS.escape(id)}"]`)?.focus();
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
      this._toggleItem(el.dataset.id, el.dataset.done !== 'true', el.dataset.recurring === 'true');
    }
  }

  async _toggleItem(id, done, recurring) {
    if (this._pending.has(id)) return;
    const entry = { done, recurring: done && recurring, resolved: false, at: Date.now() };
    this._pending.set(id, entry);
    this._renderList(true);
    try {
      await this._source.setDone(this._hass, { id }, done);
      entry.resolved = true;
      entry.token = this._source.resolveToken(this._hass);
    } catch (err) {
      this._pending.delete(id);
      this._toast(`Could not update the item: ${err?.message || 'the request failed'}`, true);
    }
    this._renderList(true);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('natural-language-todo-card')) {
  customElements.define('natural-language-todo-card', NaturalLanguageTodoCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'natural-language-todo-card',
    name: 'Natural Language To-do Card',
    description: 'To-do list with sections, natural-language quick add and optional completed items.',
    preview: true,
    documentationURL: 'https://github.com/joshmd/natural-language-Todo',
  });
  console.info(`%c NATURAL-LANGUAGE-TODO-CARD %c v${CARD_VERSION} `, 'background:#e0585f;color:#fff', 'background:#444;color:#fff');
}

// Earlier name, kept so dashboards using custom:todoist-sections-card keep working.
if (typeof customElements !== 'undefined' && !customElements.get('todoist-sections-card')) {
  customElements.define('todoist-sections-card', class extends NaturalLanguageTodoCard {});
}

export { parseInput, extractSection, normaliseConfig, BridgeSource, TodoSource, CARD_VERSION };
