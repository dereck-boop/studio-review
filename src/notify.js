'use strict';
// Optional push notification when a client leaves a note (ntfy.sh or a self-hosted ntfy topic).
const { NTFY_URL } = require('./config');

function notify(title, message, link) {
  if (!NTFY_URL) return;
  const headers = { Title: title.replace(/[^\x20-\x7E]/g, '?') };
  if (link) headers.Click = link;
  fetch(NTFY_URL, { method: 'POST', body: message, headers }).catch((e) => console.error('[notify]', e.message));
}

module.exports = { notify };
