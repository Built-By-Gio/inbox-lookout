// Runs the real background worker against a stand-in for Chrome's extension API.
import test from 'node:test';
import assert from 'node:assert/strict';

const entry = (id, title, name, email, link = `https://mail.google.com/mail/u/0?message_id=${id}`) =>
  `<entry><title>${title}</title><summary></summary><link rel="alternate" href="${link}" type="text/html"/>
<issued>2026-11-25T1${id % 10}:00:00Z</issued><id>tag:gmail.google.com,2004:${id}</id><author><name>${name}</name><email>${email}</email></author></entry>`;
const feed = (unread, ...entries) => `<feed><fullcount>${unread}</fullcount>${entries.join('')}</feed>`;
const ID = n => `tag:gmail.google.com,2004:${n}`;

// Made-up mail of the usual kinds.
const INBOX = feed(1234,
  entry(1, 'You have a new offer: $40.00 for Vintage Desk Lamp', 'Mercari', 'offers@mercari.com'),
  entry(2, 'Your payout is on its way', 'Mercari', 'offers@mercari.com'),
  entry(3, 'Expected delivery on Friday', 'Parcel Tracking', 'auto-reply@parcel.example'),
  entry(4, 'Thoughts from the founder', 'Acme', 'founder@acme.example'),
  entry(5, 'Security alert', 'Example Account', 'no-reply@accounts.example'));
const PROMOS = feed(900, entry(9, 'Fresh picks for the weekend', 'Store', 'shop@store.example'));

let run = 0;
async function boot(t, { pages = { '': INBOX, '/%5Esq_ig_i_promo': PROMOS }, modelReady = true } = {}) {
  const store = {}, on = {}, seen = { asked: [], notes: [], tabs: [], badge: [] };
  const hook = name => ({ addListener: fn => { on[name] = fn; } });
  globalThis.chrome = {
    storage: { local: { get: async () => structuredClone(store), set: async v => { Object.assign(store, structuredClone(v)); } } },
    action: { setBadgeText: ({ text }) => seen.badge.push(text), setBadgeBackgroundColor() {}, setBadgeTextColor() {}, openPopup: async () => {} },
    alarms: { create: (name, opts) => { seen.alarm = [name, opts.periodInMinutes]; }, onAlarm: hook('alarm') },
    notifications: { create: (id, opts) => seen.notes.push({ id, ...opts }), clear() {}, onClicked: hook('noteClick') },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    tabs: { create: ({ url }) => seen.tabs.push(url) },
    runtime: {
      onInstalled: hook('installed'), onStartup: hook('startup'), onMessage: hook('message'),
      // The model: calls the vague founder email trash, and agrees with the rules on the rest.
      sendMessage: async msg => {
        if (msg.aiReady) return modelReady;
        seen.asked.push(msg.ai.subject);
        return /founder/.test(msg.ai.subject) ? { call: 'trash', why: 'marketing in disguise' } : null;
      },
    },
  };
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
  t.mock.method(globalThis, 'fetch', async url => {
    const page = pages[url.split('/feed/atom')[1]] ?? pages['*'];
    return { ok: page !== undefined, text: async () => page };
  });
  await import(`../background.js?run=${++run}`);
  const settle = () => new Promise(r => setTimeout(r, 30));
  const tiers = () => Object.fromEntries(Object.values(store.items).map(m => [m.id.split(':').pop(), m.tier]));
  return { store, on, seen, settle, tiers };
}

test('first check: reads the feeds, sorts every email, sets the badge and alarm, and pops up each important one newest first', async t => {
  const { store, on, seen, settle, tiers } = await boot(t);
  on.installed();
  await settle();
  assert.deepEqual(seen.alarm, ['check', 5]);
  assert.deepEqual(tiers(), { 1: 'needs', 2: 'needs', 3: 'fyi', 4: 'trash', 5: 'needs', 9: 'trash' });
  assert.equal(store.items[ID(4)].why, 'marketing in disguise', 'the model overrides the rules where it answers');
  assert.ok(!seen.asked.includes('Fresh picks for the weekend'), 'promotions are never sent to the model');
  assert.equal(seen.badge.at(-1), '3');
  assert.deepEqual(store.status, { lastChecked: store.status.lastChecked, unread: 1234, promos: 900, aiOn: true, signedOut: false });
  assert.deepEqual(seen.notes.map(n => [n.id, n.title, n.message]), [
    [ID(5), 'Example Account', 'Security alert'],
    [ID(2), 'Mercari', 'Your payout is on its way'],
    [ID(1), 'Mercari', 'You have a new offer: $40.00 for Vintage Desk Lamp'],
  ]);
});

test('a second check asks the model nothing new and repeats no pop-up', async t => {
  const { on, seen, settle } = await boot(t);
  on.installed();
  await settle();
  const asked = seen.asked.length, notes = seen.notes.length;
  await on.alarm();
  await settle();
  assert.equal(seen.asked.length, asked);
  assert.equal(seen.notes.length, notes);
});

test('more than three new important emails become one summary pop-up', async t => {
  const many = feed(4, ...[1, 2, 3, 4].map(n => entry(n, 'Security alert', `Bank ${n}`, `alerts@bank${n}.example`)));
  const { on, seen, settle } = await boot(t, { pages: { '': many } });
  on.installed();
  await settle();
  assert.deepEqual(seen.notes.map(n => [n.id, n.title]), [['summary', '4 emails need you']]);
});

test('model unavailable: the rules decide and the status says so', async t => {
  const { store, on, seen, settle, tiers } = await boot(t, { modelReady: false });
  on.installed();
  await settle();
  assert.equal(store.status.aiOn, false);
  assert.equal(seen.asked.length, 0);
  assert.equal(tiers()[1], 'needs');
});

test('signed out of Gmail: badge shows "!" and nothing is sorted', async t => {
  const { store, on, seen, settle } = await boot(t, { pages: { '*': '<html>Sign in</html>' } });
  on.installed();
  await settle();
  assert.equal(store.status.signedOut, true);
  assert.equal(seen.badge.at(-1), '!');
  assert.deepEqual(store.items, {});
});

test('"not needed" sends every email from that sender to trash; undo puts them back', async t => {
  const { store, on, seen, settle, tiers } = await boot(t);
  on.installed();
  await settle();
  on.message({ teach: ID(1), dir: -1 });
  await settle();
  assert.deepEqual([tiers()[1], tiers()[2], tiers()[5]], ['trash', 'trash', 'needs']);
  assert.equal(seen.badge.at(-1), '1');
  assert.deepEqual(store.examples.map(e => [e.email, e.needed]), [['offers@mercari.com', false]]);
  on.message({ teach: ID(1), dir: +1, undo: true });
  await settle();
  assert.deepEqual([tiers()[1], tiers()[2]], ['needs', 'needs']);
  assert.deepEqual(store.examples, []);
  assert.equal(store.weights['from:offers@mercari.com'], 0);
});

test('"this matters" lifts a trashed sender into Needs you without a pop-up', async t => {
  const { store, on, seen, settle, tiers } = await boot(t);
  on.installed();
  await settle();
  const notes = seen.notes.length;
  on.message({ teach: ID(4), dir: +1 });
  await settle();
  assert.equal(tiers()[4], 'needs');
  assert.equal(store.items[ID(4)].lean, 1);
  await on.alarm();
  await settle();
  assert.equal(seen.notes.length, notes);
});

test('opening an email opens Gmail, clears it from the list and counts as useful', async t => {
  const evil = feed(1, entry(7, 'Security alert', 'Bank', 'alerts@bank.example', 'https://evil.example/phish'));
  const { store, on, seen, settle } = await boot(t, { pages: { '': evil } });
  on.installed();
  await settle();
  on.noteClick(ID(7));
  await settle();
  assert.deepEqual(seen.tabs, ['https://mail.google.com/'], 'a link that is not Gmail is never opened');
  assert.equal(store.items[ID(7)].done, true);
  assert.equal(store.weights['from:alerts@bank.example'], 1);
  assert.equal(seen.badge.at(-1), '');
});

test('"got it" clears the email without opening anything', async t => {
  const { store, on, seen, settle } = await boot(t);
  on.installed();
  await settle();
  on.message({ gotIt: ID(5) });
  await settle();
  assert.equal(store.items[ID(5)].done, true);
  assert.deepEqual(seen.tabs, []);
  assert.equal(seen.badge.at(-1), '2');
});
