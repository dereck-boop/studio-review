'use strict';
// Optional push notification when a client leaves a note (ntfy.sh or a self-hosted ntfy topic).
// The topic comes from the /admin page, falling back to NTFY_URL in .env.
const settings = require('./settings');

function notify(title, message, link, url = settings.get().ntfyUrl) {
  if (!url) return Promise.resolve(false);
  const headers = { Title: title.replace(/[^\x20-\x7E]/g, '?') };
  if (link) headers.Click = link;
  return fetch(url, { method: 'POST', body: message, headers })
    .then((r) => r.ok)
    .catch((e) => { console.error('[notify]', e.message); return false; });
}

module.exports = { notify };
