// Picture from phone: a photo taken on a phone lands on the board a second later.
//
// How it works, start to finish:
//
//   1. "Picture from phone…" starts a tiny web server on this computer and
//      shows a QR code for it. Nothing listens until then, and it stops the
//      moment the card is closed.
//   2. The phone's own camera app reads the code and opens a one-page site in
//      its browser - no app to install, so it works with any phone, iPhones
//      included, and with a student's phone as easily as the teacher's.
//   3. The page has two buttons, take a photo or choose one. The phone shrinks
//      the picture itself and sends it back over the same Wi-Fi.
//   4. The picture is handed to the window, which puts it on the board.
//
// Nothing leaves the room. The page and the photo travel between two devices
// on the same network, and no server of ours is involved at any point.
//
// Who can send: only someone holding this session's code. The address carries
// a random 128-bit token that is made fresh every time the card opens and dies
// with it, so an old photo of the screen, or a code left in a phone's history,
// opens nothing tomorrow. A wrong token gets the same plain "not found" as any
// other address, and is compared in constant time.
//
// What can be sent: pictures, and nothing else. Every upload is checked by its
// first bytes (JPEG, PNG, WebP), size-capped, and passed on as bytes - the
// window builds the picture from them exactly as it does for a dropped file.
//
// Deliberately no Electron in here, like sync/node.js: plain callbacks and
// promises, so the suite can stand one up and talk to it over loopback.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { localAddresses } = require('./node.js');
const qrcode = require('./qrcode.js');

/** A port of its own, next to the sharing ports, so it is easy to name in a firewall. Any free one if it is taken. */
const PHONE_PORT = 53317;
/** A phone photo shrunk on the phone is 0.5-3 MB. 25 MB leaves room for a big screenshot and refuses anything silly. */
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
/** One session can bring in a whole notebook, but not fill the disk. */
const MAX_PHOTOS = 200;

const KINDS = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { mime: 'image/webp', test: (b) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 }
];

/** What a picture really is, from its first bytes - never from what the sender says. */
function sniff(buf) {
  for (const k of KINDS) if (k.test(buf)) return k.mime;
  return null;
}

/** The QR code as rows of 0s and 1s: the window draws it, so no markup crosses the bridge. */
function qrRows(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    let row = '';
    for (let c = 0; c < n; c++) row += q.isDark(r, c) ? '1' : '0';
    rows.push(row);
  }
  return rows;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The page the phone opens. One file, no outside resources, works in any phone
 * browser from the last several years. The phone does the shrinking: a 12 MP
 * photo becomes a sharp 2400 px JPEG before it is sent, which is quicker on a
 * busy classroom network and is all a projector can show anyway. Drawing it
 * through a canvas also turns an iPhone's HEIC into a JPEG and straightens a
 * photo taken sideways.
 */
function pageHtml(strings, lang, dir, nonce) {
  const S = (k) => esc(strings[k]);
  // the script's own copies of the messages, as JSON (safe inside a script: < is escaped)
  const msgs = JSON.stringify({ sending: strings.sending, sent: strings.sent, failed: strings.failed, unreadable: strings.unreadable, expired: strings.expired })
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${esc(lang)}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${S('title')}</title>
<style>
:root{--bg:#f3f2f1;--card:#fff;--text:#201f1e;--muted:#605e5c;--accent:#6264a7}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a19;--card:#292827;--text:#f3f2f1;--muted:#c8c6c4;--accent:#a6a8e0}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border-radius:16px;padding:24px 20px;box-shadow:0 6px 20px rgba(0,0,0,.12);text-align:center}
h1{font-size:20px;margin:0 0 18px}
label{display:block;margin:12px 0;padding:18px;border-radius:12px;font-size:18px;font-weight:600;cursor:pointer;user-select:none}
.take{background:var(--accent);color:#fff}.pick{border:2px solid var(--accent);color:var(--accent)}
input{position:absolute;width:1px;height:1px;opacity:0}
#s{min-height:1.5em;margin:14px 0 0;color:var(--muted)}#s.ok{color:#107c10}#s.bad{color:#d13438}
@media (prefers-color-scheme:dark){#s.ok{color:#6ccb5f}#s.bad{color:#ff99a4}}
</style></head><body><main>
<h1>${S('title')}</h1>
<label class="take">${S('take')}<input id="cam" type="file" accept="image/*" capture="environment"></label>
<label class="pick">${S('pick')}<input id="lib" type="file" accept="image/*" multiple></label>
<p id="s" role="status" aria-live="polite"></p>
</main>
<script nonce="${nonce}">
(function(){
var M=${msgs};
var s=document.getElementById('s');
function say(t,c){s.textContent=t;s.className=c||'';}
function load(file){
  if(window.createImageBitmap){return createImageBitmap(file,{imageOrientation:'from-image'}).catch(function(){return viaImg(file);});}
  return viaImg(file);
}
function viaImg(file){return new Promise(function(ok,no){var u=URL.createObjectURL(file),i=new Image();
  i.onload=function(){ok(i);};i.onerror=function(){URL.revokeObjectURL(u);no(new Error('unreadable'));};i.src=u;});}
function shrink(img){
  var w=img.width,h=img.height,k=Math.min(1,2400/Math.max(w,h));
  var c=document.createElement('canvas');c.width=Math.max(1,Math.round(w*k));c.height=Math.max(1,Math.round(h*k));
  var g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(img,0,0,c.width,c.height);
  return new Promise(function(ok,no){c.toBlob(function(b){b?ok(b):no(new Error('unreadable'));},'image/jpeg',0.9);});
}
function send(blob){
  return fetch(location.pathname.replace(/\\/$/,'')+'/photo',{method:'POST',headers:{'content-type':'image/jpeg'},body:blob})
    .then(function(r){if(r.status===404)throw new Error('expired');if(!r.ok)throw new Error('failed');});
}
function go(input){
  var files=[].slice.call(input.files||[]);input.value='';
  if(!files.length)return;
  var n=0,chain=Promise.resolve();
  files.forEach(function(f){chain=chain.then(function(){
    say(M.sending+(files.length>1?' '+(n+1)+'/'+files.length:''));
    return load(f).then(shrink,function(){throw new Error('unreadable');}).then(send).then(function(){n++;});
  });});
  chain.then(function(){say(M.sent,'ok');},function(e){
    say(e.message==='unreadable'?M.unreadable:e.message==='expired'?M.expired:M.failed,'bad');});
}
document.getElementById('cam').addEventListener('change',function(){go(this);});
document.getElementById('lib').addEventListener('change',function(){go(this);});
})();
</script></body></html>`;
}

function expiredHtml(strings, lang) {
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GazBoard</title></head><body style="font:18px system-ui,sans-serif;padding:32px;text-align:center">${esc(strings.expired || 'This code has expired.')}</body></html>`;
}

/**
 * @param {object} opts
 * @param {Function} opts.onPhoto   ({ bytes: Buffer, mime }) => void - a picture arrived
 * @param {string}  [opts.host]     what to listen on (the suite uses loopback)
 * @param {number}  [opts.port]     preferred port
 */
function createPhoneReceiver(opts) {
  const { onPhoto, host = '0.0.0.0', port: wantPort = PHONE_PORT } = opts;
  let server = null, port = 0, token = null, strings = {}, lang = 'en', dir = 'ltr', count = 0;
  const sockets = new Set();

  const sameToken = (t) => {
    if (!token || typeof t !== 'string' || t.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  };

  function reply(res, code, type, body, extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(code, {
      'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', ...extra
    });
    res.end(buf);
  }
  const json = (res, code, body) => reply(res, code, 'application/json', JSON.stringify(body));

  function handle(req, res) {
    const url = String(req.url || '').split('?')[0];
    const m = /^\/p\/([0-9a-f]{32})(\/photo)?\/?$/.exec(url);
    if (!m) return reply(res, 404, 'text/plain; charset=utf-8', 'Not found');
    if (!sameToken(m[1])) {
      // the page asks for itself again after the card was closed and opened: say so plainly
      return m[2] ? json(res, 404, { error: 'expired' }) : reply(res, 404, 'text/html; charset=utf-8', expiredHtml(strings, lang));
    }
    if (!m[2]) {
      if (req.method !== 'GET') return reply(res, 405, 'text/plain', 'Method not allowed');
      const nonce = crypto.randomBytes(16).toString('base64');
      return reply(res, 200, 'text/html; charset=utf-8', pageHtml(strings, lang, dir, nonce), {
        'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`
      });
    }
    if (req.method !== 'POST') return reply(res, 405, 'text/plain', 'Method not allowed');
    if (count >= MAX_PHOTOS) return json(res, 429, { error: 'too many' });
    const declared = Number(req.headers['content-length']);
    // too big: say so, and drop the connection so the rest of it is never read
    if (declared > MAX_PHOTO_BYTES) { res.setHeader('connection', 'close'); json(res, 413, { error: 'too large' }); req.destroy(); return; }
    const chunks = [];
    let size = 0, refused = false;
    req.on('data', (c) => {
      if (refused) return;
      size += c.length;
      if (size > MAX_PHOTO_BYTES) { refused = true; res.setHeader('connection', 'close'); json(res, 413, { error: 'too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (refused) return;
      const bytes = Buffer.concat(chunks);
      const mime = sniff(bytes);
      if (!mime) return json(res, 415, { error: 'not a picture' });
      // the card may have been closed while this was on its way
      if (!token) return json(res, 404, { error: 'expired' });
      count++;
      try { onPhoto({ bytes, mime }); } catch { /* the window going away is not the phone's problem */ }
      json(res, 200, { ok: true });
    });
    req.on('error', () => {});
  }

  /** The address to put in the code: the best one this computer has, plus the rest in case that one is wrong. */
  function links() {
    const addrs = localAddresses();
    return addrs.map((a) => ({ name: a.name, address: a.address, selfAssigned: !!a.selfAssigned,
      url: `http://${a.address}:${port}/p/${token}` }));
  }

  /**
   * Open for photos. Calling it again while open starts a fresh session (new
   * token), so a code that has been on a projector all lesson can be retired.
   * @param {object} o  { strings, lang, dir } - the phone page's words, in the app's language
   */
  async function start(o = {}) {
    strings = o.strings || {};
    lang = o.lang || 'en';
    dir = o.dir || 'ltr';
    token = crypto.randomBytes(16).toString('hex');
    count = 0;
    if (!server) {
      server = http.createServer(handle);
      server.requestTimeout = 120000;
      server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      await new Promise((resolve, reject) => {
        const any = () => {
          server.removeAllListeners('error');
          server.once('error', reject);
          server.listen(0, host, () => { server.removeAllListeners('error'); server.on('error', () => {}); resolve(); });
        };
        server.once('error', any);
        server.listen(wantPort, host, () => { server.removeAllListeners('error'); server.on('error', () => {}); resolve(); });
      }).catch((e) => { server = null; throw e; });
      port = server.address().port;
    }
    const list = links();
    const best = list[0] || null;
    return { port, token, links: list, url: best ? best.url : null, qr: best ? qrRows(best.url) : null };
  }

  /** Close for photos. The token dies first, so anything still arriving is turned away. */
  async function stop() {
    token = null;
    if (!server) return;
    const s = server;
    server = null; port = 0;
    for (const sock of sockets) { try { sock.destroy(); } catch {} }
    sockets.clear();
    await new Promise((resolve) => s.close(() => resolve()));
  }

  return { start, stop, get running() { return !!server; }, get port() { return port; }, qrRows };
}

module.exports = { createPhoneReceiver, sniff, qrRows, PHONE_PORT, MAX_PHOTO_BYTES, MAX_PHOTOS };
