// Reads Gmail's Atom feeds with the browser's own sign-in. Read-only: nothing in Gmail is changed.
// ponytail: each feed returns only the 20 newest unread, so several are polled to reach further back.
// If mail still gets missed, replace fetchFeeds() with the Gmail API; nothing else needs to change.
const BASE = 'https://mail.google.com/mail/u/0/feed/atom';
const FEEDS = {
  inbox: '',
  primary: '/%5Esq_ig_i_personal',
  important: '/%5Eiim',
  receipt: '/%5Esmartlabel_receipt',
  social: '/%5Esq_ig_i_social',
  promo: '/%5Esq_ig_i_promo',
};

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e) => {
  if (e[0] !== '#') return ENTITY[e] ?? whole;
  const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : +e.slice(1);
  return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});
const raw = (xml, name) => (xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || '';
const text = (xml, name) => decode(raw(xml, name)).trim();

// Returns { unread, entries } or null when the response is not a feed (for example Google's sign-in page).
export function parseFeed(xml) {
  if (!xml.includes('<feed')) return null;
  const [head, ...entries] = xml.split('<entry>');
  return {
    unread: +text(head, 'fullcount') || 0,
    entries: entries.map(e => {
      const author = raw(e, 'author');
      return {
        id: text(e, 'id'),
        subject: text(e, 'title'),
        snippet: text(e, 'summary'),
        link: decode((e.match(/<link[^>]*href="([^"]*)"/) || [])[1] || ''),
        time: Date.parse(text(e, 'issued')) || Date.now(),
        from: text(author, 'name'),
        email: text(author, 'email'),
      };
    }),
  };
}

// Returns { unread, promos, mail } with each email listing the feeds it appeared in,
// or null when Gmail cannot be read (signed out, or offline).
export async function fetchFeeds() {
  const got = await Promise.all(Object.entries(FEEDS).map(async ([name, path]) => {
    try {
      const res = await fetch(BASE + path, { credentials: 'include' });
      return [name, res.ok ? parseFeed(await res.text()) : null];
    } catch {
      return [name, null];
    }
  }));
  const feeds = Object.fromEntries(got);
  if (!feeds.inbox) return null;
  const mail = new Map();
  for (const [name, feed] of got) {
    for (const entry of feed?.entries ?? []) {
      const m = mail.get(entry.id) ?? { ...entry, feeds: [] };
      m.feeds.push(name);
      mail.set(entry.id, m);
    }
  }
  return { unread: feeds.inbox.unread, promos: feeds.promo?.unread ?? 0, mail: [...mail.values()] };
}
