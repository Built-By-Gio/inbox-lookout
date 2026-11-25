// Hidden page that answers the background worker's questions to Chrome's on-device model.
import { aiAvailable, aiCall } from './judge.js';

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.aiReady) aiAvailable().then(reply, () => reply(false));
  else if (msg.ai) aiCall(msg.ai, msg.examples).then(reply, () => reply(null));
  else return;
  return true; // the reply comes later
});
