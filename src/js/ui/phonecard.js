/*
 * Picture from phone: the card on the board.
 *
 * A small card in the corner with a QR code. Scan it with a phone's camera,
 * take a photo, and the picture lands on the board near the middle of the view.
 * The card stays open for as many photos as you like - a whole notebook, page
 * by page - and the board stays usable behind it the whole time.
 *
 * Closing the card (its ✕) closes the door: the little web server on this
 * computer stops, and the code on the card stops working for good. Opening it
 * again makes a new code. See sync/phone.js for the other half.
 *
 * Desktop only. The Android app and the web version have no way to host the
 * page, so neither of them shows the menu item (phoneAvailable()).
 */
import { t, currentLanguage, direction } from '../i18n.js';
import { h } from './popover.js';
import { icon } from './icons.js';
import { insertPhonePhoto } from '../insert.js';

/** Can this copy of GazBoard receive from a phone? */
export function phoneAvailable() {
  const b = typeof window !== 'undefined' ? window.board : null;
  return !!(b && b.phone && typeof b.phone.start === 'function');
}

/** The QR code as an SVG: dark squares on white, with the four-module quiet margin readers need. */
export function qrSvg(rows, size = 184) {
  const n = rows.length, q = 4, all = n + q * 2;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${all} ${all}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'phone-qr');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(all)); bg.setAttribute('height', String(all)); bg.setAttribute('fill', '#fff');
  svg.appendChild(bg);
  // one path for every dark square: quick to draw, and crisp at any size
  let d = '';
  rows.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[c] === '1') d += `M${c + q} ${r + q}h1v1h-1z`; });
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d); p.setAttribute('fill', '#000');
  svg.appendChild(p);
  return svg;
}

export class PhoneCard {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.count = 0;
    this.session = null;
    this.listening = false;
  }

  get visible() { return !!this.el; }

  /** The phone page's words, in the language the app is showing. */
  pageStrings() {
    return {
      title: t('Send to GazBoard'),
      take: t('Take a photo'),
      pick: t('Choose a picture'),
      sending: t('Sending…'),
      sent: t('Sent. It is on the board.'),
      failed: t('Could not send it. Check you are on the same Wi-Fi and try again.'),
      unreadable: t('That picture could not be read. Try taking a photo instead.'),
      expired: t('This code has expired. Scan the new one on the board.')
    };
  }

  listen() {
    if (this.listening || !phoneAvailable()) return;
    this.listening = true;
    window.board.phone.onPhoto((p) => this.arrived(p));
    window.board.phone.onVisit?.(() => this.visited());
  }

  /** A phone opened the page: say so, and put away the "cannot reach" help. */
  visited() {
    if (!this.el) return;
    this.reached = true;
    clearTimeout(this.helpTimer);
    if (this.helpEl) this.helpEl.hidden = true;
    if (!this.count) this.setStatus(t('Phone connected. Take a photo.'), 'ok');
  }

  /** Show the code for one of this computer's addresses (the first is the best guess). */
  showLink(i) {
    const links = (this.session && this.session.links) || [];
    const l = links[i];
    if (!l) return;
    this.pick = i;
    this.qrBox.replaceChildren(qrSvg(l.qr));
    this.urlEl.textContent = l.url;
    this.otherEl.replaceChildren();
    const others = links.map((x, k) => ({ x, k })).filter(({ x, k }) => k !== i && !x.selfAssigned);
    if (!others.length) return;
    this.otherEl.appendChild(h('span', { class: 'phone-other-label' }, t('Not opening? Try another address of this computer:')));
    for (const { x, k } of others) {
      const b = h('button', { type: 'button', class: 'phone-addr', 'data-phone-addr': String(k), title: x.name || '' }, x.address);
      b.addEventListener('click', () => this.showLink(k));
      this.otherEl.appendChild(b);
    }
  }

  async arrived(p) {
    // a photo still on its way when the card was closed is not wanted any more
    if (!this.el || !p || !p.bytes) return;
    const obj = await insertPhonePhoto(this.app, p.bytes, p.mime, this.count);
    if (!obj) return;
    this.count++;
    this.setStatus(t('Photos added: {n}', { n: this.count }), 'ok');
  }

  setStatus(text, kind = '') {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.className = 'phone-status' + (kind ? ' ' + kind : '');
  }

  async open() {
    if (!phoneAvailable()) return null;
    this.listen();
    if (!this.el) this.build();
    this.count = 0;
    this.setStatus(t('Starting…'));
    const lang = currentLanguage();
    const res = await window.board.phone.start({ strings: this.pageStrings(), lang, dir: direction(lang) });
    if (!this.el) { window.board.phone.stop(); return null; }   // closed while starting
    this.session = res;
    this.qrBox.replaceChildren();
    if (!res || !res.ok) {
      this.setStatus(t('Could not start: {error}', { error: (res && res.error) || t('unknown problem') }), 'bad');
      return res;
    }
    if (!res.url) {
      this.setStatus(t('This computer is not on a network. Connect it to Wi-Fi first.'), 'bad');
      return res;
    }
    // a computer with Wi-Fi and a cable, or WSL, has more than one address: the code shows the best guess, and one
    // press swaps it for another
    this.reached = false;
    this.showLink(0);
    this.setStatus(t('Waiting for a photo…'));
    // nobody has opened the page after a while: the network is probably in the way, so say how to fix it
    clearTimeout(this.helpTimer);
    if (this.helpEl) this.helpEl.hidden = true;
    this.helpTimer = setTimeout(() => { if (this.el && !this.reached && this.helpEl) this.helpEl.hidden = false; }, 20000);
    this.app.surface?.invalidate?.();
    return res;
  }

  build() {
    this.qrBox = h('div', { class: 'phone-qr-box' });
    this.urlEl = h('div', { class: 'phone-url', 'data-phone-url': '1' });
    this.otherEl = h('div', { class: 'phone-other' });
    this.statusEl = h('div', { class: 'phone-status', role: 'status', 'aria-live': 'polite' });
    const close = h('button', { type: 'button', class: 'icon-btn phone-close', 'aria-label': t('Close'), title: t('Close'), html: icon('close', 16) });
    close.addEventListener('click', () => this.close());
    this.el = h('div', { class: 'phone-card', 'data-phone-card': '1' },
      h('div', { class: 'phone-head' }, h('strong', {}, t('Picture from phone')), close),
      this.qrBox,
      h('p', { class: 'phone-how' }, t('Scan this with the camera on your phone, then take a photo. It appears on the board.')),
      h('p', { class: 'phone-hint' }, t('Your phone and this computer must be on the same Wi-Fi.'),
        /Windows/.test(navigator.userAgent || '') ? ' ' + t('If Windows asks about network access, choose Allow.') : ''),
      this.statusEl,
      this.urlEl,
      this.otherEl,
      (this.helpEl = h('div', { class: 'phone-help', 'data-phone-help': '1', hidden: true },
        h('strong', {}, t('Phone just keeps loading?')),
        h('ul', {},
          h('li', {}, t('Try the other address above, if there is one.')),
          /Windows/.test(navigator.userAgent || '') ? h('li', {}, t('In Windows Settings, set this Wi-Fi to Private, and let GazBoard through the firewall.')) : null,
          h('li', {}, t('Pause any VPN or ad blocker on the phone (such as AdGuard).')),
          h('li', {}, t('School Wi-Fi often keeps devices apart: turn on the hotspot on your phone and connect this computer to it.'))))));
    (document.getElementById('stage') || document.body).appendChild(this.el);
  }

  async close() {
    clearTimeout(this.helpTimer);
    const el = this.el;
    this.el = null; this.session = null;
    if (el) el.remove();
    if (phoneAvailable()) { try { await window.board.phone.stop(); } catch { /* already gone */ } }
    this.app.syncUI?.();
  }

  toggle() { return this.el ? this.close() : this.open(); }
}
