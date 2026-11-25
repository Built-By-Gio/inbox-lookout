// Background worker: every 5 minutes read Gmail's feeds, sort what is new, keep the badge and pop-ups current.
import { fetchFeeds } from './feed.js';
import { rules } from './judge.js';
import { learned, teach, tierOf } from './learn.js';

const DAY = 864e5;
const GMAIL = 'https://mail.google.com/';
const BADGE = { background: '#1493A3', text: '#10191C' };

// Every change to stored state goes through here, one at a time, so a click in the popup and a
// check in progress never overwrite each other.
let queue = Promise.resolve();
function update(change) {
  return (queue = queue.then(async () => {
    const state = { items: {}, weights: {}, examples: [], status: {}, ...(await chrome.storage.local.get()) };
    const result = await change(state);
    await chrome.storage.local.set(state);
    const waiting = Object.values(state.items).filter(m => m.tier === 'needs' && !m.done).length;
    chrome.action.setBadgeText({ text: state.status.signedOut ? '!' : waiting ? String(waiting) : '' });
    return result;
  }).catch(e => console.error(e)));
}

// Where an email lands once his past clicks are added to the judge's call.
function place(state, m) {
  m.tier = tierOf(state.weights, m);
  m.lean = Math.sign(Math.trunc(learned(state.weights, m))); // +1 he opens these, -1 he skips these
}

// The on-device model lives in a hidden page because Chrome does not expose it to workers.
// 'DOM_PARSER' is the nearest reason Chrome offers; the justification states the real one.
async function askModel(message) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: "Chrome's on-device language model can only be called from a document, not from the background worker.",
    });
  }
  return chrome.runtime.sendMessage(message);
}

function notify(id, title, message, contextMessage) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/128.png', title, message, ...(contextMessage && { contextMessage }) });
}

let checking = false;
async function check() {
  if (checking) return;
  checking = true;
  try { await sweep(); } catch (e) { console.error(e); } finally { checking = false; }
}

async function sweep() {
  const got = await fetchFeeds();
  if (!got) {
    if (navigator.onLine) await update(s => { s.status.signedOut = true; });
    return;
  }
  const aiOn = (await askModel({ aiReady: true }).catch(() => false)) === true;

  const { todo, examples } = await update(s => {
    const live = new Set(got.mail.map(m => m.id));
    for (const m of got.mail) s.items[m.id] = { ...m, ...s.items[m.id], feeds: m.feeds };
    for (const [id, m] of Object.entries(s.items)) {
      const keepDays = m.tier === 'trash' ? 3 : 30;
      if (!live.has(id) && Date.now() - m.time > keepDays * DAY) delete s.items[id];
    }
    s.status = { lastChecked: Date.now(), unread: got.unread, promos: got.promos, aiOn, signedOut: false };
    const todo = Object.values(s.items).filter(m => !m.call).sort((a, b) => b.time - a.time);
    return { todo, examples: s.examples };
  }) ?? { todo: [] };

  // One email at a time, saved after each, so nothing is lost if Chrome stops the worker midway.
  for (const m of todo) {
    let { settled, ...verdict } = rules(m);
    if (aiOn && !settled) {
      const answer = await askModel({ ai: m, examples }).catch(() => null);
      if (answer?.call) verdict = answer;
    }
    await update(s => {
      const item = s.items[m.id];
      if (item) place(s, Object.assign(item, verdict));
    });
  }

  await update(s => {
    const fresh = Object.values(s.items).filter(m => m.tier === 'needs' && !m.done && !m.told).sort((a, b) => b.time - a.time);
    for (const m of fresh) m.told = true;
    if (fresh.length > 3) {
      notify('summary', `${fresh.length} emails need you`, [...new Set(fresh.map(m => m.from))].slice(0, 5).join(', '));
    } else {
      for (const m of fresh) notify(m.id, m.from, m.subject, m.why);
    }
  });
}

// He opened it or cleared it with "got it": it was useful, and it leaves the list.
function useful(s, id) {
  const m = s.items[id];
  if (!m) return;
  m.done = true;
  s.weights = teach(s.weights, m, +1, false);
  return m;
}

function openMail(id) {
  return update(s => {
    const m = useful(s, id);
    if (m) chrome.tabs.create({ url: m.link.startsWith(GMAIL) ? m.link : GMAIL });
  });
}

// "not needed" (dir -1) or "this matters" (dir +1): learn it, then re-place everything already sorted.
// undo: he took back his last click, so the opposite step cancels it and the example is dropped.
function correct(id, dir, undo) {
  return update(s => {
    const m = s.items[id];
    if (!m) return;
    s.weights = teach(s.weights, m, dir, true);
    // The newest correction per sender is also shown to the model as a worked example.
    const example = { from: m.from, email: m.email, subject: m.subject, snippet: m.snippet, feeds: m.feeds, needed: dir > 0 };
    s.examples = [...(undo ? [] : [example]), ...s.examples.filter(e => e.email !== m.email)].slice(0, 8);
    for (const item of Object.values(s.items)) {
      if (!item.call) continue;
      place(s, item);
      if (item.tier === 'needs') item.told = true; // he is looking at the list right now; no pop-up for these
    }
  });
}

function start() {
  chrome.alarms.create('check', { periodInMinutes: 5 });
  chrome.action.setBadgeBackgroundColor({ color: BADGE.background });
  chrome.action.setBadgeTextColor({ color: BADGE.text });
  check();
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener(check);

chrome.notifications.onClicked.addListener(id => {
  chrome.notifications.clear(id);
  if (id === 'summary') chrome.action.openPopup().catch(() => chrome.tabs.create({ url: 'popup.html' }));
  else openMail(id);
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg.open) openMail(msg.open);
  else if (msg.gotIt) update(s => { useful(s, msg.gotIt); });
  else if (msg.teach) correct(msg.teach, msg.dir, msg.undo);
  else if (msg.check) check();
});
