import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, fetchFeeds } from '../feed.js';
import { rules } from '../judge.js';
import { teach, tierOf } from '../learn.js';

// Same shape as Gmail's real feed (checked 2026-11-25). The people and items are made up.
const entry = (id, title, name, email) => `<entry><title>${title}</title><summary>Preview &amp; more</summary>
<link rel="alternate" href="https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=${id}&amp;view=conv&amp;extsrc=atom" type="text/html"/>
<modified>2026-11-25T22:00:00Z</modified><issued>2026-11-25T22:00:00Z</issued><id>tag:gmail.google.com,2004:${id}</id>
<author><name>${name}</name><email>${email}</email></author></entry>`;
const feed = (unread, ...entries) => `<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#">
<title>Gmail - Inbox for me@example.com</title><tagline>New messages</tagline><fullcount>${unread}</fullcount>
<link rel="alternate" href="https://mail.google.com/mail/u/0" type="text/html"/><modified>2026-11-25T22:00:00Z</modified>${entries.join('')}</feed>`;

test('parseFeed reads Gmail feed entries and decodes entities once', () => {
  const got = parseFeed(feed(1234, entry('111', 'Tom &amp; Co: it&#39;s &amp;lt;here&amp;gt;', 'Tom &amp; Co', 'tom@example.com')));
  assert.equal(got.unread, 1234);
  assert.deepEqual(got.entries[0], {
    id: 'tag:gmail.google.com,2004:111',
    subject: "Tom & Co: it's &lt;here&gt;",
    snippet: 'Preview & more',
    link: 'https://mail.google.com/mail/u/0?account_id=me@example.com&message_id=111&view=conv&extsrc=atom',
    time: Date.parse('2026-11-25T22:00:00Z'),
    from: 'Tom & Co',
    email: 'tom@example.com',
  });
});

test('parseFeed returns null for a sign-in page, and an empty feed has no entries', () => {
  assert.equal(parseFeed('<html><body>Sign in</body></html>'), null);
  assert.deepEqual(parseFeed(feed(0)), { unread: 0, entries: [] });
});

test('fetchFeeds merges the feeds and records which ones each email was in', async t => {
  const pages = { '': feed(3, entry('1', 'A', 'A', 'a@example.com'), entry('2', 'B', 'B', 'b@example.com')), '/%5Esq_ig_i_promo': feed(9, entry('2', 'B', 'B', 'b@example.com')) };
  t.mock.method(globalThis, 'fetch', async url => {
    const page = pages[url.split('/feed/atom')[1]];
    return { ok: page !== undefined, text: async () => page };
  });
  const got = await fetchFeeds();
  assert.equal(got.unread, 3);
  assert.equal(got.promos, 9);
  assert.deepEqual(got.mail.map(m => [m.subject, m.feeds]), [['A', ['inbox']], ['B', ['inbox', 'promo']]]);
});

test('fetchFeeds returns null when Gmail answers with a sign-in page', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => '<html>Sign in</html>' }));
  assert.equal(await fetchFeeds(), null);
});

// Invented subject lines covering the kinds of mail the rules have to sort.
const CASES = [
  ['needs', 'offers@mercari.com', 'Mercari', 'You have a new offer: $40.00 for Vintage Desk Lamp (987654321)'],
  ['needs', 'payments@etsy.com', 'Etsy', 'Your payout is on its way'],
  ['needs', 'offers@poshmark.com', 'Poshmark', 'Buyer sent a new offer: $25.00 for Board Game Bundle'],
  ['needs', 'jobs@hiring.example', 'Hiring Portal', '[Example Cafe Co] Job Application Update'],
  ['needs', 'awards@foundation.example', 'Community Foundation', 'Your scholarship application status'],
  ['needs', 'no-reply@accounts.example', 'Example Account', 'Security alert: new sign-in on Windows'],
  ['needs', 'noreply@cloudstorage.example', 'Cloud Storage', 'A new OAuth application was added to your account'],
  ['needs', 'sam.example@gmail.com', 'Sam Example', 'quick question about the lamp'],
  ['fyi', 'auto-reply@parcel.example', 'Parcel Tracking', 'Expected delivery on Friday'],
  ['fyi', 'messages@facebookmail.com', 'Facebook', 'Sam Example sent you a message'],
  ['trash', 'info@gadgetshop.example', 'Gadget Shop', 'Back in stock, then sold out again'],
  ['trash', 'gardenletter@substack.com', 'Garden Letter', 'A houseplant came back after ten years. Here is how.'],
  ['trash', 'rewards@email-grandhotels.example', 'Grand Hotels Rewards', 'Members save more this winter: double bonus points'],
  ['trash', 'news@etsy.com', 'Etsy', 'Exclusive offer: $10 off your next purchase'],
  ['trash', 'info@teashop.example', 'Tea Shop', 'Cyber Monday starts now'],
  ['trash', 'news@laptopmaker.example', 'Laptop Maker', 'Limited-time trade-in offer ends soon.'],
  ['trash', 'noreply@readingapp.example', 'Reading App Daily Digest', 'What 10 Years of Baking Taught Me'],
  ['trash', 'hello@mealkit.example', 'Meal Kit', 'This week\'s menu sold out'],
  ['trash', 'info@budgetapp.example', 'Budget App', 'A new way to spend your Budget App payout'],
  ['trash', 'auth@club.example', 'Club', '123-456 is your Club login code'],
  ['trash', 'news-noreply@assistant.example', 'Assistant App', 'Finally start the project you keep putting off'],
];

test('fallback rules sort typical subject lines the way he would', () => {
  for (const [want, email, from, subject] of CASES) {
    assert.equal(rules({ email, from, subject, snippet: '', feeds: ['inbox'] }).call, want, `${from}: ${subject}`);
  }
});

test('rules: Promotions, social noise and login codes are settled without the model; everything else is its call', () => {
  const promo = { email: 'shop@store.example', from: 'Store', snippet: '', feeds: ['promo'] };
  const social = { email: 'notification@facebookmail.com', from: 'Facebook', snippet: '', feeds: ['social'] };
  const pick = m => { const { call, settled } = rules(m); return [call, settled]; };
  assert.deepEqual(pick({ ...promo, subject: 'Fresh picks for the weekend' }), ['trash', true]);
  assert.deepEqual(pick({ ...promo, email: 'talent@company.example', subject: 'Interview availability for Thursday' }), ['needs', false]);
  assert.deepEqual(pick({ ...social, subject: 'Sam Example commented on a post' }), ['trash', true]);
  assert.deepEqual(pick({ ...social, subject: 'Sam Example sent you a message' }), ['fyi', false]);
  assert.deepEqual(pick({ email: 'auth@club.example', from: 'Club', snippet: '', feeds: ['primary'], subject: '123-456 is your login code' }), ['trash', true]);
  assert.deepEqual(pick({ email: 'payments@etsy.com', from: 'Etsy', snippet: '', feeds: ['primary'], subject: 'Your payout is on its way' }), ['needs', false]);
});

const offer = { email: 'offers@mercari.com', subject: 'You have a new offer: $40.00 for Vintage Desk Lamp', call: 'needs' };

test('learning: with nothing learned, the judge\'s call stands', () => {
  for (const call of ['needs', 'fyi', 'trash']) assert.equal(tierOf({}, { ...offer, call }), call);
});

test('learning: one "not needed" click sends that sender to trash, even when the judge says needs', () => {
  const w = teach({}, offer, -1, true);
  assert.equal(tierOf(w, { ...offer, subject: 'A completely different subject' }), 'trash');
});

test('learning: one "this matters" click makes that sender always show, even when the judge says trash', () => {
  const junk = { email: 'coach@club.example', subject: 'Schedule change', call: 'trash' };
  const w = teach({}, junk, +1, true);
  assert.equal(tierOf(w, { ...junk, subject: 'Something else entirely' }), 'needs');
});

test('learning: three "not needed" clicks on similar mail lower a brand-new sender of that kind by one tier', () => {
  let w = {};
  for (const email of ['a@hotel.example', 'b@airline.example', 'c@store.example']) {
    w = teach(w, { email, subject: 'Earn bonus points on this exclusive reward', call: 'fyi' }, -1, true);
  }
  const fresh = { email: 'd@new-sender.example', subject: 'Bonus points reward inside' };
  assert.equal(tierOf(w, { ...fresh, call: 'needs' }), 'fyi');
  assert.equal(tierOf(w, { ...fresh, call: 'fyi' }), 'trash');
  assert.equal(tierOf(w, { email: 'e@other.example', subject: 'Unrelated topic', call: 'needs' }), 'needs');
});

test('learning: opening mail is a weak signal and words alone never move mail two tiers', () => {
  let w = {};
  for (let i = 0; i < 40; i++) w = teach(w, { ...offer, email: `seller${i}@market.example` }, +1, false);
  assert.equal(tierOf(w, { email: 'promo@shop.example', subject: 'New offer vintage lamp', call: 'trash' }), 'fyi');
});
