const VERSION = 3;
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = u => [...u].map(b => b.toString(16).padStart(2, '0')).join(' ');

const logLines = [];
function log(text) {
  const line = new Date().toTimeString().slice(0, 8) + ' ' + text;
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
  const box = $('#log');
  if (box) box.textContent = logLines.join('\n');
  console.log(line);
}

function banner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.style.display = text ? 'block' : 'none';
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('délai dépassé (' + what + ')')), ms); })
  ]).finally(() => clearTimeout(t));
}

function fatal(msg) {
  const e = new Error(msg);
  e.fatal = true;
  return e;
}

const store = {
  get(k, d) {
    try { const v = localStorage.getItem('leds.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('leds.' + k, JSON.stringify(v)); } catch (e) {}
  }
};

function explain(e) {
  const n = e && e.name;
  const m = (e && e.message) || String(e);
  if (n === 'NotFoundError') {
    if (/cancel/i.test(m)) return 'Recherche annulée.';
    return 'Aucune bande trouvée. Ferme les apps Govee/MohuanLED, vérifie Bluetooth + Localisation, et rapproche-toi.';
  }
  if (n === 'SecurityError') return 'Bluetooth refusé. Ouvre la page en https et autorise "Appareils à proximité" pour Chrome.';
  if (n === 'NetworkError') return 'La bande a refusé la connexion. Nouvel essai automatique.';
  if (n === 'NotSupportedError') return 'Fonction non supportée par cette bande.';
  return m;
}

function checkSupport() {
  let msg = '';
  if (!window.isSecureContext) msg = 'Cette page doit être ouverte depuis une adresse https:// sinon Chrome bloque le Bluetooth.';
  else if (!navigator.bluetooth) msg = 'Ce navigateur ne gère pas le Bluetooth web. Ouvre la page dans Google Chrome sur Android.';
  if (msg) { banner(msg); return false; }
  return true;
}

const ZERO16 = new Uint8Array(16);
const PAD16 = new Uint8Array(16).fill(16);

async function aesEnc(key, block) {
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ZERO16 }, key, block));
  return out.slice(0, 16);
}

async function aesDec(key, block) {
  const x = new Uint8Array(16);
  for (let i = 0; i < 16; i++) x[i] = PAD16[i] ^ block[i];
  const buf = new Uint8Array(32);
  buf.set(block);
  buf.set(await aesEnc(key, x), 16);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ZERO16 }, key, buf));
}

function rc4(key, data) {
  const s = [...Array(256).keys()];
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

class Cipher {
  constructor(raw) { this.raw = raw; }
  async init() {
    this.key = await crypto.subtle.importKey('raw', this.raw, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
    return this;
  }
  async enc(f) {
    const o = new Uint8Array(20);
    o.set(await aesEnc(this.key, f.slice(0, 16)));
    o.set(rc4(this.raw, f.slice(16, 20)), 16);
    return o;
  }
  async dec(f) {
    const o = new Uint8Array(20);
    o.set(await aesDec(this.key, f.slice(0, 16)));
    o.set(rc4(this.raw, f.slice(16, 20)), 16);
    return o;
  }
}

function gv(...b) {
  const f = new Uint8Array(20);
  f.set(b);
  let x = 0;
  for (let i = 0; i < 19; i++) x ^= f[i];
  f[19] = x;
  return f;
}

const GV = {
  power: on => gv(0x33, 0x01, on ? 1 : 0),
  bright: p => gv(0x33, 0x04, Math.max(1, Math.min(100, Math.round(p)))),
  color: (r, g, b) => gv(0x33, 0x05, 0x15, 0x01, r, g, b, 0, 0, 0, 0, 0, 0xff, 0x7f),
  seg: (mask, r, g, b) => gv(0x33, 0x05, 0x15, 0x01, r, g, b, 0, 0, 0, 0, 0, mask & 255, (mask >> 8) & 255),
  keep: () => gv(0xaa, 0x01)
};

const BJ = {
  power: on => new Uint8Array([0x69, 0x96, 0x02, 0x01, on ? 1 : 0]),
  color: (r, g, b) => new Uint8Array([0x69, 0x96, 0x05, 0x02, r, g, b]),
  effect: (id, spd) => new Uint8Array([0x69, 0x96, 0x03, 0x03, id, spd])
};

const GOVEE_SVC = '00010203-0405-0607-0809-0a0b0c0d1910';
const GOVEE_TX = '00010203-0405-0607-0809-0a0b0c0d2b11';
const GOVEE_RX = '00010203-0405-0607-0809-0a0b0c0d2b10';
const GOVEE_BGC = '00010203-0405-0607-0809-0a0b0c0d2b12';
const BJ_SVC = '0000eea0-0000-1000-8000-00805f9b34fb';
const BJ_TX = '0000ee01-0000-1000-8000-00805f9b34fb';
const ALL_SERVICES = [GOVEE_SVC, BJ_SVC];
const SEGMENTS = 15;

const EFFECTS = ['Arc-en-ciel en boucle', 'Fondu rouge', 'Fondu vert', 'Fondu bleu', 'Fondu jaune', 'Fondu cyan',
  'Fondu magenta', 'Fondu blanc', 'Fondu rouge / vert', 'Fondu rouge / bleu', 'Fondu vert / bleu', 'Fondu arc-en-ciel',
  'Flash multicolore', 'Flash rouge', 'Flash vert', 'Flash bleu', 'Flash jaune', 'Flash cyan', 'Flash magenta',
  'Flash blanc', 'Saut de couleurs', 'Saut RGB'];

const PRESETS = [[0, 0], [30, 55], [0, 100], [22, 100], [50, 100], [120, 100], [180, 100], [230, 100], [275, 100], [320, 100]];

const S = Object.assign({ on: true, h: 30, s: 55, bri: 80, mode: 'color', fx: 0, speed: 6, segs: null }, store.get('state', {}));
const CAL = Object.assign({ govee: { lo: 1, hi: 100 }, bj: { lo: 1, hi: 100 } }, store.get('cal', {}));

function level(id) {
  const c = CAL[id];
  const t = (S.bri - 1) / 99;
  return c.lo + (c.hi - c.lo) * (id === 'bj' ? Math.pow(t, 2.2) : t);
}

function hsv2rgb(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map(x => Math.round(x * 255));
}

const rgbNow = () => hsv2rgb(S.h, S.s / 100, 1);

class Strip {
  constructor(id, cfg) {
    this.id = id;
    this.cfg = cfg;
    this.el = $('#s-' + id);
    this.device = null;
    this.tx = null;
    this.cipher = null;
    this.pending = new Map();
    this.busy = false;
    this.connecting = null;
    this.wanted = false;
    this.sleeping = false;
    this.fails = 0;
    this.noResp = true;
    this.waiters = [];
    this.onNotify = e => this.notify(e);
    this.onLost = () => this.lost();
    this.onAdvert = () => {
      if (this.wanted && !this.ready && !this.connecting && !this.sleeping) {
        clearTimeout(this.timer);
        this.connect();
      }
    };
    this.el.querySelector('.pair').onclick = () => this.pair(false);
    this.el.querySelector('.drop').onclick = () => this.forget();
    const g = this.el.querySelector('.grp');
    g.checked = store.get('grp.' + id, true);
    g.onchange = () => {
      store.set('grp.' + id, g.checked);
      if (g.checked) this.cfg.resync(this);
    };
  }

  get inGroup() { return this.el.querySelector('.grp').checked; }

  get ready() { return !!this.tx && !!this.device && this.device.gatt.connected; }

  status(kind, text) {
    this.el.querySelector('.dot').className = 'dot ' + (kind || '');
    this.el.querySelector('.status').textContent = text;
    if (text !== this.lastText) {
      this.lastText = text;
      log(this.cfg.label + ' : ' + text);
    }
  }

  use(dev) {
    if (this.device === dev) return;
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onLost);
      this.device.removeEventListener('advertisementreceived', this.onAdvert);
    }
    this.device = dev;
    dev.addEventListener('gattserverdisconnected', this.onLost);
    dev.addEventListener('advertisementreceived', this.onAdvert);
    this.el.querySelector('.name').textContent = this.cfg.label + (dev.name ? ' - ' + dev.name : '');
  }

  async pair(wide) {
    if (!checkSupport()) return;
    try {
      const opts = wide
        ? { acceptAllDevices: true, optionalServices: ALL_SERVICES }
        : { filters: this.cfg.filters, optionalServices: ALL_SERVICES };
      const dev = await navigator.bluetooth.requestDevice(opts);
      this.use(dev);
      store.set('dev.' + this.id, { id: dev.id, name: dev.name || '' });
      this.wanted = true;
      this.fails = 0;
      await this.connect();
    } catch (e) {
      this.status('err', explain(e));
    }
  }

  async forget() {
    this.wanted = false;
    this.sleeping = false;
    clearTimeout(this.timer);
    this.stopTimers();
    this.pending.clear();
    const dev = this.device;
    this.tx = null;
    store.set('dev.' + this.id, null);
    if (dev) {
      try { dev.gatt.disconnect(); } catch (e) {}
      try { if (dev.forget) await dev.forget(); } catch (e) {}
    }
    this.device = null;
    this.el.querySelector('.name').textContent = this.cfg.label;
    this.status('', 'Oubliée. Touche Connecter pour la choisir à nouveau.');
  }

  connect() {
    if (!this.connecting) this.connecting = this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async doConnect() {
    clearTimeout(this.timer);
    if (!this.device) return false;
    this.sleeping = false;
    this.keepMsg = false;
    for (let i = 1; i <= 3; i++) {
      if (!this.wanted) return false;
      this.status('busy', i === 1 ? 'Connexion...' : 'Connexion, essai ' + i + '/3...');
      try {
        const server = await withTimeout(this.device.gatt.connect(), 15000, 'connexion');
        this.tx = null;
        this.cipher = null;
        await withTimeout(this.cfg.setup(this, server), 15000, 'préparation');
        if (!this.device.gatt.connected) throw new Error('coupée pendant la préparation');
        this.fails = 0;
        this.status('ok', 'Connectée');
        if (this.inGroup) this.cfg.resync(this);
        this.startTimers();
        this.flush();
        return true;
      } catch (e) {
        log(this.cfg.label + ' : échec ' + (e.name || '') + ' ' + (e.message || e));
        this.tx = null;
        try { this.device.gatt.disconnect(); } catch (_) {}
        if (e.fatal) {
          this.wanted = false;
          this.keepMsg = true;
          this.status('err', e.message);
          return false;
        }
        await sleep(700 * i);
      }
    }
    this.fails++;
    const wait = Math.min(30000, 2000 * 2 ** Math.min(this.fails, 4));
    this.status('err', 'Pas joignable. Nouvel essai dans ' + Math.round(wait / 1000) + ' s (ou touche Connecter).');
    this.watch();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), wait);
    return false;
  }

  async watch() {
    try {
      if (this.device.watchAdvertisements && !this.device.watchingAdvertisements) await this.device.watchAdvertisements();
    } catch (e) {}
  }

  lost() {
    this.tx = null;
    this.cipher = null;
    this.stopTimers();
    if (this.connecting) return;
    if (this.sleeping) {
      this.status('ok', 'En veille, se réveille au prochain réglage');
      return;
    }
    if (!this.wanted) {
      if (!this.keepMsg) this.status('', 'Déconnectée');
      return;
    }
    this.status('busy', 'Connexion perdue, reconnexion...');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), 800);
  }

  startTimers() {
    this.stopTimers();
    if (this.cfg.keep) {
      this.hb = setInterval(() => {
        if (this.ready && !this.busy && !this.pending.size) this.send('hb', [this.cfg.keep()]);
      }, 2000);
    }
    this.kickIdle();
  }

  stopTimers() {
    clearInterval(this.hb);
    clearTimeout(this.idle);
  }

  kickIdle() {
    clearTimeout(this.idle);
    if (this.cfg.idleMs && this.ready) this.idle = setTimeout(() => this.nap(), this.cfg.idleMs);
  }

  nap() {
    if (!this.ready || this.busy || this.pending.size) return this.kickIdle();
    this.sleeping = true;
    try { this.device.gatt.disconnect(); } catch (e) {}
  }

  send(key, frames) {
    this.pending.delete(key);
    this.pending.set(key, frames);
    if (key !== 'hb') this.kickIdle();
    if (this.ready) this.flush();
    else if (this.wanted && this.device && !this.connecting) this.connect();
  }

  drop(test) {
    for (const k of [...this.pending.keys()]) if (test(k)) this.pending.delete(k);
  }

  async rawWrite(b) {
    const c = this.tx;
    if (!c) throw new Error('pas connectée');
    if (this.noResp && c.writeValueWithoutResponse) {
      try {
        return await withTimeout(c.writeValueWithoutResponse(b), 4000, 'écriture');
      } catch (e) {
        if (e.name !== 'NotSupportedError') throw e;
        this.noResp = false;
      }
    }
    return await withTimeout(c.writeValue(b), 4000, 'écriture');
  }

  async write(frame) {
    await this.rawWrite(this.cipher ? await this.cipher.enc(frame) : frame);
  }

  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.size && this.ready) {
        const [key, frames] = this.pending.entries().next().value;
        this.pending.delete(key);
        try {
          for (const f of frames) {
            await this.write(f);
            await sleep(this.cfg.gap);
          }
          if (key !== 'hb') log(this.cfg.label + ' > ' + key + ' : ' + hex(frames[frames.length - 1]));
        } catch (e) {
          log(this.cfg.label + ' : envoi raté (' + (e.message || e) + ')');
          if (!this.pending.has(key) && key !== 'hb') this.pending = new Map([[key, frames], ...this.pending]);
          this.tx = null;
          try { this.device.gatt.disconnect(); } catch (_) {}
          break;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  waitFor(test, ms) {
    return new Promise((res, rej) => {
      const w = {
        test,
        done: v => {
          clearTimeout(t);
          this.waiters = this.waiters.filter(x => x !== w);
          res(v);
        }
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        rej(new Error('pas de réponse de la bande'));
      }, ms);
      this.waiters.push(w);
    });
  }

  notify(ev) {
    const v = ev.target.value;
    const raw = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    for (const w of [...this.waiters]) Promise.resolve(w.test(raw)).then(r => { if (r) w.done(r); }).catch(() => {});
  }
}

async function goveeHandshake(s) {
  const psk = await new Cipher(new TextEncoder().encode('MakingLifeSmarte')).init();
  const rnd = () => crypto.getRandomValues(new Uint8Array(17));
  const reply = step => async raw => {
    if (raw.length < 20) return null;
    const p = await psk.dec(raw);
    if (p[0] !== 0xe7 || p[1] !== step) return null;
    return step === 1 ? p.slice(2, 18) : true;
  };
  const k = s.waitFor(reply(1), 6000);
  await s.rawWrite(await psk.enc(gv(0xe7, 0x01, ...rnd())));
  const key = await k;
  const ack = s.waitFor(reply(2), 1500);
  await s.rawWrite(await psk.enc(gv(0xe7, 0x02, ...rnd())));
  try { await ack; } catch (e) { log('Govee : pas d\'accusé de chiffrement, on continue'); }
  s.cipher = await new Cipher(key).init();
  await sleep(300);
  log('Govee : liaison chiffrée prête');
}

const goveeCfg = {
  label: 'Govee H618A',
  gap: 40,
  keep: GV.keep,
  filters: [{ namePrefix: 'ihoment_' }, { namePrefix: 'Govee_' }, { namePrefix: 'GBK_' }, { namePrefix: 'GVH' }, { namePrefix: 'Minger_' }],
  async setup(s, server) {
    let svc;
    try {
      svc = await server.getPrimaryService(GOVEE_SVC);
    } catch (e) {
      if (e.name === 'NotFoundError') throw fatal('Cet appareil n\'est pas une bande Govee compatible. Touche Oublier puis choisis la bonne.');
      throw e;
    }
    const tx = await svc.getCharacteristic(GOVEE_TX);
    let rx = null;
    try {
      rx = await svc.getCharacteristic(GOVEE_RX);
      if (!rx.ledsListen) {
        rx.addEventListener('characteristicvaluechanged', s.onNotify);
        rx.ledsListen = true;
      }
      await rx.startNotifications();
    } catch (e) {
      rx = null;
      log('Govee : notifications indisponibles (' + (e.message || e) + ')');
    }
    let ver = 0;
    try {
      const c = await svc.getCharacteristic(GOVEE_BGC);
      const d = new Uint8Array((await c.readValue()).buffer);
      if (d[0] === 1 || d[0] === 2) ver = d[1];
    } catch (e) {}
    if (ver === 2) throw fatal('Cette Govee utilise un chiffrement AES-GCM pas encore géré par la page.');
    s.tx = tx;
    if (ver === 1) {
      if (!rx) throw new Error('chiffrement demandé mais notifications indisponibles');
      log('Govee : chiffrement demandé, négociation...');
      await goveeHandshake(s);
    }
  },
  resync(s) {
    if (!S.on) return this.off(s);
    s.send('power', [GV.power(true)]);
    s.send('bright', [GV.bright(level('govee'))]);
    this.paint(s);
  },
  paint(s) {
    s.drop(k => k === 'color' || k.startsWith('seg'));
    if (!S.segs) {
      s.send('color', [GV.color(...rgbNow())]);
      return;
    }
    const groups = new Map();
    S.segs.forEach((c, i) => {
      const k = c.join(',');
      groups.set(k, (groups.get(k) || 0) | (1 << i));
    });
    for (const [k, mask] of groups) s.send('seg:' + mask, [GV.seg(mask, ...k.split(',').map(Number))]);
  },
  color(s) { this.paint(s); },
  segs(s) { this.paint(s); },
  bright(s) { s.send('bright', [GV.bright(level('govee'))]); },
  fx() {},
  off(s) { s.send('power', [GV.power(false)]); }
};

const bjCfg = {
  label: 'Bande AliExpress',
  gap: 25,
  idleMs: 180000,
  filters: [{ namePrefix: 'BJ_LED' }, { services: [BJ_SVC] }],
  async setup(s, server) {
    let svc;
    try {
      svc = await server.getPrimaryService(BJ_SVC);
    } catch (e) {
      if (e.name === 'NotFoundError') throw fatal('Cet appareil n\'est pas une bande MohuanLED (BJ_LED). Touche Oublier puis choisis la bonne.');
      throw e;
    }
    let tx;
    try {
      tx = await svc.getCharacteristic(BJ_TX);
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
      const list = await svc.getCharacteristics();
      tx = list.find(c => c.properties.writeWithoutResponse || c.properties.write);
      if (!tx) throw fatal('Pas de canal d\'écriture trouvé sur cette bande.');
    }
    s.tx = tx;
  },
  resync(s) {
    if (!S.on) return this.off(s);
    s.send('power', [BJ.power(true)]);
    if (S.mode === 'fx') this.fx(s);
    else this.color(s);
  },
  color(s) {
    const f = level('bj') / 100;
    const [r, g, b] = rgbNow().map(x => (x ? Math.max(1, Math.round(x * f)) : 0));
    s.send('mode', [BJ.color(r, g, b)]);
  },
  bright(s) { if (S.mode !== 'fx') this.color(s); },
  fx(s) { s.send('mode', [BJ.effect(S.fx, 11 - S.speed)]); },
  segs() {},
  off(s) { s.send('power', [BJ.power(false)]); }
};

const strips = [new Strip('govee', goveeCfg), new Strip('bj', bjCfg)];
const group = fn => strips.forEach(s => { if (s.inGroup) fn(s); });

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set('state', S), 400);
}

function push(what) {
  if (!S.on) {
    S.on = true;
    group(s => s.cfg.resync(s));
  } else {
    group(s => s.cfg[what](s));
  }
  render();
  save();
}

const css = c => 'rgb(' + c.join(',') + ')';
const selected = new Set();

function render() {
  const cur = rgbNow();
  $('#preview').style.background = css(cur);
  $('#hue').value = S.h;
  $('#sat').value = S.s;
  $('#bri').value = S.bri;
  $('#briVal').textContent = S.bri + ' %';
  $('#fx').value = S.fx;
  $('#fxSpeed').value = S.speed;
  document.querySelectorAll('.seg').forEach((el, i) => {
    el.style.background = css(S.segs ? S.segs[i] : cur);
    el.classList.toggle('sel', selected.has(i));
  });
}

function buildUi() {
  const sw = $('#swatches');
  PRESETS.forEach(([h, s]) => {
    const b = document.createElement('button');
    b.className = 'sw';
    b.style.background = css(hsv2rgb(h, s / 100, 1));
    b.onclick = () => { S.h = h; S.s = s; color(); };
    sw.appendChild(b);
  });
  EFFECTS.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = n;
    $('#fx').appendChild(o);
  });
  const segs = $('#segs');
  for (let i = 0; i < SEGMENTS; i++) {
    const b = document.createElement('button');
    b.className = 'seg';
    b.onclick = () => { selected.has(i) ? selected.delete(i) : selected.add(i); render(); };
    segs.appendChild(b);
  }
  const color = () => {
    const cur = rgbNow();
    if (selected.size) {
      const base = S.segs || Array.from({ length: SEGMENTS }, () => S.base || cur);
      S.segs = base.map((c, i) => (selected.has(i) ? cur : c));
      push('segs');
      return;
    }
    S.mode = 'color';
    S.segs = null;
    S.base = cur;
    push('color');
  };
  $('#hue').oninput = e => { S.h = +e.target.value; color(); };
  $('#sat').oninput = e => { S.s = +e.target.value; color(); };
  $('#bri').oninput = e => { S.bri = +e.target.value; push('bright'); };
  document.querySelectorAll('[data-cal]').forEach(el => {
    const [id, end] = el.dataset.cal.split('.');
    const out = el.previousElementSibling.querySelector('span:last-child');
    const show = () => { el.value = CAL[id][end]; out.textContent = CAL[id][end] + ' %'; };
    show();
    el.show = show;
    el.oninput = () => {
      CAL[id][end] = +el.value;
      show();
      store.set('cal', CAL);
      S.bri = end === 'lo' ? 1 : 100;
      if (S.mode === 'fx' || !S.on) {
        S.mode = 'color';
        S.on = true;
        group(s => s.cfg.resync(s));
        render();
        save();
      } else {
        push('bright');
      }
    };
  });
  $('#calReset').onclick = () => {
    Object.assign(CAL, { govee: { lo: 1, hi: 100 }, bj: { lo: 1, hi: 100 } });
    store.set('cal', CAL);
    document.querySelectorAll('[data-cal]').forEach(el => el.show());
    push('bright');
  };
  $('#fx').onchange = e => { S.fx = +e.target.value; S.mode = 'fx'; push('fx'); };
  $('#fxGo').onclick = () => { S.fx = +$('#fx').value; S.mode = 'fx'; push('fx'); };
  $('#fxSpeed').oninput = e => { S.speed = +e.target.value; if (S.mode === 'fx') push('fx'); else save(); };
  $('#allOn').onclick = () => { S.on = true; group(s => s.cfg.resync(s)); save(); };
  $('#allOff').onclick = () => { S.on = false; group(s => s.cfg.off(s)); save(); };
  $('#segNone').onclick = () => { selected.clear(); color(); };
  $('#wideGovee').onclick = () => strips[0].pair(true);
  $('#wideBj').onclick = () => strips[1].pair(true);
  $('#copyLog').onclick = () => {
    const txt = logLines.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => log('Journal copié'), () => log('Copie impossible'));
  };
  render();
}

async function restore() {
  if (!navigator.bluetooth) return;
  try {
    const ok = navigator.bluetooth.getAvailability ? await navigator.bluetooth.getAvailability() : true;
    if (!ok) banner('Le Bluetooth du téléphone semble éteint. Active-le puis recharge la page.');
    navigator.bluetooth.addEventListener('availabilitychanged', e => {
      banner(e.value ? '' : 'Le Bluetooth du téléphone a été coupé.');
      if (e.value) wakeAll();
    });
  } catch (e) {}
  if (!navigator.bluetooth.getDevices) {
    log('Reconnexion auto indisponible sur ce Chrome : touche Connecter à chaque ouverture');
    return;
  }
  let devs = [];
  try { devs = await navigator.bluetooth.getDevices(); } catch (e) { return; }
  for (const s of strips) {
    const saved = store.get('dev.' + s.id, null);
    if (!saved) continue;
    const d = devs.find(x => x.id === saved.id) || devs.find(x => saved.name && x.name === saved.name);
    if (!d) continue;
    s.use(d);
    s.wanted = true;
    s.watch();
    s.connect();
  }
}

function wakeAll() {
  strips.forEach(s => {
    if (s.wanted && !s.ready && !s.connecting && !s.sleeping) {
      s.fails = 0;
      s.connect();
    }
  });
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeAll(); });
window.addEventListener('unhandledrejection', e => log('Erreur : ' + ((e.reason && e.reason.message) || e.reason)));

buildUi();
checkSupport();
restore();
$('#ver').textContent = 'version ' + VERSION;
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) {
      reloaded = true;
      location.reload();
    }
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
}
