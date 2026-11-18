/* =====================================================================
   AKOMA NTOASO · link.js — two racks, two browsers, one clock
   ---------------------------------------------------------------------
   · Pairing without a server: the host makes a code (a compressed
     WebRTC offer), the guest pastes or scans it and gets a reply code,
     the host enters the reply. A QR of the host's code opens the rack on
     a phone with the code filled in.
   · The first offer carries only a data channel, so the code stays short.
     Audio, camera and mic are added over that channel afterwards.
   · Clock: both racks measure the offset between their wall clocks over
     the data channel. Play, Stop and Tempo travel as "do this at wall
     time X", so both racks land on the same downbeat as heard from their
     speakers. A rack that presses Play while the other plays joins it on
     the next bar.
   · Sound: each rack sends its master (after the Master chain, never the
     metronome) as stereo Opus at up to 510 kb/s. The partner's mix plays
     straight to the speakers and is never sent back, so there is no loop,
     and it is not in Rec. Align delays it to land a whole beat or bar
     late, which is on the grid again because the music loops.
   ===================================================================== */
(function () {
  'use strict';
  const A = window.AKOMA_LINK; if (!A) return;
  const { hooks, H, el, toast } = A;
  const $ = s => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }];
  const PRE = 'AK1.';
  const HOME = 'https://esoterorist.github.io/akoma/';

  /* ---------- QR code (byte mode, error level L or M, versions 1–40) ---------- */
  const QR = (() => {
    const ECC = { L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28] };
    const BLK = { L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
      M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49] };
    const FMT = { L: 1, M: 0 };
    const raw = v => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
    const dataCw = (v, e) => Math.floor(raw(v) / 8) - ECC[e][v] * BLK[e][v];
    const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 255; };
    const divisor = deg => { const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1; for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = mul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = mul(root, 2); } return r; };
    const rem = (data, dv) => { const r = dv.map(() => 0); for (const b of data) { const f = b ^ r.shift(); r.push(0); dv.forEach((c, i) => { r[i] ^= mul(c, f); }); } return r; };
    const alignPos = v => { if (v === 1) return []; const n = Math.floor(v / 7) + 2, size = v * 4 + 17, step = Math.floor((v * 8 + n * 3 + 5) / (n * 4 - 4)) * 2, r = [6]; for (let p = size - 7; r.length < n; p -= step) r.splice(1, 0, p); return r; };
    function make(bytes, ecl) {
      ecl = ecl || 'L';
      let ver = 1;
      for (; ver <= 40; ver++) if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= dataCw(ver, ecl) * 8) break;
      if (ver > 40) return null;
      const cap = dataCw(ver, ecl) * 8, bits = [];
      const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
      put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16); for (const b of bytes) put(b, 8);
      put(0, Math.min(4, cap - bits.length)); put(0, (8 - bits.length % 8) % 8);
      for (let p = 0xEC; bits.length < cap; p ^= 0xEC ^ 0x11) put(p, 8);
      const data = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }
      // blocks + error correction, interleaved
      const nb = BLK[ecl][ver], el2 = ECC[ecl][ver], rc = Math.floor(raw(ver) / 8), ns = nb - rc % nb, sl = Math.floor(rc / nb), dv = divisor(el2), blocks = [];
      for (let i = 0, k = 0; i < nb; i++) { const dat = data.slice(k, k + sl - el2 + (i < ns ? 0 : 1)); k += dat.length; const ec = rem(dat, dv); if (i < ns) dat.push(0); blocks.push(dat.concat(ec)); }
      const cw = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== sl - el2 || j >= ns) cw.push(b[i]); });
      // modules
      const size = ver * 4 + 17, m = [], fn = [];
      for (let y = 0; y < size; y++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
      const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
      for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
      const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } };
      finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
      const ap = alignPos(ver), na = ap.length;
      for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
      const fmt = mask => {
        const d = FMT[ecl] << 3 | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
        const b = (d << 10 | r) ^ 0x5412, g = i => ((b >>> i) & 1) === 1;
        for (let i = 0; i <= 5; i++) set(8, i, g(i));
        set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8));
        for (let i = 9; i < 15; i++) set(14 - i, 8, g(i));
        for (let i = 0; i < 8; i++) set(size - 1 - i, 8, g(i));
        for (let i = 8; i < 15; i++) set(8, size - 15 + i, g(i));
        set(8, size - 8, true);
      };
      fmt(0);
      if (ver >= 7) {
        let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
        const b = ver << 12 | r;
        for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, d); set(c, a, d); }
      }
      let i = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
          const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
          if (!fn[y][x] && i < cw.length * 8) { m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
        }
      }
      const MK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
        (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
        (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
      const apply = k => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MK[k](x, y)) m[y][x] = !m[y][x]; };
      const score = () => {   // runs, 2×2 boxes and balance; enough to pick a clean mask
        let s = 0, dark = 0;
        for (let a = 0; a < size; a++) for (const row of [true, false]) {
          let run = 1;
          for (let b = 1; b < size; b++) { const p = row ? m[a][b] : m[b][a], q = row ? m[a][b - 1] : m[b - 1][a]; if (p === q) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; }
        }
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { if (m[y][x]) dark++; if (x < size - 1 && y < size - 1) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) s += 3; } }
        return s + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      };
      let best = 0, bs = Infinity;
      for (let k = 0; k < 8; k++) { apply(k); fmt(k); const sc = score(); if (sc < bs) { bs = sc; best = k; } apply(k); }
      apply(best); fmt(best);
      return { size, m };
    }
    function draw(cv, text, px) {
      const q = make(new TextEncoder().encode(text), 'L'); if (!q) return false;
      const quiet = 4, n = q.size + quiet * 2, s = px || Math.max(2, Math.floor(260 / n));
      cv.width = cv.height = n * s;
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, n * s, n * s); g.fillStyle = '#000';
      for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.m[y][x]) g.fillRect((x + quiet) * s, (y + quiet) * s, s, s);
      return true;
    }
    return { make, draw };
  })();
  window.AKOMA_QR = QR;

  /* ---------- pairing codes: deflate + base64url ---------- */
  const b64u = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const u8b = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const pipe = async (u8, T) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(T)).arrayBuffer());
  const slim = sdp => sdp.split(/\r?\n/).filter(l => l && !/^a=(extmap-allow-mixed|msid-semantic)/.test(l) && !(/^a=candidate/.test(l) && / tcp /i.test(l))).join('\r\n') + '\r\n';
  async function encode(type, sdp) {
    const j = new TextEncoder().encode(JSON.stringify({ t: type === 'offer' ? 'o' : 'a', s: slim(sdp) }));
    if (window.CompressionStream) { try { return PRE + 'z' + b64u(await pipe(j, new CompressionStream('deflate-raw'))); } catch (e) {} }
    return PRE + 'j' + b64u(j);
  }
  async function decode(code) {
    code = String(code || '').trim();
    const h = code.match(/[#&?]link=([A-Za-z0-9._-]+)/); if (h) code = decodeURIComponent(h[1]);
    code = code.replace(/\s+/g, '');
    if (!code.startsWith(PRE)) throw new Error('That is not a Link code.');
    const kind = code[PRE.length], body = u8b(code.slice(PRE.length + 1));
    const j = kind === 'z' ? await pipe(body, new DecompressionStream('deflate-raw')) : body;
    const o = JSON.parse(new TextDecoder().decode(j));
    return { type: o.t === 'o' ? 'offer' : 'answer', sdp: o.s };
  }
  // Opus: stereo, full bitrate, no voice tricks. Applied to every description this rack takes from the other.
  const opus = sdp => sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (l, pt, p) => {
    if (!new RegExp('a=rtpmap:' + pt + ' opus/', 'i').test(sdp)) return l;
    const kv = {}; p.split(';').forEach(x => { const [k, v] = x.split('='); if (k) kv[k.trim()] = v; });
    Object.assign(kv, { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000', useinbandfec: '1', cbr: '0' });
    return 'a=fmtp:' + pt + ' ' + Object.keys(kv).map(k => k + '=' + kv[k]).join(';');
  });

  /* ---------- clocks ---------- */
  const wall = () => performance.timeOrigin + performance.now();   // ms
  // ctx time at which a sound is heard at wall time w (ms), and the other way round
  function ctxAt(w) {
    const c = A.ctx();
    if (c.getOutputTimestamp) { const ts = c.getOutputTimestamp(); if (ts && ts.contextTime > 0 && ts.performanceTime > 0) return ts.contextTime + (w - performance.timeOrigin - ts.performanceTime) / 1000; }
    return c.currentTime + (w - wall()) / 1000 - (c.outputLatency || c.baseLatency || 0);
  }
  const wallAt = t => { const c = A.ctx(); return wall() + (t - ctxAt(wall())) * 1000; };
  const outLat = () => { const c = H.ctx; return c ? (c.outputLatency || c.baseLatency || 0) : 0; };

  /* ---------- state ---------- */
  const L = {
    pc: null, dc: null, role: '', phase: 'idle', polite: false, makingOffer: false,
    off: 0, rtt: 0, samples: [], peer: { playing: false, outLat: 0 }, quiet: 0,
    out: null, outT: null, mic: null, cam: null, streams: {}, rx: {}, chat: [],
    align: 'bar', trim: 0, vol: 0.8, talk: 0.9, est: 0, lat: 0, drift: null, timer: 0, statT: 0,
    remoteCam: null, scanS: null,
  };
  try { const s = JSON.parse(localStorage.getItem('ant.link') || '{}'); if (s.align) L.align = s.align; if (isFinite(s.trim)) L.trim = s.trim; if (isFinite(s.vol)) L.vol = s.vol; if (isFinite(s.talk)) L.talk = s.talk; } catch (e) {}
  A.state = L;   // for debugging from the console
  const keep = () => { try { localStorage.setItem('ant.link', JSON.stringify({ align: L.align, trim: L.trim, vol: L.vol, talk: L.talk })); } catch (e) {} };
  const linked = () => !!(L.dc && L.dc.readyState === 'open');
  const send = o => { if (linked()) try { L.dc.send(JSON.stringify(o)); } catch (e) {} };
  const theirs = w => w - L.off;   // their wall time → mine

  /* ---------- hooks the rack calls ---------- */
  hooks.on = linked;
  hooks.want = () => linked() && !L.quiet;
  hooks.lead = () => (linked() ? L.rtt / 2000 + 0.05 : 0);
  hooks.req = () => {
    if (L.peer.playing) { send({ c: 'anchorReq' }); toast('Joining the other rack on its next bar…'); return; }
    const at = wall() + Math.max(900, L.rtt * 1.5 + 600);
    send({ c: 'play', at, bpm: H.bpm });
    quietly(() => A.play({ p: 0, t: () => ctxAt(at) }));
  };
  hooks.started = () => { if (!L.quiet) sendState(); else setTimeout(sendState, 0); };
  hooks.stopped = () => { if (!L.quiet) send({ c: 'stop' }); sendState(); };
  hooks.tempo = (v, p) => send({ c: 'tempo', v, p });
  function quietly(fn) { L.quiet++; try { return fn(); } finally { setTimeout(() => { L.quiet = Math.max(0, L.quiet - 1); }, 0); } }
  function anchor() {   // a bar line near now, and the wall time it is heard
    const p = Math.floor(A.pos() / 16) * 16;
    return { p, at: wallAt(A.timeAt(p)), bpm: H.bpm };
  }
  function sendState() { send({ c: 'state', playing: H.playing, bpm: H.bpm, outLat: outLat(), a: H.playing ? anchor() : null }); }

  /* ---------- connection ---------- */
  function newPc() {
    const pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed') { toast('Link failed: the two browsers could not reach each other.'); hang(true); }
      else if (s === 'disconnected') { setPhase('lost'); }
      else if (s === 'connected' && L.phase === 'lost') setPhase('on');
      ui();
    };
    pc.ontrack = e => onTrack(e);
    pc.onicecandidate = e => { if (e.candidate && linked()) send({ c: 'ice', d: e.candidate.toJSON() }); };
    return pc;
  }
  const gathered = pc => new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const t = setTimeout(res, 4000);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
  async function host() {
    hang(); A.ctx();
    L.role = 'host'; L.polite = false; setPhase('making');
    const pc = L.pc = newPc();
    bindDc(pc.createDataChannel('akoma', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    if (L.pc !== pc) return;
    L.code = await encode('offer', pc.localDescription.sdp);
    setPhase('offer');
  }
  async function join(code) {
    let d; try { d = await decode(code); } catch (e) { toast(e.message || 'That code could not be read.'); return; }
    if (d.type !== 'offer') { toast('That is a reply code. Paste it on the rack that hosts.'); return; }
    hang(); A.ctx();
    L.role = 'guest'; L.polite = true; setPhase('making');
    const pc = L.pc = newPc();
    pc.ondatachannel = e => bindDc(e.channel);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
    } catch (e) { toast('That code is broken or out of date. Ask for a new one.'); hang(); return; }
    await gathered(pc);
    if (L.pc !== pc) return;
    L.code = await encode('answer', pc.localDescription.sdp);
    setPhase('answer');
  }
  async function accept(code) {
    let d; try { d = await decode(code); } catch (e) { toast(e.message || 'That reply could not be read.'); return; }
    if (d.type !== 'answer') { toast('That is a host code. Paste their reply here.'); return; }
    if (!L.pc || L.pc.signalingState !== 'have-local-offer') { toast('Make a fresh code first.'); return; }
    try { await L.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp }); if (L.phase === 'offer') setPhase('wait'); }
    catch (e) { toast('That reply does not belong to this code.'); }
  }
  function bindDc(dc) {
    L.dc = dc;
    dc.onopen = () => onOpen();
    dc.onclose = () => { if (L.dc === dc) { toast('Link closed.'); hang(true); } };
    dc.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (er) { return; } onMsg(m); };
  }
  function onOpen() {
    setPhase('on');
    const pc = L.pc;
    // from here every change of tracks negotiates over the data channel (perfect negotiation: the guest yields)
    pc.onnegotiationneeded = async () => {
      try { L.makingOffer = true; await pc.setLocalDescription(); send({ c: 'sdp', d: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); }
      catch (e) { console.error(e); } finally { L.makingOffer = false; }
    };
    startMix();
    send({ c: 'hello', v: 1, bpm: H.bpm, playing: H.playing, outLat: outLat(), host: L.role === 'host' });
    L.samples = []; ping();
    clearInterval(L.timer); L.timer = setInterval(tick, 1000);
    toast('Linked. Both racks now share Play, Stop and Tempo.');
    ui();
  }
  async function onSdp(d) {
    const pc = L.pc; if (!pc) return;
    const collide = d.type === 'offer' && (L.makingOffer || pc.signalingState !== 'stable');
    if (!L.polite && collide) return;
    try {
      await pc.setRemoteDescription({ type: d.type, sdp: opus(d.sdp) });
      if (d.type === 'offer') { await pc.setLocalDescription(); send({ c: 'sdp', d: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); }
    } catch (e) { console.error(e); }
  }
  function hang(silent) {
    clearInterval(L.timer);
    const pc = L.pc, dc = L.dc;
    L.pc = null; L.dc = null;
    try { dc && dc.close(); } catch (e) {}
    try { pc && pc.close(); } catch (e) {}
    stopMic(); stopCam(true);
    if (L.out && L.outT) { try { A.post().disconnect(L.out); } catch (e) {} }
    L.out = null; L.outT = null;
    for (const k in L.rx) { const r = L.rx[k]; try { r.src.disconnect(); r.g.disconnect(); r.dl && r.dl.disconnect(); } catch (e) {} if (r.au) { r.au.srcObject = null; r.au.remove(); } }
    L.rx = {}; L.streams = {}; L.peer = { playing: false, outLat: 0 }; L.drift = null; L.lat = 0;
    if (L.remoteCam) { L.remoteCam.srcObject = null; }
    L.code = ''; L.role = '';
    if (L.phase !== 'idle') setPhase('idle');
    if (!silent) ui();
  }

  /* ---------- messages ---------- */
  function onMsg(m) {
    switch (m.c) {
      case 'sdp': onSdp(m.d); break;
      case 'ice': if (L.pc && m.d) L.pc.addIceCandidate(m.d).catch(() => {}); break;
      case 'ping': send({ c: 'pong', a: m.a, b: wall() }); break;
      case 'pong': { const c = wall(), rtt = c - m.a; L.samples.push({ rtt, off: m.b - (m.a + c) / 2 }); if (L.samples.length > 12) L.samples.shift();
        const best = L.samples.reduce((x, y) => (y.rtt < x.rtt ? y : x)); L.off = best.off; L.rtt = L.samples.reduce((s, x) => s + x.rtt, 0) / L.samples.length; ui(); break; }
      case 'hello':
        L.peer.playing = !!m.playing; L.peer.outLat = m.outLat || 0;
        // one tempo for both: the host's, unless only the guest is playing
        if (L.role === 'guest' && !H.playing && isFinite(m.bpm)) A.tempo(m.bpm);
        sendStreams(); break;
      case 'state':
        L.peer.playing = !!m.playing; if (isFinite(m.outLat)) L.peer.outLat = m.outLat;
        if (m.a && H.playing) driftCheck(m.a);
        ui(); break;
      case 'play':
        if (H.playing) { sendState(); break; }
        if (isFinite(m.bpm)) A.tempo(m.bpm);
        quietly(() => A.play({ p: 0, t: () => ctxAt(theirs(m.at)) }));
        break;
      case 'anchorReq': if (H.playing) send({ c: 'anchor', a: anchor() }); else send({ c: 'state', playing: false, bpm: H.bpm, outLat: outLat() }); break;
      case 'anchor':
        if (H.playing || !m.a) break;
        if (isFinite(m.a.bpm)) A.tempo(m.a.bpm);
        quietly(() => A.play({ p: m.a.p, t: () => ctxAt(theirs(m.a.at)) }));
        break;
      case 'stop': if (H.playing) quietly(() => A.stop()); break;
      case 'tempo': if (isFinite(m.v)) A.tempo(m.v, m.p); break;
      case 'streams': L.streams = m.s || {}; relabel(); break;
      case 'chat': addChat('them', String(m.t || '').slice(0, 500)); break;
      case 'bye': toast('The other rack left.'); hang(); break;
    }
  }
  function ping() { send({ c: 'ping', a: wall() }); }
  // where their bar line lands here, against where ours is: how far the two clocks have walked apart
  function driftCheck(a) {
    const mine = wallAt(A.timeAt(a.p)), d = mine - theirs(a.at);
    L.drift = Math.abs(d) < 2000 ? d : null;
  }

  /* ---------- sound out: the master, stereo ---------- */
  function startMix() {
    const ctx = A.ctx();
    if (!L.out) {
      L.out = ctx.createMediaStreamDestination(); L.out.channelCount = 2; L.out.channelCountMode = 'explicit';
      A.post().connect(L.out);
      L.outT = L.out.stream.getAudioTracks()[0];
      try { L.outT.contentHint = 'music'; } catch (e) {}
    }
    const s = L.pc.addTrack(L.outT, L.out.stream);
    tune(s, 510000);
  }
  function tune(sender, br) {
    try { const p = sender.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}]; p.encodings[0].maxBitrate = br; p.encodings[0].priority = 'high'; p.encodings[0].networkPriority = 'high'; sender.setParameters(p).catch(() => {}); } catch (e) {}
  }
  function sendStreams() {
    const s = {}; if (L.out) s[L.out.stream.id] = 'mix'; if (L.mic) s[L.mic.stream.id] = 'mic'; if (L.cam) s[L.cam.stream.id] = 'cam';
    send({ c: 'streams', s });
  }
  async function startMic() {
    if (!linked() || L.mic) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const t = stream.getAudioTracks()[0]; try { t.contentHint = 'speech'; } catch (e) {}
      L.mic = { stream, sender: L.pc.addTrack(t, stream) };
      sendStreams();
    } catch (e) { toast('No microphone: ' + (e && e.name === 'NotAllowedError' ? 'permission was refused.' : (e && e.message) || 'not available here.')); }
    ui();
  }
  function stopMic() {
    if (!L.mic) return;
    L.mic.stream.getTracks().forEach(t => t.stop());
    try { if (L.pc && L.pc.signalingState !== 'closed') L.pc.removeTrack(L.mic.sender); } catch (e) {}
    L.mic = null; sendStreams(); ui();
  }
  async function startCam() {
    if (!linked() || L.cam) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } });
      const t = stream.getVideoTracks()[0];
      L.cam = { stream, sender: L.pc.addTrack(t, stream) };
      tune(L.cam.sender, 800000);
      sendStreams();
    } catch (e) { toast('No camera: ' + (e && e.name === 'NotAllowedError' ? 'permission was refused.' : (e && e.message) || 'not available here.')); }
    ui();
  }
  function stopCam(silent) {
    if (!L.cam) return;
    L.cam.stream.getTracks().forEach(t => t.stop());
    try { if (L.pc && L.pc.signalingState !== 'closed') L.pc.removeTrack(L.cam.sender); } catch (e) {}
    L.cam = null; if (!silent) { sendStreams(); ui(); }
  }

  /* ---------- sound in ---------- */
  function onTrack(e) {
    const st = e.streams[0], tr = e.track; if (!st) return;
    if (tr.kind === 'video') {
      if (L.remoteCam) { L.remoteCam.srcObject = st; L.remoteCam.play().catch(() => {}); }
      L.camStream = st;
      tr.onended = tr.onmute = () => ui(); tr.onunmute = () => ui();
      ui(); return;
    }
    if (L.rx[st.id]) return;
    const ctx = A.ctx();
    // Chrome only feeds a remote stream into Web Audio while some media element also plays it (muted)
    const au = new Audio(); au.muted = true; au.srcObject = st; au.play().catch(() => {});
    const src = ctx.createMediaStreamSource(st), g = ctx.createGain(), an = ctx.createAnalyser(); an.fftSize = 512;
    const r = L.rx[st.id] = { src, g, an, au, kind: L.streams[st.id] || 'mix', dl: null };
    src.connect(an);
    wireRx(r);
    try { const rc = e.receiver; if (rc && 'jitterBufferTarget' in rc) rc.jitterBufferTarget = 40; } catch (er) {}
    r.rcv = e.receiver;
    st.onremovetrack = () => { try { src.disconnect(); g.disconnect(); r.dl && r.dl.disconnect(); } catch (er) {} au.srcObject = null; delete L.rx[st.id]; ui(); };
    ui();
  }
  function wireRx(r) {
    const ctx = A.ctx();
    try { r.src.disconnect(); r.g.disconnect(); if (r.dl) r.dl.disconnect(); } catch (e) {}
    r.src.connect(r.an);
    if (r.kind === 'mix') {
      if (!r.dl) r.dl = ctx.createDelay(8);
      r.src.connect(r.dl); r.dl.connect(r.g);
      r.g.gain.value = gainOf(L.vol);
    } else { r.src.connect(r.g); r.g.gain.value = gainOf(L.talk); }
    r.g.connect(ctx.destination);
  }
  function relabel() { for (const id in L.rx) { const r = L.rx[id], k = L.streams[id] || 'mix'; if (k !== r.kind) { r.kind = k; wireRx(r); } } ui(); }
  const gainOf = v => (v <= 0 ? 0 : Math.pow(v / 0.8, 2));
  const mixRx = () => Object.values(L.rx).find(r => r.kind === 'mix');

  // their mix arrives `lat` late (network one way + jitter buffer + codec + output differences). Align holds it back
  // to a whole beat or bar late, which is on the grid again because loops repeat.
  async function measure() {
    const pc = L.pc, r = mixRx(); if (!pc || !r) return;
    let jb = 0.06;
    try {
      const st = await pc.getStats(r.rcv && r.rcv.track ? r.rcv.track : null);
      st.forEach(x => { if (x.type === 'inbound-rtp' && x.kind === 'audio' && x.jitterBufferEmittedCount > 0) {
        const prev = r.jbPrev;
        if (prev && x.jitterBufferEmittedCount > prev.n) jb = (x.jitterBufferDelay - prev.d) / (x.jitterBufferEmittedCount - prev.n);
        else jb = x.jitterBufferDelay / x.jitterBufferEmittedCount;
        r.jbPrev = { d: x.jitterBufferDelay, n: x.jitterBufferEmittedCount };
      } });
    } catch (e) {}
    // their speakers are outLat behind their ctx clock, where the stream leaves; ours add our own output latency
    const est = L.rtt / 2000 + jb + 0.03 + outLat() - (L.peer.outLat || 0);
    L.est = L.est ? L.est * 0.7 + est * 0.3 : est;
    applyAlign();
  }
  function applyAlign() {
    const r = mixRx(); if (!r || !r.dl) return;
    const beat = 60 / H.bpm, unit = L.align === 'bar' ? beat * 4 : L.align === 'beat' ? beat : 0;
    let d = 0;
    if (unit) { const e = Math.max(0, L.est); d = Math.ceil((e + 0.002) / unit) * unit - e; }
    d = clamp(d + L.trim / 1000, 0, 7.9);
    L.lat = (L.est || 0) + d;
    const ctx = A.ctx(), cur = r.dl.delayTime.value;
    if (Math.abs(cur - d) > 0.004) r.dl.delayTime.setTargetAtTime(d, ctx.currentTime, Math.abs(cur - d) > 0.2 ? 0.01 : 0.15);
  }
  function tick() {
    if (!linked()) return;
    ping(); measure();
    if (H.playing && (++L.statT % 4 === 0)) sendState();
    ui();
  }

  /* ---------- chat ---------- */
  function addChat(who, t) { if (!t) return; L.chat.push({ who, t }); if (L.chat.length > 60) L.chat.shift(); ui(); if (who === 'them' && P.hidden) toast('Link · ' + t.slice(0, 80)); }

  /* ---------- scanning a QR (where the browser can) ---------- */
  const canScan = () => 'BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  async function scan(onCode) {
    stopScan();
    let det; try { det = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { toast('This browser cannot read QR codes. Paste the code instead.'); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch (e) { toast('No camera for scanning: ' + ((e && e.message) || 'refused')); return; }
    L.scanS = stream; ui();
    const v = P.querySelector('.lk-scan video'); if (!v) { stopScan(); return; }
    v.srcObject = stream; v.play().catch(() => {});
    const loop = async () => {
      if (L.scanS !== stream) return;
      try { const r = await det.detect(v); if (r && r.length && r[0].rawValue) { stopScan(); onCode(r[0].rawValue); return; } } catch (e) {}
      setTimeout(loop, 180);
    };
    loop();
  }
  function stopScan() { if (L.scanS) { L.scanS.getTracks().forEach(t => t.stop()); L.scanS = null; ui(); } }

  /* ---------- panel ---------- */
  const css = `
.lk{position:fixed;z-index:60;top:64px;right:12px;width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 80px);overflow:auto;background:var(--surface);color:var(--ink);border:1.5px solid var(--ink);box-shadow:6px 6px 0 var(--faint2);font:12px/1.45 var(--mono,ui-monospace,monospace)}
.lk h3{margin:0;padding:8px 10px;font:600 11px/1 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase;display:flex;align-items:center;gap:8px;border-bottom:1.5px solid var(--ink)}
.lk h3 .sp{flex:1}.lk h3 button{all:unset;cursor:pointer;padding:0 4px;font-size:15px}
.lk .bd{padding:10px;display:grid;gap:10px}
.lk p{margin:0;color:var(--mute)}.lk b{color:var(--ink);font-weight:600}
.lk .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.lk .row>.sp{flex:1}
.lk textarea,.lk input[type=text]{width:100%;box-sizing:border-box;background:var(--bg);color:var(--ink);border:1.5px solid var(--ink);font:11px/1.35 var(--mono,monospace);padding:6px;resize:vertical}
.lk textarea{min-height:58px;word-break:break-all}
.lk canvas.qr{display:block;width:min(100%,300px);height:auto;aspect-ratio:1;margin:0 auto;image-rendering:pixelated;border:1.5px solid var(--ink)}
.lk .st{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-variant-numeric:tabular-nums}.lk .st span:nth-child(odd){color:var(--mute)}
.lk .led{display:inline-block;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--ink)}
.lk .led.on{background:var(--live);border-color:var(--live)}.lk .led.warn{background:#d08a1c;border-color:#d08a1c}
.lk input[type=range]{flex:1;min-width:90px;accent-color:var(--ink)}
.lk select{background:var(--bg);color:var(--ink);border:1.5px solid var(--ink);font:11px var(--mono,monospace);padding:3px}
.lk .vid{display:grid;grid-template-columns:1fr;gap:6px}.lk video{width:100%;background:#000;border:1.5px solid var(--ink);aspect-ratio:16/9;object-fit:cover}
.lk video.me{width:40%;justify-self:end;border-width:1px}.lk video.me.pip{width:30%;margin-top:-30%;position:relative}
.lk .chat{max-height:120px;overflow:auto;display:grid;gap:2px;border-top:1px solid var(--faint2);padding-top:6px}
.lk .chat div{white-space:pre-wrap;word-break:break-word}.lk .chat .me{color:var(--mute)}
.lk .lk-scan video{aspect-ratio:1;object-fit:cover}
.lk .meter{height:6px;flex:1;background:var(--faint);position:relative;min-width:60px}.lk .meter i{position:absolute;left:0;top:0;bottom:0;background:var(--ink)}
.lk .mut{color:var(--mute)}
.lk hr{border:0;border-top:1px solid var(--faint2);margin:0}
#bLink.on{background:var(--ink);color:var(--bg)}`;
  document.head.append(el('style', null, css));
  const P = el('div', { class: 'lk', role: 'dialog', 'aria-label': 'Link', hidden: '' });
  document.body.append(P);
  const btn = $('#bLink');
  const place = () => { const h = document.querySelector('header.bar'); P.style.top = Math.round((h ? h.getBoundingClientRect().bottom : 56) + 8) + 'px'; };
  window.addEventListener('resize', place);
  if (btn) btn.onclick = () => { P.hidden = !P.hidden; place(); ui(); };

  // the claude.ai viewer and some embeds refuse WebRTC; the rack's own site allows it
  const rtcOk = (() => { try { const p = new RTCPeerConnection(); p.close(); return true; } catch (e) { return false; } })();
  function setPhase(p) { L.phase = p; ui(); }
  const B = (label, on, attrs) => el('button', Object.assign({ class: 'btn sm', type: 'button', onclick: on }, attrs || {}), label);
  const ms = v => (isFinite(v) ? Math.round(v) + ' ms' : '—');
  function shareUrl(code) {
    const here = /(^|\.)github\.io$|^localhost$|^127\.0\.0\.1$/.test(location.hostname) ? location.origin + location.pathname : HOME;
    return here + '#link=' + code;
  }
  async function copy(t) {
    try { await navigator.clipboard.writeText(t); toast('Copied.'); }
    catch (e) { const ta = P.querySelector('textarea[readonly]'); if (ta) { ta.focus(); ta.select(); } toast('Press Ctrl/Cmd+C to copy.'); }
  }
  function codeBlock(code, asUrl, label) {
    const qrText = asUrl ? shareUrl(code) : code;
    const cv = el('canvas', { class: 'qr', 'aria-label': 'QR code of ' + label });
    const ok = QR.draw(cv, qrText, 4);
    const ta = el('textarea', { readonly: '', rows: 3, 'aria-label': label }); ta.value = asUrl ? shareUrl(code) : code;
    ta.onfocus = () => ta.select();
    const share = navigator.share ? B('Share…', () => navigator.share({ text: ta.value }).catch(() => {})) : null;
    return [ok ? cv : el('p', null, 'Too long for a QR here: send the text.'), ta, el('div', { class: 'row' }, B('Copy', () => copy(ta.value)), share)];
  }
  function pasteBlock(label, onGo, goLabel) {
    const ta = el('textarea', { rows: 3, placeholder: label, 'aria-label': label, spellcheck: 'false' });
    const go = B(goLabel, () => onGo(ta.value), { class: 'btn sm solid' });
    const sc = canScan() ? B('Scan QR', () => scan(v => { ta.value = v; onGo(v); })) : null;
    const box = el('div', { class: 'lk-scan', hidden: L.scanS ? null : '' }, el('video', { playsinline: '', muted: '' }), el('div', { class: 'row' }, el('span', { class: 'sp' }), B('Stop scanning', stopScan)));
    return [ta, el('div', { class: 'row' }, go, sc), box];
  }
  function slider(label, v, on, title) {
    const r = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: v, title: title || '', 'aria-label': label });
    r.oninput = () => on(+r.value); r.ondblclick = () => { r.value = 0.8; on(0.8); };
    return el('div', { class: 'row' }, el('span', { style: 'width:78px;color:var(--mute)' }, label), r);
  }
  let lastBody = '';
  function ui() {
    if (btn) { btn.classList.toggle('on', linked()); btn.setAttribute('aria-pressed', String(linked())); btn.textContent = linked() ? 'Linked' : (L.phase !== 'idle' ? 'Link…' : 'Link'); }
    if (P.hidden) { stopScanIfHidden(); return; }
    const camLive = !!(L.camStream && L.camStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted));
    const key = [L.phase, L.role, !!L.mic, !!L.cam, camLive, !!L.scanS, L.chat.length, L.align, L.code].join('|');
    if (key === lastBody) { live(); return; }
    lastBody = key;
    const body = el('div', { class: 'bd' });
    const head = el('h3', null, el('span', { class: 'led' + (linked() ? ' on' : L.phase === 'lost' ? ' warn' : '') }), 'Link', el('span', { class: 'sp' }), el('button', { type: 'button', title: 'Close (the link stays up)', 'aria-label': 'Close', onclick: () => { P.hidden = true; ui(); } }, '×'));
    const ph = L.phase;
    if (ph === 'idle' && !rtcOk) {
      body.append(
        el('p', null, 'Link can\u2019t run in this window: it blocks the direct browser-to-browser connection Link needs.'),
        el('p', null, 'Open the rack on its own site and pair there: ', el('a', { href: HOME, target: '_blank', rel: 'noopener' }, HOME.replace(/^https:\/\//, ''))));
    } else if (ph === 'idle') {
      body.append(
        el('p', null, 'Jam with someone in another browser. Both racks share one clock: ', el('b', null, 'Play, Stop and Tempo'), ' move together, and each of you hears the other’s mix. Camera, mic and chat are optional.'),
        el('div', { class: 'row' }, B('Host a jam', host, { class: 'btn sm solid' }), el('span', { class: 'mut' }, 'you make a code')),
        el('hr'),
        el('p', null, 'Got a code? Paste it, or scan their QR.'),
        ...pasteBlock('Paste their code here', join, 'Join'),
        el('p', null, 'Works across a room or the internet. Behind some strict office or mobile networks the two browsers can’t reach each other directly; then try another network.'));
    } else if (ph === 'making') {
      body.append(el('p', null, 'Making the code…'));
    } else if (ph === 'offer') {
      body.append(
        el('p', null, el('b', null, '1.'), ' Send this to the other person, or let them scan it. On a phone the QR opens the rack with the code filled in.'),
        ...codeBlock(L.code, true, 'Your host code'),
        el('hr'),
        el('p', null, el('b', null, '2.'), ' They get a reply code. Paste or scan it here.'),
        ...pasteBlock('Paste their reply here', accept, 'Connect'),
        el('div', { class: 'row' }, el('span', { class: 'sp' }), B('Cancel', () => hang())));
    } else if (ph === 'answer') {
      body.append(
        el('p', null, 'Send this reply back to the host, or let them scan it from your screen. The link opens as soon as they enter it.'),
        ...codeBlock(L.code, false, 'Your reply code'),
        el('div', { class: 'row' }, el('span', { class: 'mut' }, 'Waiting for the host…'), el('span', { class: 'sp' }), B('Cancel', () => hang())));
    } else if (ph === 'wait') {
      body.append(el('p', null, 'Connecting…'), el('div', { class: 'row' }, el('span', { class: 'sp' }), B('Cancel', () => hang())));
    } else {
      const st = el('div', { class: 'st' });
      body.append(
        el('p', null, ph === 'lost' ? 'Connection dropped, trying to get it back…' : el('span', null, 'Linked as ', el('b', null, L.role === 'host' ? 'host' : 'guest'), '. Play, Stop and Tempo here move both racks.')),
        st,
        el('div', { class: 'row' }, el('span', { style: 'width:78px;color:var(--mute)' }, 'Their mix'), el('div', { class: 'meter', 'data-m': 'mix' }, el('i'))),
        slider('Level', L.vol, v => { L.vol = v; const r = mixRx(); if (r) r.g.gain.setTargetAtTime(gainOf(v), A.ctx().currentTime, 0.02); keep(); }, 'Their mix in your speakers. Double-click: 0 dB'),
        (() => {
          const s = el('select', { 'aria-label': 'Align their mix' },
            el('option', { value: 'bar' }, 'one bar late (on the grid)'), el('option', { value: 'beat' }, 'one beat late (on the grid)'), el('option', { value: 'off' }, 'as fast as possible'));
          s.value = L.align; s.onchange = () => { L.align = s.value; keep(); applyAlign(); ui(); };
          const tr = el('input', { type: 'number', step: 1, min: -500, max: 500, value: L.trim, style: 'width:62px', title: 'Fine trim in ms, if their hits sit early or late', 'aria-label': 'Trim in milliseconds' });
          tr.onchange = () => { L.trim = clamp(+tr.value || 0, -500, 500); keep(); applyAlign(); };
          return el('div', { class: 'row' }, el('span', { style: 'width:78px;color:var(--mute)' }, 'Align'), s, tr, el('span', { class: 'mut' }, 'ms'));
        })(),
        el('p', null, L.align === 'off' ? 'Their mix comes in as soon as it arrives, so it sits a little behind your beat.' : 'Their mix is held back so it lands on your grid, a whole ' + (L.align === 'bar' ? 'bar' : 'beat') + ' after they played it. Loops line up; live tweaks reach you that much later.'),
        el('hr'),
        el('div', { class: 'row' }, B(L.mic ? 'Mic on' : 'Mic', () => (L.mic ? stopMic() : startMic()), { 'aria-pressed': String(!!L.mic), class: 'btn sm' + (L.mic ? ' solid' : '') }),
          B(L.cam ? 'Camera on' : 'Camera', () => (L.cam ? stopCam() : startCam()), { 'aria-pressed': String(!!L.cam), class: 'btn sm' + (L.cam ? ' solid' : '') }),
          el('span', { class: 'sp' }), el('div', { class: 'meter', 'data-m': 'mic', title: 'Their mic' }, el('i'))),
        slider('Their mic', L.talk, v => { L.talk = v; for (const r of Object.values(L.rx)) if (r.kind === 'mic') r.g.gain.setTargetAtTime(gainOf(v), A.ctx().currentTime, 0.02); keep(); }),
        el('p', null, 'Their mic and camera are never in your Rec or sent back. Use headphones with the mic on.'));
      const vid = el('div', { class: 'vid' });
      const rv = L.remoteCam = el('video', { autoplay: '', playsinline: '', muted: '' }); rv.muted = true;
      if (camLive) { rv.srcObject = L.camStream; vid.append(rv); }
      if (L.cam) { const me = el('video', { class: 'me' + (camLive ? ' pip' : ''), autoplay: '', playsinline: '', muted: '' }); me.muted = true; me.srcObject = L.cam.stream; vid.append(me); }
      if (vid.childNodes.length) body.append(vid);
      const chat = el('div', { class: 'chat', 'aria-live': 'polite' }, ...L.chat.map(c => el('div', { class: c.who }, (c.who === 'me' ? '› ' : '‹ ') + c.t)));
      const inp = el('input', { type: 'text', placeholder: 'Message', maxlength: 500, 'aria-label': 'Chat message' });
      inp.onkeydown = e => { if (e.key === 'Enter' && inp.value.trim()) { const t = inp.value.trim(); send({ c: 'chat', t }); addChat('me', t); setTimeout(() => { const n = P.querySelector('.chat + input'); if (n) n.focus(); }, 0); } };
      body.append(el('hr'), chat, inp, el('div', { class: 'row' }, el('span', { class: 'sp' }), B('Disconnect', () => { send({ c: 'bye' }); setTimeout(() => hang(), 50); })));
      setTimeout(() => { chat.scrollTop = chat.scrollHeight; }, 0);
    }
    P.replaceChildren(head, body);
    if (L.scanS) { const v = P.querySelector('.lk-scan video'); if (v) { v.srcObject = L.scanS; v.play().catch(() => {}); } }
    live();
  }
  function stopScanIfHidden() { if (L.scanS) stopScan(); }
  // numbers and meters, without rebuilding the panel
  function live() {
    const st = P.querySelector('.st'); if (!st) return;
    const rows = [['Round trip', ms(L.rtt)], ['Their mix', L.est ? 'arrives ' + ms(L.est * 1000) + ' late' + (L.align !== 'off' ? ', heard ' + ms(L.lat * 1000) + ' late' : '') : 'waiting…'],
      ['Clocks', L.drift == null ? (H.playing && L.peer.playing ? 'measuring…' : 'in step on the next Play') : (Math.abs(L.drift) < 6 ? 'in step' : 'apart by ' + ms(Math.abs(L.drift)) + (Math.abs(L.drift) > 25 ? ' · Stop and Play again to re-lock' : ''))],
      ['Them', L.peer.playing ? 'playing' : 'stopped']];
    st.replaceChildren(...rows.flatMap(([a, b]) => [el('span', null, a), el('span', null, b)]));
  }
  const buf = new Float32Array(512);
  (function meters() {
    requestAnimationFrame(meters);
    if (P.hidden || !linked()) return;
    for (const k of ['mix', 'mic']) {
      const m = P.querySelector('[data-m="' + k + '"] i'); if (!m) continue;
      const r = Object.values(L.rx).find(x => x.kind === k); let pk = 0;
      if (r) { r.an.getFloatTimeDomainData(buf); for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i])); }
      m.style.width = Math.min(100, pk > 0 ? Math.max(0, 100 + 20 * Math.log10(pk) * 100 / 60) : 0) + '%';
    }
  })();

  // a QR scanned with a phone camera opens the rack with #link=…: go straight to the reply
  function fromHash() {
    const m = location.hash.match(/link=([A-Za-z0-9._-]+)/); if (!m) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    P.hidden = false; place(); ui();
    toast('Link code found. Tap Join to make your reply.');
    // audio needs a tap on most phones, so the code waits in the box
    setTimeout(() => { const ta = P.querySelector('textarea'); if (ta) ta.value = decodeURIComponent(m[1]); }, 0);
  }
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('pagehide', () => { if (linked()) send({ c: 'bye' }); });
  fromHash();
  ui();
})();
