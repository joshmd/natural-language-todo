// Browser tests: loads the real card in headless Chromium against a fake
// Home Assistant and checks each data source end to end.
// Run: npm run test:browser
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_PATH));

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = `<!doctype html><html><body>
<script>
  window.pwned = [];
  customElements.define('ha-card', class extends HTMLElement {});
</script>
<script type="module" src="/natural-language-todo-card.js"></script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/natural-language-todo-card.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(fs.readFileSync(path.join(root, 'natural-language-todo-card.js')));
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const results = [];

async function run(name, fn) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => customElements.get('natural-language-todo-card'));
  // Shared fake Home Assistant, installed into the page.
  await page.evaluate(() => {
    window.LOCAL = { friendly_name: 'Shopping', supported_features: 1 | 2 | 4 | 8 | 16 | 32 | 64 };
    window.makeHass = ({ states = {}, entities = {}, services = {}, items = {}, subscribe = true, companion = null } = {}) => {
      if (companion) services = { ...services, natural_language_todo: { add_task: {}, set_done: {} } };
      const calls = [];
      const subs = new Map();
      const hass = {
        language: 'en-GB',
        locale: { language: 'en-GB' },
        states,
        entities,
        services,
        calls,
        items,
        push(entity) {
          for (const cb of subs.get(entity) || []) cb({ items: items[entity] || [] });
        },
        connection: {
          async subscribeMessage(cb, msg) {
            calls.push(['subscribe', msg]);
            if (msg.type === 'natural_language_todo/subscribe') {
              const data = companion?.[msg.project_id];
              if (!data) {
                const err = new Error('Project is not set up in the companion');
                err.code = 'not_found';
                throw err;
              }
              setTimeout(() => cb(data), 0);
              return () => {};
            }
            if (!subscribe) {
              const err = new Error('Unknown command.');
              err.code = 'unknown_command';
              throw err;
            }
            if (!subs.has(msg.entity_id)) subs.set(msg.entity_id, []);
            subs.get(msg.entity_id).push(cb);
            setTimeout(() => cb({ items: items[msg.entity_id] || [] }), 0);
            return () => subs.set(msg.entity_id, subs.get(msg.entity_id).filter((x) => x !== cb));
          },
          async sendMessagePromise(msg) {
            calls.push(['ws', msg]);
            if (msg.domain === 'todo' && msg.service === 'get_items') {
              const id = msg.target.entity_id;
              return { response: { [id]: { items: items[id] || [] } } };
            }
            if (msg.domain === 'natural_language_todo') {
              return { response: { id: 'n1', content: msg.service_data.text, due: 'tomorrow', moved: true } };
            }
            return { response: { content: msg.service_data?.text, due: '', moved: true } };
          },
        },
        async callService(domain, service, data, target) {
          calls.push([`${domain}.${service}`, data, target]);
          if (hass.failNext) {
            hass.failNext = false;
            throw new Error('Invalid section name');
          }
          const id = target?.entity_id;
          if (domain === 'todo' && service === 'add_item') {
            (items[id] = items[id] || []).push({ uid: `u${Date.now()}`, summary: data.item, status: 'needs_action', due: data.due_datetime || data.due_date });
            hass.push(id);
          }
          if (domain === 'todo' && service === 'update_item') {
            const it = (items[id] || []).find((x) => x.uid === data.item);
            if (it) it.status = data.status;
            hass.push(id);
          }
        },
      };
      return hass;
    };
    window.mount = (config, hass, tag = 'natural-language-todo-card') => {
      const el = document.createElement(tag);
      el.setConfig(config);
      document.body.appendChild(el);
      el.hass = hass;
      window.card = el;
      return el;
    };
    window.q = (sel) => window.card.shadowRoot.querySelector(sel);
    window.qa = (sel) => [...window.card.shadowRoot.querySelectorAll(sel)];
    window.texts = (sel) => window.qa(sel).map((e) => e.textContent.trim());
    window.type = (text) => {
      window.card._open();
      const input = window.q('#tsc-input');
      input.value = text;
      input.dispatchEvent(new Event('input'));
    };
    window.tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  });
  try {
    await fn(page);
    assert.deepEqual(errors, [], 'no page errors');
    results.push([name, 'ok']);
  } catch (err) {
    results.push([name, `FAIL: ${err.message}`]);
  }
  await page.close();
}

const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tomorrow = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));

await run('local to-do list: render, add with date and time, tick, completed group', async (page) => {
  const out = await page.evaluate(async (tomorrow) => {
    const hass = makeHass({
      states: { 'todo.shopping': { state: '2', last_updated: '1', attributes: LOCAL } },
      items: {
        'todo.shopping': [
          { uid: 'a', summary: 'Bananas', status: 'needs_action' },
          { uid: 'b', summary: 'Bread', status: 'needs_action', due: tomorrow },
          { uid: 'c', summary: 'Old milk', status: 'completed' },
        ],
      },
    });
    mount({ entity: 'todo.shopping', title: 'Shopping', show_completed: true, completed_collapsed: false }, hass);
    await tick();
    const before = texts('.item .text');
    const dueChip = texts('.due');
    type('milk tomorrow 5pm');
    const preview = q('.preview').textContent;
    await card._add();
    await tick();
    const add = hass.calls.find((c) => c[0] === 'todo.add_item');
    q('button[data-action="toggle"][data-id="todo.shopping|a"]').click();
    await tick();
    const upd = hass.calls.find((c) => c[0] === 'todo.update_item');
    await tick();
    return { before, dueChip, preview, add, upd, after: texts('.item .text'), done: texts('.item.done .text'), hint: q('.hint').textContent };
  }, tomorrow);
  assert.deepEqual(out.before, ['Bananas', 'Bread', 'Old milk']);
  assert.deepEqual(out.dueChip, ['Tomorrow']);
  assert.match(out.preview, /Due Tomorrow 17:00/);
  assert.deepEqual(out.add[1], { item: 'milk', due_datetime: `${tomorrow} 17:00:00` });
  assert.deepEqual(out.add[2], { entity_id: 'todo.shopping' });
  assert.deepEqual(out.upd[1], { item: 'a', status: 'completed' });
  assert.ok(out.after.includes('milk'), 'new item shown');
  assert.ok(out.done.includes('Bananas'), 'ticked item moves to Completed');
  assert.equal(out.hint, 'Try: milk tomorrow 5pm');
});

await run('list without due dates keeps the date in the text', async (page) => {
  const out = await page.evaluate(async () => {
    const hass = makeHass({
      states: { 'todo.shopping_list': { state: '0', last_updated: '1', attributes: { friendly_name: 'Shopping list', supported_features: 1 | 2 | 4 | 8 } } },
      items: { 'todo.shopping_list': [] },
    });
    mount({ entity: 'todo.shopping_list' }, hass);
    await tick();
    type('milk tomorrow');
    const preview = q('.preview').hidden;
    await card._add();
    return { add: hass.calls.find((c) => c[0] === 'todo.add_item'), preview, hint: q('.hint').textContent };
  });
  assert.deepEqual(out.add[1], { item: 'milk tomorrow' });
  assert.equal(out.preview, true);
  assert.equal(out.hint, 'Type an item and press Enter');
});

await run('Todoist list via core integration: new_task with section, labels, priority, due string', async (page) => {
  const out = await page.evaluate(async () => {
    const hass = makeHass({
      states: { 'todo.weekly_food_shop': { state: '1', last_updated: '1', attributes: { friendly_name: 'Weekly Food Shop', supported_features: 119 } } },
      entities: { 'todo.weekly_food_shop': { entity_id: 'todo.weekly_food_shop', platform: 'todoist' } },
      services: { todoist: { new_task: {} } },
      items: { 'todo.weekly_food_shop': [{ uid: '1', summary: 'Eggs', status: 'needs_action' }] },
    });
    mount({ entity: 'todo.weekly_food_shop' }, hass);
    await tick();
    type('bin bags fri 7pm /Bakery @home p1');
    const preview = texts('.preview .chip');
    await card._add();
    const first = hass.calls.find((c) => c[0] === 'todoist.new_task');
    type('water filter every 2 months /"Corner shop"');
    await card._add();
    const second = hass.calls.filter((c) => c[0] === 'todoist.new_task')[1];
    // Unknown section: Home Assistant rejects it, the text comes back.
    hass.failNext = true;
    type('glue /Garage');
    await card._add();
    await tick();
    return { first, second, preview, err: q('.toast').textContent, input: q('#tsc-input').value, hint: q('.hint').textContent };
  });
  assert.deepEqual(out.first[1], {
    content: 'bin bags', project: 'Weekly Food Shop', section: 'Bakery', labels: 'home', priority: 4,
    due_date_string: 'fri 7pm', due_date_lang: 'en',
  });
  assert.deepEqual(out.second[1], {
    content: 'water filter', project: 'Weekly Food Shop', section: 'Corner shop',
    due_date_string: 'every 2 months', due_date_lang: 'en',
  });
  assert.ok(out.preview.some((c) => c.includes('Bakery')));
  assert.ok(out.preview.includes('@home') && out.preview.includes('p1'));
  assert.match(out.err, /Could not add glue: Invalid section name\. If this keeps happening, check the Todoist integration/);
  assert.equal(out.input, 'glue /Garage');
  assert.equal(out.hint, 'Try: milk tomorrow 5pm /Section @label');
});

await run('todoist_project overrides the project name', async (page) => {
  const out = await page.evaluate(async () => {
    const hass = makeHass({
      states: { 'todo.food': { state: '0', last_updated: '1', attributes: { friendly_name: 'Food', supported_features: 119 } } },
      entities: { 'todo.food': { platform: 'todoist' } },
      services: { todoist: { new_task: {} } },
      items: { 'todo.food': [] },
    });
    mount({ entity: 'todo.food', todoist_project: 'Weekly Food Shop' }, hass);
    await tick();
    type('milk');
    await card._add();
    return hass.calls.find((c) => c[0] === 'todoist.new_task')[1];
  });
  assert.deepEqual(out, { content: 'milk', project: 'Weekly Food Shop' });
});

await run('several lists become sections; /Name picks the list', async (page) => {
  const out = await page.evaluate(async () => {
    const f = { supported_features: 119 };
    const hass = makeHass({
      states: {
        'todo.fruit': { state: '1', last_updated: '1', attributes: { ...f, friendly_name: 'Fruit & veg' } },
        'todo.bakery': { state: '1', last_updated: '1', attributes: { ...f, friendly_name: 'Bakery' } },
      },
      items: {
        'todo.fruit': [{ uid: '1', summary: 'Apples', status: 'needs_action' }],
        'todo.bakery': [{ uid: '2', summary: 'Rolls', status: 'needs_action' }],
      },
    });
    mount({ entities: ['todo.fruit', { entity: 'todo.bakery', name: 'Bread & cakes' }], collapsed_sections: ['Bread & cakes'] }, hass);
    await tick();
    const heads = texts('.sec-name');
    const visible = texts('.item .text');
    type('sourdough tomorrow /bread & cakes');
    const preview = texts('.preview .chip');
    await card._add();
    const toBakery = hass.calls.find((c) => c[0] === 'todo.add_item');
    type('kiwis');
    const defaultPreview = texts('.preview .chip');
    await card._add();
    const toDefault = hass.calls.filter((c) => c[0] === 'todo.add_item')[1];
    return { heads, visible, preview, toBakery, toDefault, defaultPreview, count: q('.count').textContent };
  });
  assert.deepEqual(out.heads, ['Fruit & veg', 'Bread & cakes']);
  assert.deepEqual(out.visible, ['Apples'], 'collapsed section hides its items');
  assert.equal(out.toBakery[2].entity_id, 'todo.bakery');
  assert.equal(out.toBakery[1].item, 'sourdough');
  assert.ok(out.toBakery[1].due_date || out.toBakery[1].due_datetime);
  assert.deepEqual(out.defaultPreview, ['Fruit & veg']);
  assert.equal(out.toDefault[2].entity_id, 'todo.fruit');
});

await run('completed items are sorted newest first', async (page) => {
  const out = await page.evaluate(async () => {
    const hass = makeHass({
      states: { 'todo.shopping': { state: '0', last_updated: '1', attributes: LOCAL } },
      items: {
        'todo.shopping': [
          { uid: 'a', summary: 'Older', status: 'completed', completed: '2026-09-20T10:00:00+00:00' },
          { uid: 'b', summary: 'Newest', status: 'completed', completed: '2026-09-24T10:00:00+00:00' },
          { uid: 'c', summary: 'Middle', status: 'completed', completed: '2026-09-22T10:00:00+00:00' },
        ],
      },
    });
    mount({ entity: 'todo.shopping', show_completed: true, completed_collapsed: false, completed_limit: 2 }, hass);
    await tick();
    return texts('.item.done .text');
  });
  assert.deepEqual(out, ['Newest', 'Middle']);
});

await run('older Home Assistant falls back to polling todo.get_items', async (page) => {
  const out = await page.evaluate(async () => {
    const hass = makeHass({
      subscribe: false,
      states: { 'todo.shopping': { state: '1', last_updated: '1', attributes: LOCAL } },
      items: { 'todo.shopping': [{ uid: 'a', summary: 'Tea', status: 'needs_action' }] },
    });
    mount({ entity: 'todo.shopping' }, hass);
    await tick(50);
    return { items: texts('.item .text'), polled: hass.calls.some((c) => c[0] === 'ws' && c[1].service === 'get_items') };
  });
  assert.deepEqual(out.items, ['Tea']);
  assert.equal(out.polled, true);
});

await run('missing entity shows a clear error', async (page) => {
  const out = await page.evaluate(async () => {
    mount({ entity: 'todo.nope' }, makeHass());
    await tick();
    return q('.empty').textContent;
  });
  assert.match(out, /todo\.nope was not found/);
});

await run('bad configuration is rejected', async (page) => {
  const out = await page.evaluate(() => {
    const errs = [];
    for (const cfg of [{}, { entity: 'sensor.x' }, { entity: 'todo.x', source: 'nope' }, { source: 'todo' }, { entities: 'todo.x' }]) {
      try {
        document.createElement('natural-language-todo-card').setConfig(cfg);
        errs.push('accepted');
      } catch (e) {
        errs.push('rejected');
      }
    }
    return errs;
  });
  assert.deepEqual(out, ['rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
});

await run('YAML bridge still works (v0.1 config), including the old card name', async (page) => {
  const out = await page.evaluate(async () => {
    const P = 'P1';
    const hass = makeHass({
      states: {
        'sensor.todoist_tasks': { last_updated: '1', attributes: { results: [
          { id: 't1', project_id: P, section_id: 's1', content: 'Bananas', child_order: 1 },
          { id: 't2', project_id: 'OTHER', section_id: null, content: 'Secret work task', child_order: 1 },
        ] } },
        'sensor.todoist_sections': { last_updated: '1', attributes: { results: [{ id: 's1', project_id: P, name: 'Fruit', section_order: 1 }] } },
        'sensor.todoist_completed': { last_updated: '1', attributes: { items: [] } },
      },
    });
    mount({ project_id: P, title: 'Shopping' }, hass, 'todoist-sections-card');
    await tick();
    type('kiwis tomorrow /Fruit');
    await card._add();
    const add = hass.calls.find((c) => c[0] === 'ws' && c[1].domain === 'script');
    q('button[data-action="toggle"]').click();
    await tick();
    return { heads: texts('.sec-name'), items: texts('.item .text'), add, done: hass.calls.find((c) => c[0] === 'script.todoist_bridge_set_done') };
  });
  assert.deepEqual(out.heads, ['Fruit']);
  assert.ok(!out.items.includes('Secret work task'), 'other projects hidden');
  assert.deepEqual(out.add[1].service_data, { text: 'kiwis tomorrow', project_id: 'P1', section_id: 's1' });
  assert.deepEqual(out.done[1], { task_id: 't1', done: true });
});


const COMPANION_DATA = {
  P1: {
    project: { id: 'P1', name: 'Shopping' },
    sections: [{ id: 's1', name: 'Fruit' }, { id: 's2', name: 'Bakery' }],
    tasks: [
      { id: 't1', content: 'Bananas', section_id: 's1', order: 1, due: null },
      { id: 't2', content: 'Rolls', section_id: 's2', order: 1, due: { date: '2026-09-26', is_recurring: false } },
      { id: 't3', content: 'Water filter', section_id: null, order: 1, due: { date: '2026-10-01', is_recurring: true } },
    ],
    completed: [{ id: 'c1', content: 'Eggs', section_id: 's1', completed_at: '2026-09-24T10:00:00Z' }],
  },
};

await run('companion: sections, add with section, tick, chosen automatically', async (page) => {
  const out = await page.evaluate(async (data) => {
    const hass = makeHass({ companion: data });
    mount({ project_id: 'P1', show_completed: true, completed_collapsed: false }, hass);
    await tick();
    const heads = texts('.sec-name');
    type('croissants tomorrow /Bakery');
    const preview = texts('.preview .chip');
    await card._add();
    const add = hass.calls.find((c) => c[0] === 'ws' && c[1].domain === 'natural_language_todo');
    q('button[data-action="toggle"][data-id="t1"]').click();
    await tick();
    const done = hass.calls.find((c) => c[0] === 'natural_language_todo.set_done');
    return { heads, preview, add, done, toast: q('.toast').textContent, hint: q('.hint').textContent };
  }, COMPANION_DATA);
  assert.deepEqual(out.heads, ['Fruit', 'Bakery', 'Completed']);
  assert.deepEqual(out.preview, ['Bakery']);
  assert.deepEqual(out.add[1].service_data, { text: 'croissants tomorrow', project_id: 'P1', section_id: 's2' });
  assert.equal(out.add[1].return_response, true);
  assert.deepEqual(out.done[1], { task_id: 't1', done: true });
  assert.match(out.toast, /Added croissants tomorrow to Bakery, due tomorrow/);
  assert.equal(out.hint, 'Try: milk tomorrow 5pm /Fruit');
});

await run('companion: missing integration and unticked project explain what to do', async (page) => {
  const out = await page.evaluate(async (data) => {
    mount({ project_id: 'P1', source: 'companion' }, makeHass());
    await tick();
    const missing = q('.empty').textContent;
    const link = q('.empty a')?.getAttribute('href');
    mount({ project_id: 'NOPE' }, makeHass({ companion: data }));
    await tick();
    return { missing, link, notTicked: q('.empty').textContent };
  }, COMPANION_DATA);
  assert.match(out.missing, /needs the Natural Language To-do Companion integration.*Install it from HACS/);
  assert.match(out.link, /^https:\/\/my\.home-assistant\.io\/redirect\/hacs_repository\/\?owner=joshmd&repository=natural-language-todo-companion&category=integration$/);
  assert.match(out.notTicked, /isn't ticked in the companion integration/);
});

await run('sort: due date, then undated last; alphabetical; manual', async (page) => {
  const out = await page.evaluate(async () => {
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    const items = [
      { uid: '1', summary: 'no date b', status: 'needs_action' },
      { uid: '2', summary: 'Friday', status: 'needs_action', due: d(3) },
      { uid: '3', summary: 'tomorrow 9:00', status: 'needs_action', due: `${d(1)}T09:00:00` },
      { uid: '4', summary: 'overdue', status: 'needs_action', due: d(-2) },
      { uid: '5', summary: 'tomorrow all day', status: 'needs_action', due: d(1) },
      { uid: '6', summary: 'Apple', status: 'needs_action' },
    ];
    const result = {};
    for (const sort of ['due', 'alphabetical', 'manual']) {
      const hass = makeHass({ states: { 'todo.a': { state: '6', last_updated: '1', attributes: LOCAL } }, items: { 'todo.a': items } });
      mount({ entity: 'todo.a', sort }, hass);
      await tick();
      result[sort] = texts('.item .text');
    }
    return result;
  });
  assert.deepEqual(out.due, ['overdue', 'tomorrow all day', 'tomorrow 9:00', 'Friday', 'no date b', 'Apple']);
  assert.deepEqual(out.alphabetical, ['Apple', 'Friday', 'no date b', 'overdue', 'tomorrow 9:00', 'tomorrow all day']);
  assert.deepEqual(out.manual, ['no date b', 'Friday', 'tomorrow 9:00', 'overdue', 'tomorrow all day', 'Apple']);
});

await run('sort applies within each section', async (page) => {
  const out = await page.evaluate(async (data) => {
    mount({ project_id: 'P1', sort: 'alphabetical' }, makeHass({ companion: {
      P1: { ...data.P1, tasks: [
        { id: 'a', content: 'Pears', section_id: 's1', order: 1 },
        { id: 'b', content: 'Apples', section_id: 's1', order: 2 },
        { id: 'c', content: 'Zebra cake', section_id: 's2', order: 1 },
        { id: 'd', content: 'Bagels', section_id: 's2', order: 2 },
      ] },
    } }));
    await tick();
    return texts('.item .text');
  }, COMPANION_DATA);
  assert.deepEqual(out, ['Apples', 'Pears', 'Bagels', 'Zebra cake']);
});

await run('max_items: first N items, then Show more / Show less', async (page) => {
  const out = await page.evaluate(async (data) => {
    const tasks = [];
    for (let i = 1; i <= 5; i++) tasks.push({ id: `f${i}`, content: `Fruit ${i}`, section_id: 's1', order: i });
    for (let i = 1; i <= 4; i++) tasks.push({ id: `b${i}`, content: `Bread ${i}`, section_id: 's2', order: i });
    mount({ project_id: 'P1', max_items: 3, title: 'T' }, makeHass({ companion: { P1: { ...data.P1, tasks, completed: [] } } }));
    await tick();
    const first = { items: texts('.item .text'), heads: texts('.sec-name'), more: q('.more')?.textContent, count: q('.count').textContent };
    q('.more').click();
    await tick();
    const expanded = { items: texts('.item .text').length, more: q('.more')?.textContent, heads: texts('.sec-name') };
    q('.more').click();
    await tick();
    return { first, expanded, again: texts('.item .text').length };
  }, COMPANION_DATA);
  assert.deepEqual(out.first.items, ['Fruit 1', 'Fruit 2', 'Fruit 3']);
  assert.deepEqual(out.first.heads, ['Fruit'], 'sections past the cut are hidden');
  assert.equal(out.first.more, 'Show 6 more');
  assert.equal(out.first.count, '9 open', 'count stays the full total');
  assert.equal(out.expanded.items, 9);
  assert.equal(out.expanded.more, 'Show less');
  assert.deepEqual(out.expanded.heads, ['Fruit', 'Bakery']);
  assert.equal(out.again, 3);
});

await run('max_height, grid options and size validation', async (page) => {
  const out = await page.evaluate(async () => {
    const hass = makeHass({ states: { 'todo.a': { state: '0', last_updated: '1', attributes: LOCAL } }, items: { 'todo.a': [] } });
    mount({ entity: 'todo.a', max_height: 300 }, hass);
    await tick();
    const style = q('.list').style.maxHeight;
    const overflow = getComputedStyle(q('.list')).overflowY;
    const grid = card.getGridOptions();
    const bad = [];
    for (const max_height of ['300', 'calc(1px)', '1px;color:red', 'expression(x)']) {
      try { document.createElement('natural-language-todo-card').setConfig({ entity: 'todo.a', max_height }); bad.push('accepted'); }
      catch (e) { bad.push('rejected'); }
    }
    const stub = customElements.get('natural-language-todo-card').getStubConfig(hass);
    return { style, overflow, grid, bad, stub };
  });
  assert.equal(out.style, '300px');
  assert.equal(out.overflow, 'auto');
  assert.deepEqual(out.grid, { columns: 6, rows: 'auto', min_columns: 3, min_rows: 2 });
  assert.deepEqual(out.bad, ['rejected', 'rejected', 'rejected', 'rejected']);
  assert.deepEqual(out.stub, { entity: 'todo.a', sort: 'due' });
});

await run('visual editor: switching source, keeping names, dropping defaults', async (page) => {
  const out = await page.evaluate(async (data) => {
    // Stand-in for Home Assistant's ha-form.
    customElements.define('ha-form', class extends HTMLElement {});
    const hass = makeHass({ companion: data });
    hass.callWS = async (msg) => (msg.type === 'natural_language_todo/projects' ? { projects: [{ id: 'P1', name: 'Shopping' }] } : {});
    const editor = document.createElement(customElements.get('natural-language-todo-card').getConfigElement().localName);
    const changes = [];
    editor.addEventListener('config-changed', (e) => changes.push(e.detail.config));
    document.body.appendChild(editor);
    editor.hass = hass;
    editor.setConfig({ type: 'custom:natural-language-todo-card', entities: ['todo.a', { entity: 'todo.b', name: 'Bread' }], hide_sections: ['X'] });
    await tick();
    const form = editor.querySelector('ha-form');
    const todoSchema = form.schema.map((f) => f.name);
    const todoData = form.data;
    const send = (value) => form.dispatchEvent(new CustomEvent('value-changed', { detail: { value } }));
    send({ ...todoData, sort: 'due', max_items: 5, show_hint: true });
    send({ ...form.data, mode: 'companion', project_id: '' });
    const companionSchema = form.schema.find((f) => f.name === 'project_id').selector;
    send({ ...form.data, project_id: 'P1' });
    send({ ...form.data, mode: 'todo', entities: ['todo.c'] });
    return { todoSchema, todoData, changes, companionSchema };
  }, COMPANION_DATA);
  assert.deepEqual(out.todoSchema.slice(0, 6), ['mode', 'entities', 'title', 'sort', 'max_items', 'max_height']);
  assert.deepEqual(out.todoData.entities, ['todo.a', 'todo.b']);
  assert.deepEqual(out.changes[0], {
    type: 'custom:natural-language-todo-card',
    entities: ['todo.a', { entity: 'todo.b', name: 'Bread' }],
    hide_sections: ['X'],
    sort: 'due',
    max_items: 5,
  }, 'names and YAML-only options kept; defaults not written');
  assert.deepEqual(out.companionSchema, { select: { mode: 'dropdown', options: [{ value: 'P1', label: 'Shopping' }] } });
  assert.deepEqual(out.changes[2], { type: 'custom:natural-language-todo-card', hide_sections: ['X'], sort: 'due', max_items: 5, project_id: 'P1', source: 'companion' });
  assert.deepEqual(out.changes[3], { type: 'custom:natural-language-todo-card', hide_sections: ['X'], sort: 'due', max_items: 5, entity: 'todo.c' });
});

await run('XSS: hostile item, list, section and config text never runs', async (page) => {
  const out = await page.evaluate(async () => {
    const X = (n) => `<img src=x onerror="window.pwned.push('${n}')"><svg onload="window.pwned.push('${n}')">"'\`;`;
    const f = { supported_features: 119 };
    const hass = makeHass({
      states: {
        'todo.a': { state: '1', last_updated: '1', attributes: { ...f, friendly_name: X('name') } },
        'todo.b': { state: '1', last_updated: '1', attributes: { ...f, friendly_name: 'B' } },
      },
      items: {
        'todo.a': [{ uid: X('uid'), summary: X('summary'), status: 'needs_action', due: X('due') }],
        'todo.b': [{ uid: 'b', summary: X('done'), status: 'completed' }],
      },
    });
    mount({
      entities: ['todo.a', { entity: 'todo.b', name: X('cfgname') }],
      title: X('title'), count_suffix: X('suffix'), show_completed: true, completed_collapsed: false,
      accent: 'red;background:url(//evil)',
    }, hass);
    await tick();
    type(`${X('input')} /${X('slash')} tomorrow`);
    await tick(50);
    return {
      injected: qa('img, svg:not([aria-hidden])').length,
      pwned: window.pwned,
      items: qa('.item').length,
      accent: getComputedStyle(card).getPropertyValue('--tsc-accent-override'),
    };
  });
  assert.equal(out.injected, 0);
  assert.deepEqual(out.pwned, []);
  assert.equal(out.items, 2);
  assert.equal(out.accent, '');
});

await run('XSS: hostile companion data never runs', async (page) => {
  const out = await page.evaluate(async () => {
    const X = (n) => `<img src=x onerror="window.pwned.push('${n}')">"'`;
    mount({ project_id: 'P1', max_items: 1, show_completed: true, completed_collapsed: false }, makeHass({ companion: { P1: {
      project: { id: 'P1', name: X('project') },
      sections: [{ id: X('sid'), name: X('section') }],
      tasks: [
        { id: X('tid'), content: X('task'), section_id: X('sid'), due: { date: X('date'), datetime: X('dt') } },
        { id: 't2', content: 'two', section_id: null },
      ],
      completed: [{ id: X('cid'), content: X('done'), section_id: X('sid') }],
    } } }));
    await tick();
    type(`x /${X('input')}`);
    q('.more').click();
    await tick(50);
    return { injected: qa('img').length, pwned: window.pwned, items: qa('.item').length };
  });
  assert.equal(out.injected, 0);
  assert.deepEqual(out.pwned, []);
  assert.equal(out.items, 3);
});

await browser.close();
server.close();

let failed = 0;
for (const [name, status] of results) {
  if (status !== 'ok') failed += 1;
  console.log(`${status === 'ok' ? 'ok    ' : 'not ok'} ${name}${status === 'ok' ? '' : `\n       ${status}`}`);
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
