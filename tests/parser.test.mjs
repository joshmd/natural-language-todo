import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput } from '../natural-language-todo-card.js';

// Thursday 24 September 2026, 10:00 local time.
const NOW = new Date(2026, 8, 24, 10, 0);

const PLAIN = { dates: true, times: true };
const DATE_ONLY = { dates: true, times: false };
const TODOIST = { dates: true, times: true, recurrence: true, labels: true, priority: true };
const NOTHING = {};

const parse = (raw, caps = PLAIN, extra = {}) =>
  parseInput(raw, { capsFor: () => caps, now: NOW, dayFirst: true, ...extra });

const due = (raw, caps, extra) => {
  const p = parse(raw, caps, extra);
  return [p.text, p.due && p.due.date, p.due && p.due.time];
};

test('relative days', () => {
  assert.deepEqual(due('milk today'), ['milk', '2026-09-24', null]);
  assert.deepEqual(due('milk tonight'), ['milk', '2026-09-24', null]);
  assert.deepEqual(due('milk tomorrow'), ['milk', '2026-09-25', null]);
  assert.deepEqual(due('milk tmrw'), ['milk', '2026-09-25', null]);
  assert.deepEqual(due('filter in 3 days'), ['filter', '2026-09-27', null]);
  assert.deepEqual(due('filter in two weeks'), ['filter', '2026-10-08', null]);
  assert.deepEqual(due('filter in a month'), ['filter', '2026-10-24', null]);
});

test('weekdays', () => {
  assert.deepEqual(due('bins thursday'), ['bins', '2026-09-24', null], 'same weekday is today');
  assert.deepEqual(due('bins friday'), ['bins', '2026-09-25', null]);
  assert.deepEqual(due('bins on monday'), ['bins', '2026-09-28', null]);
  assert.deepEqual(due('bins next friday'), ['bins', '2026-10-02', null], 'next week');
  assert.deepEqual(due('bins next week'), ['bins', '2026-09-28', null]);
  assert.deepEqual(due('bins weekend'), ['bins', '2026-09-26', null]);
});

test('short weekday names only count at the end', () => {
  assert.deepEqual(due('sun cream'), ['sun cream', null, null]);
  assert.deepEqual(due('sat nav charger'), ['sat nav charger', null, null]);
  assert.deepEqual(due('bin bags fri'), ['bin bags', '2026-09-25', null]);
  assert.deepEqual(due('bin bags fri 7pm'), ['bin bags', '2026-09-25', '19:00']);
});

test('dates', () => {
  assert.deepEqual(due('card 25 dec'), ['card', '2026-12-25', null]);
  assert.deepEqual(due('card December 25th'), ['card', '2026-12-25', null]);
  assert.deepEqual(due('card 1 jan'), ['card', '2027-01-01', null], 'past date rolls to next year');
  assert.deepEqual(due('card 3 march 2027'), ['card', '2027-03-03', null]);
  assert.deepEqual(due('card 2026-10-05'), ['card', '2026-10-05', null]);
  assert.deepEqual(due('card 25/12'), ['card', '2026-12-25', null]);
  assert.deepEqual(due('card 12/25', PLAIN, { dayFirst: false }), ['card', '2026-12-25', null]);
  assert.deepEqual(due('card 31/02'), ['card 31/02', null, null], 'invalid date stays as text');
  assert.deepEqual(due('flour 1/2 kg'), ['flour 1/2 kg', null, null], 'fractions are not dates');
});

test('times', () => {
  assert.deepEqual(due('milk tomorrow 5pm'), ['milk', '2026-09-25', '17:00']);
  assert.deepEqual(due('milk tomorrow at 5:30pm'), ['milk', '2026-09-25', '17:30']);
  assert.deepEqual(due('call at 17:45'), ['call', '2026-09-24', '17:45'], 'later today');
  assert.deepEqual(due('call 9am'), ['call', '2026-09-25', '09:00'], 'already passed, so tomorrow');
  assert.deepEqual(due('lunch noon friday'), ['lunch', '2026-09-25', '12:00']);
  assert.deepEqual(due('call 13pm'), ['call 13pm', null, null]);
});

test('only parses what the list can store', () => {
  assert.deepEqual(due('milk tomorrow 5pm', DATE_ONLY), ['milk 5pm', '2026-09-25', null]);
  assert.deepEqual(due('milk tomorrow 5pm', NOTHING), ['milk tomorrow 5pm', null, null]);
  const p = parse('water plants every monday');
  assert.equal(p.text, 'water plants every monday');
  assert.equal(p.due, null);
  assert.equal(p.recurrenceUnsupported, true);
});

test('quoted text is never parsed', () => {
  assert.deepEqual(due('"sun cream" tomorrow'), ['sun cream', '2026-09-25', null]);
  assert.deepEqual(due('"back to the future" friday'), ['back to the future', '2026-09-25', null]);
  assert.deepEqual(due('"see you tomorrow" card'), ['see you tomorrow card', null, null]);
});

test('ordinary words are left alone', () => {
  for (const s of ['2 eggs', 'may contain nuts', 'cat food', 'marshmallows', 'monday blues album', 'in the morning', '7up']) {
    const [text, date] = due(s);
    if (s === 'monday blues album') {
      assert.equal(date, '2026-09-28'); // a full weekday name is a date wherever it is
      continue;
    }
    assert.equal(text, s, s);
    assert.equal(date, null, s);
  }
});

test('Todoist mode: labels, priority, recurrence and the due string', () => {
  const p = parse('bin bags fri 7pm @home p1', TODOIST);
  assert.equal(p.text, 'bin bags');
  assert.deepEqual(p.labels, ['home']);
  assert.equal(p.priority, 1);
  assert.equal(p.dueString, 'fri 7pm');

  const r = parse('water filter every 2 months', TODOIST);
  assert.equal(r.text, 'water filter');
  assert.equal(r.recurrence, 'every 2 months');
  assert.equal(r.dueString, 'every 2 months');
  assert.equal(r.due, null);

  const plain = parse('email @work p2', PLAIN);
  assert.equal(plain.text, 'email @work p2', 'labels and priority only for Todoist');
});

test('sections: match mode', () => {
  const sections = [
    { key: 's1', name: 'Kitchen' },
    { key: 's2', name: 'Kitchen stuff' },
    { key: 's3', name: 'Bakery' },
  ];
  const opts = { sectionMode: 'match', sections };
  let p = parse('bread /Bakery tomorrow', PLAIN, opts);
  assert.equal(p.text, 'bread');
  assert.equal(p.section.key, 's3');
  assert.equal(p.due.date, '2026-09-25');

  p = parse('sponges /kitchen stuff', PLAIN, opts);
  assert.equal(p.section.key, 's2', 'longest name wins');
  assert.equal(p.text, 'sponges');

  p = parse('sponges /"kitchen"', PLAIN, opts);
  assert.equal(p.section.key, 's1');

  p = parse('glue /Garage', PLAIN, opts);
  assert.equal(p.section, null);
  assert.equal(p.unmatched, 'Garage');
  assert.equal(p.text, 'glue');

  p = parse('rent 1/2 paid', PLAIN, opts);
  assert.equal(p.unmatched, null, 'a slash inside a word is not a section');
});

test('sections: free mode and none', () => {
  let p = parse('milk /Aldi tomorrow', TODOIST, { sectionMode: 'free' });
  assert.deepEqual([p.text, p.section.name, p.section.key], ['milk', 'Aldi', null]);
  p = parse('milk /"Corner shop" tomorrow', TODOIST, { sectionMode: 'free' });
  assert.equal(p.section.name, 'Corner shop');
  assert.equal(p.text, 'milk');
  p = parse('milk /Aldi', PLAIN, { sectionMode: 'none' });
  assert.equal(p.text, 'milk /Aldi');
});

test('caps can depend on the chosen section', () => {
  const sections = [{ key: 'todo.a', name: 'Dates' }, { key: 'todo.b', name: 'Plain' }];
  const capsFor = (s) => (s && s.key === 'todo.a' ? PLAIN : NOTHING);
  const a = parseInput('x tomorrow /Dates', { sectionMode: 'match', sections, capsFor, now: NOW });
  const b = parseInput('x tomorrow /Plain', { sectionMode: 'match', sections, capsFor, now: NOW });
  assert.equal(a.due.date, '2026-09-25');
  assert.equal(b.due, null);
  assert.equal(b.text, 'x tomorrow');
});

test('odd input', () => {
  assert.equal(parse('').text, '');
  assert.equal(parse('   ').text, '');
  assert.equal(parse('tomorrow').text, '');
  assert.equal(parse('<img src=x onerror=alert(1)> tomorrow').text, '<img src=x onerror=alert(1)>');
});
