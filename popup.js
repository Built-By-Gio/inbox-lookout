// Popup: draws what the background worker has stored and sends his clicks back to it.
// Everything that came from an email is written with textContent, never as HTML.
const GMAIL = 'https://mail.google.com/';
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const send = msg => chrome.runtime.sendMessage(msg).catch(() => {});
const $ = id => document.getElementById(id);
const num = n => (n ?? 0).toLocaleString('en-US');

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// What only the popup knows: how it is being looked at right now.
let expanded = false;   // trash pile open
let notice = null;      // { id, from, kind, at } after "Not needed", until his next click
let rescued = null;     // id just lifted out of the trash, to turn face-up when it arrives
let dropped = false;    // an email just went to the pile
let toggled = false;    // the pile was just opened
let lastChecked;

// ---- motion: a card seen edge-on is a line; turned 90 degrees it is a card ----
function reveal(mark, slow = 1) {
  const slab = mark.querySelector('.slab'), band = mark.querySelector('.band');
  if (calm) return anime({ targets: band, opacity: [0, 1], duration: 120, easing: 'linear' });
  anime.set(slab, { translateY: '18%', rotateY: 90, rotateZ: 0 });
  anime.set(band, { scaleX: 0 });
  anime.timeline({ easing: 'easeOutQuad' })
    .add({ targets: mark.querySelectorAll('.bars line'), strokeDashoffset: [anime.setDashoffset, 0], duration: 140 * slow, delay: anime.stagger(12 * slow) }, 0)
    .add({ targets: slab, translateY: '0%', rotateY: 0, rotateZ: -7, duration: 400 * slow, easing: 'cubicBezier(.2,.8,.2,1.1)' }, 120 * slow)
    .add({ targets: band, scaleX: 1, duration: 180 * slow }, 440 * slow);
}

function turnAway(row) {
  row.inert = true;
  if (calm) return Promise.resolve();
  return anime.timeline({ targets: row })
    .add({ rotateX: [0, -88], duration: 160, easing: 'easeInQuad' })
    .add({ height: 0, paddingTop: 0, paddingBottom: 0, duration: 140, easing: 'easeOutQuad' }).finished;
}

const turnUp = (rows, each = 180, stagger = 0) =>
  calm || anime({ targets: rows, rotateX: [-88, 0], duration: each, delay: anime.stagger(stagger), easing: 'easeOutQuad' });

const riffle = (edges, loop = false) =>
  calm || anime({ targets: edges, translateY: [{ value: -4 }, { value: 0 }], duration: 260, delay: anime.stagger(12), easing: 'easeInOutQuad', loop, endDelay: loop ? 500 : 0 });

// ---- pieces ----
function age(time) {
  const min = Math.max(0, (Date.now() - time) / 6e4);
  if (min < 1) return ['Now', ''];
  if (min < 60) return [Math.floor(min), 'min'];
  if (min < 1440) return [Math.floor(min / 60), 'hr'];
  if (min < 20160) return [Math.floor(min / 1440), 'day'];
  return [Math.floor(min / 10080), 'wk'];
}

const CONTROLS = {
  needs: [['skip', 'Not needed', 'text'], ['gotit', 'Got it', 'box']],
  fyi: [['skip', 'Not needed', 'text'], ['gotit', 'Got it', 'text']],
  trash: [['matters', 'This matters', 'box']],
};

function row(m, kind) {
  const li = el('li', 'row');
  li.dataset.id = m.id;
  const open = el('a', 'open');
  open.href = m.link?.startsWith(GMAIL) ? m.link : GMAIL;
  open.title = m.subject;
  open.append(el('span', 'from', m.from || m.email), el('span', 'subj', m.subject || '(no subject)'));
  const [n, unit] = age(m.time);
  const when = el('span', 'age');
  when.append(el('b', unit ? '' : 'now', n), el('i', '', unit));
  const reason = [m.why, m.lean > 0 ? 'you open these' : m.lean < 0 ? 'you skip these' : ''].filter(Boolean).join(' · ');
  const why = el('span', 'why', reason);
  why.title = reason;
  const acts = el('span', 'acts');
  for (const [act, label, cls] of CONTROLS[kind]) {
    const button = el('button', cls, label);
    button.type = 'button';
    button.dataset.act = act;
    acts.append(button);
  }
  const foot = el('span', 'foot');
  foot.append(why, acts);
  li.append(open, when, foot);
  return li;
}

function list(kind, mails) {
  const ul = el('ul', `rows ${kind}`);
  ul.dataset.kind = kind;
  const rows = mails.map(m => row(m, kind));
  if (notice?.kind === kind) {
    const li = el('li', 'notice');
    const undo = el('button', 'text', 'Undo');
    undo.type = 'button';
    undo.dataset.act = 'undo';
    li.append(el('span', '', `${notice.from} goes to the trash pile from now on.`), undo);
    rows.splice(Math.min(notice.at, rows.length), 0, li);
  }
  ul.append(...rows);
  return ul;
}

function heading(text, count) {
  const h = el('h2', '', text);
  if (count != null) h.append(el('span', '', count));
  return h;
}

const HEIGHTS = [28, 26, 30, 27, 29, 26, 30, 28, 27, 29, 26, 28, 30, 27];
function fillPile(stack, count, scale = 1) {
  // Edge count grows with the logarithm of the real count: 10,000 emails draws 52 edges.
  const edges = Math.min(Math.floor(stack.clientWidth / 4), Math.round(13 * Math.log10(count + 1)));
  stack.replaceChildren(...Array.from({ length: edges }, (_, i) => {
    const edge = el('i', 'edge');
    edge.style.height = `${HEIGHTS[i % HEIGHTS.length] * scale}px`;
    return edge;
  }));
}

function pileButton(count) {
  const button = el('button', 'pilebtn');
  button.type = 'button';
  button.dataset.act = 'pile';
  button.disabled = !count;
  button.setAttribute('aria-expanded', expanded);
  const stack = el('span', expanded ? 'pile lean' : 'pile');
  stack.setAttribute('aria-hidden', 'true');
  const info = el('span', 'pileinfo');
  info.append(el('span', 'count', num(count)), el('span', 'cap', 'Trash pile'));
  if (count) info.append(el('span', 'show', expanded ? 'Hide' : 'Show'));
  button.append(stack, info);
  return button;
}

function signedOut() {
  const panel = el('p', 'panel', 'Gmail is signed out in this browser, so nothing is being checked.');
  panel.append(el('small', '', 'Checking starts again on its own within 5 minutes of signing in.'));
  const button = el('button', 'wide', 'Open Gmail and sign in');
  button.type = 'button';
  button.dataset.act = 'signin';
  return [panel, button];
}

// One node kept across redraws, so its riffle keeps running while mail is being sorted.
const sorting = el('section', 'sorting');
{
  const top = el('div', 'top');
  const big = $('mark').cloneNode(true);
  big.removeAttribute('id');
  big.classList.add('big');
  top.append(big, el('span', 'pile'));
  sorting.append(top, el('p', '', 'Reading your newest unread mail on this PC. Nothing in Gmail gets changed or deleted. About a minute.'));
}

// ---- draw ----
function render({ items = {}, status = {} }) {
  const live = Object.values(items).filter(m => !m.done).sort((a, b) => b.time - a.time);
  const tier = name => live.filter(m => m.tier === name);
  const needs = tier('needs'), fyi = tier('fyi'), trash = tier('trash');
  const pile = (status.promos ?? 0) + trash.filter(m => !m.feeds?.includes('promo')).length;
  const isSorting = !status.signedOut && (!status.lastChecked || live.filter(m => !m.call).length > 5);
  const checked = status.lastChecked && new Date(status.lastChecked).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  $('cap').textContent = status.signedOut ? 'Signed out' : isSorting ? 'Sorting' : needs.length === 1 ? 'Needs you' : 'Need you';
  $('num').textContent = status.signedOut ? '' : needs.length;
  $('num').classList.toggle('wide', needs.length > 99);
  $('tally').textContent = status.signedOut ? 'Nothing is being checked.'
    : !status.lastChecked ? 'Reading your inbox for the first time.'
    : `${num(fyi.length)} FYI · ${num(pile)} in the trash pile`;
  $('spoken').textContent = status.signedOut ? 'Signed out of Gmail. Nothing is being checked.'
    : `${needs.length} need you, ${fyi.length} FYI, ${num(pile)} in the trash pile.${isSorting ? ' Still sorting.' : ''}`;

  const parts = [];
  if (status.signedOut) parts.push(...signedOut());
  else {
    if (isSorting) parts.push(sorting);
    if (needs.length || notice?.kind === 'needs') parts.push(heading('Needs you'), list('needs', needs));
    else if (!isSorting) {
      const sleeve = el('p', 'sleeve');
      sleeve.append(el('b', '', 'Nothing needs you.'), el('span', '', 'Gmail can stay closed.'));
      parts.push(heading('Needs you'), sleeve);
    }
    if (fyi.length || notice?.kind === 'fyi') parts.push(heading('FYI', fyi.length), list('fyi', fyi));
    if (status.lastChecked) parts.push(pileButton(pile)); // before the first check there is no count to draw
    if (expanded && pile) {
      const shown = trash.slice(0, 10);
      const box = list('trash', shown);
      box.append(el('li', 'closing', `Newest ${shown.length} of ${num(pile)} shown.`));
      parts.push(box);
    }
  }

  // Redraw, keeping his place: scroll position and keyboard focus.
  const main = $('main'), scroll = main.scrollTop, focus = document.activeElement;
  const focusOn = focus?.dataset?.act && [focus.closest('.row')?.dataset.id, focus.dataset.act];
  const wasSorting = sorting.isConnected;
  main.replaceChildren(...parts);
  main.scrollTop = scroll;
  if (focusOn) [...main.querySelectorAll(`[data-act="${focusOn[1]}"]`)].find(b => b.closest('.row')?.dataset.id === focusOn[0])?.focus();

  const stack = main.querySelector('.pilebtn .pile');
  if (stack) fillPile(stack, pile);
  const edges = stack ? [...stack.children] : [];

  if (isSorting && !wasSorting) {
    const tall = sorting.querySelector('.pile');
    fillPile(tall, pile || 1000, 1.6);
    reveal(sorting.querySelector('.mark'), 2);
    riffle([...tall.children], true);
  }
  if (!isSorting && wasSorting) anime.remove(sorting.querySelectorAll('.edge'));

  if (rescued) {
    const back = [...main.querySelectorAll('.row')].find(r => r.dataset.id === rescued);
    if (back && !calm) {
      turnUp(back);
      if (back.closest('.needs')) anime({ targets: back, backgroundColor: ['#DCEEF0', '#FBFAF5'], duration: 400, easing: 'linear', complete: () => { back.style.backgroundColor = ''; } });
    }
    rescued = null;
  }
  if (dropped && edges.length && !calm) anime({ targets: edges.at(-1), translateY: [-12, 0], duration: 180, easing: 'easeOutQuad' });
  dropped = false;
  if (toggled && expanded && !calm) {
    anime({ targets: edges, skewX: [0, -10], duration: 220, easing: 'easeOutQuad' });
    turnUp(main.querySelectorAll('.trash .row'), 140, 22);
  }
  toggled = false;
  if (lastChecked && status.lastChecked !== lastChecked && !expanded) riffle(edges);
  lastChecked = status.lastChecked;

  const foot = $('foot');
  if (status.signedOut) foot.textContent = checked ? `Last checked ${checked} · signed out` : 'Not checked yet · signed out';
  else if (!checked) foot.textContent = 'First check in progress';
  else {
    foot.textContent = `Checked ${checked} · ${num(status.unread)} unread in Gmail · `;
    foot.append(el('span', status.aiOn ? 'ai on' : 'ai', `AI on this PC: ${status.aiOn ? 'on' : 'off'}`));
  }
  return status;
}

// Redraw from storage. A change that lands mid-draw triggers one more draw instead of being lost.
let drawing = false, again = false;
async function refresh() {
  if (drawing) { again = true; return; }
  drawing = true;
  let status;
  do {
    again = false;
    status = render(await chrome.storage.local.get());
  } while (again);
  drawing = false;
  return status;
}

// ---- his clicks ----
document.addEventListener('click', async e => {
  const target = e.target.closest('a.open, button');
  if (!target) return;
  const li = target.closest('.row');
  const id = li?.dataset.id;
  const act = target.dataset.act ?? 'open';
  if (act === 'open') e.preventDefault(); // the worker opens the tab, so the click is also learned from
  const undoable = notice;
  notice = null; // the undo offer lasts until his next click

  if (act === 'open') send({ open: id });
  else if (act === 'gotit') { await turnAway(li); send({ gotIt: id }); }
  else if (act === 'skip') {
    notice = { id, from: li.querySelector('.from').textContent, kind: li.parentElement.dataset.kind, at: [...li.parentElement.children].indexOf(li) };
    dropped = true;
    await turnAway(li);
    send({ teach: id, dir: -1 });
  } else if (act === 'matters') {
    rescued = id;
    const top = document.querySelector('.pilebtn .edge:last-child');
    if (top && !calm) anime({ targets: top, translateY: -10, opacity: 0, duration: 160, easing: 'easeOutQuad' });
    await turnAway(li);
    send({ teach: id, dir: +1 });
  } else if (act === 'undo' && undoable) {
    rescued = undoable.id;
    send({ teach: undoable.id, dir: +1, undo: true });
  } else if (act === 'pile') {
    if (expanded && !calm) await anime({ targets: '.trash > li', rotateX: -88, duration: 160, easing: 'easeInQuad' }).finished;
    expanded = !expanded;
    toggled = true;
    refresh();
  } else if (act === 'signin') chrome.tabs.create({ url: GMAIL });
});

chrome.storage.onChanged.addListener(refresh);
reveal($('mark'));
refresh().then(status => {
  // Ask for a check now if the last one is stale or Gmail was signed out; otherwise the 5-minute alarm is enough.
  if (status.signedOut || !status.lastChecked || Date.now() - status.lastChecked > 5 * 6e4) send({ check: true });
});
