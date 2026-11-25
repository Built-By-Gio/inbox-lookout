// What the tool has learned from his clicks: a score per sender address and per subject word.
// ponytail: a bag of words, not a trained model. If it keeps misjudging mail that is similar in meaning
// but not in wording, lean harder on the examples given to the AI judge (judge.js) before adding a classifier.
const STOP = new Set('the and for you your with from has have are was this that new now get our not been its'.split(' '));
const clamp = (n, limit) => Math.max(-limit, Math.min(limit, n));
const words = m => [...new Set(m.subject.toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter(w => !STOP.has(w));
const sender = m => 'from:' + m.email.toLowerCase();

// dir: +1 he needed it, -1 he did not.
// strong: he pressed a teaching button. Opening or clearing an email is the weak signal.
export function teach(weights, m, dir, strong) {
  const next = { ...weights };
  const bump = (key, step, limit) => { next[key] = clamp((next[key] ?? 0) + dir * step, limit); };
  bump(sender(m), strong ? 4 : 1, 6);
  for (const w of words(m)) bump('w:' + w, strong ? 0.4 : 0.15, 2);
  return next;
}

// How far his past clicks push this email. The sender score can move it two tiers (one strong click is
// decisive); words alone are capped so they can move it one tier at most.
export function learned(weights, m) {
  const wordScore = words(m).reduce((sum, w) => sum + (weights['w:' + w] ?? 0), 0);
  return (weights[sender(m)] ?? 0) + clamp(wordScore, 2.5);
}

// m.call is the judge's own starting call; the result is where the email actually lands.
const START = { needs: 2, fyi: 0, trash: -2 };
export function tierOf(weights, m) {
  const score = START[m.call] + learned(weights, m);
  return score >= 1 ? 'needs' : score <= -1 ? 'trash' : 'fyi';
}
