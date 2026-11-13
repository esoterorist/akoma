/* =====================================================================
   HEXTRIG · core.js
   One engine for everything you hear. The same pure-JS code runs in an
   AudioWorklet live and in an OfflineAudioContext when bouncing, so a
   bounce is what you heard.

   It rebuilds the old per-hit Web Audio graph sample for sample where it
   can, including the browser's own habits:
     · oscillators read the browser's band-limited wavetables (36 ranges,
       3 per octave, normalised to the full-band peak) with its range
       crossfade, and play 440 Hz for min(r, 128 − r) samples when they
       start r frames into a render block (measured)
     · AudioParam timelines: setValue, linear / exponential ramps,
       setTarget, value curves, cancel-and-hold, as the spec computes them
     · biquads with the spec formulas (LP / HP Q in dB, BP Q linear)
     · the drive shapers' tables, 2× oversampled (95-tap halfband)
     · the browser's DynamicsCompressor, ported (curve, detector, adaptive
       release, 6 ms look-ahead)
   The reverb stays a ConvolverNode on the page: output 2 feeds it and its
   return comes back on input 1.
   Nothing sounding = nothing computed.

   Loaded three ways: as a page script (HXT_CORE, used by the main-thread
   fallback and for note lengths), as an AudioWorklet module, and in Node
   for tests (module.exports).
   ===================================================================== */
const HXT_CORE = (() => {
'use strict';
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const lerp = (a, b, t) => a + (b - a) * t;
const pick = (arr, x) => arr[Math.min(arr.length - 1, Math.floor(x * arr.length))];

/* ---------- the browser's band-limited wavetables ---------- */
function fft(re, im, inv) {   // in place, radix 2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inv ? 1 : -1) * TAU / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}
const WAVES = {};
function waveSet(sr, type) {   // type 1 square, 2 sawtooth, 3 triangle
  const key = sr + ':' + type; if (WAVES[key]) return WAVES[key];
  const N = sr <= 24000 ? 2048 : sr <= 88200 ? 4096 : 16384, half = N / 2, maxP = half;
  const ranges = Math.floor(0.5 + 3 * Math.log2(N));
  const b = new Float64Array(half);
  for (let n = 1; n < half; n++) { const pf = 2 / (n * Math.PI);
    b[n] = type === 1 ? ((n & 1) ? 2 * pf : 0) : type === 2 ? pf * ((n & 1) ? 1 : -1) : ((n & 1) ? 2 * pf * pf * ((((n - 1) >> 1) & 1) ? -1 : 1) : 0); }
  const tabs = []; let norm = 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let r = 0; r < ranges; r++) {
    const parts = Math.floor(Math.pow(2, -r * 400 / 1200) * maxP);
    re.fill(0); im.fill(0);
    for (let n = 1; n < Math.min(half, parts + 1); n++) im[n] = -b[n];   // −i·b: real part of the inverse is Σ b sin
    fft(re, im, true);
    const t = new Float32Array(N + 1);
    if (r === 0) { let mx = 0; for (let i = 0; i < N; i++) mx = Math.max(mx, Math.abs(re[i])); norm = mx ? 1 / mx : 1; }
    for (let i = 0; i < N; i++) t[i] = re[i] * norm; t[N] = t[0];
    tabs.push(t);
  }
  return (WAVES[key] = { N, tabs, ranges, low: (sr / 2) / maxP, scale: N / sr });
}
function sineSet(sr) { const key = sr + ':0'; if (WAVES[key]) return WAVES[key];
  const N = sr <= 24000 ? 2048 : sr <= 88200 ? 4096 : 16384, t = new Float32Array(N + 1); for (let i = 0; i <= N; i++) t[i] = Math.sin(TAU * i / N);
  return (WAVES[key] = { N, tabs: [t], ranges: 1, low: 1, scale: N / sr, sine: true }); }

/* ---------- AudioParam timeline ----------
   Events in frames (fractional). Types: 0 set, 1 linear ramp, 2 exponential ramp, 3 target, 4 curve.
   at(F) evaluates any frame the way the spec does; fill() renders a block walking segment by segment (ramps by step,
   exponentials and targets by one multiply per sample), and goes flat once nothing moves any more. */
function Par(v) { this.d = v; this.ev = []; this.p = 0; this.v = v; this.flat = true; }
Par.prototype.set = function (v, f) { this.add({ y: 0, f, v }); return this; };
Par.prototype.lin = function (v, f) { this.add({ y: 1, f, v }); return this; };
Par.prototype.exp = function (v, f) { this.add({ y: 2, f, v }); return this; };
Par.prototype.tgt = function (v, f, tcF) { this.add({ y: 3, f, v, m: tcF > 0 ? 1 / tcF : 1e9 }); return this; };
Par.prototype.curve = function (c, f, dF) { this.add({ y: 4, f, c, d: dF, v: c[c.length - 1] }); return this; };
Par.prototype.add = function (e) {
  const ev = this.ev;
  // the spec forbids events inside a curve; the old graph ignored those (try/catch)
  for (let j = 0; j < ev.length; j++) { const c = ev[j]; if (c.y === 4 && e.f > c.f && e.f < c.f + c.d) return; }
  if (this.flat) { ev.length = 0; ev.push({ y: 0, f: -1e9, v: this.v }); this.p = 1; }
  let i = ev.length; while (i > 0 && ev[i - 1].f > e.f) i--;
  ev.splice(i, 0, e); this.flat = false; if (i < this.p) this.p = i;
};
// value at frame F (no state)
Par.prototype.at = function (F) {
  const ev = this.ev; if (this.flat) return this.v;
  let k = -1; for (let i = 0; i < ev.length; i++) { if (ev[i].f <= F) k = i; else break; }
  const nx = ev[k + 1];
  if (nx && (nx.y === 1 || nx.y === 2)) {
    const t0 = k < 0 ? 0 : ev[k].f, v0 = k < 0 ? this.d : this.startOf(k, t0);
    const u = (F - t0) / (nx.f - t0);
    if (nx.y === 1) return v0 + (nx.v - v0) * u;
    return (v0 > 0 && nx.v > 0) || (v0 < 0 && nx.v < 0) ? v0 * Math.pow(nx.v / v0, u) : v0;
  }
  return k < 0 ? this.d : this.valAt(k, F);
};
// value at F of event k (F ≥ its start), with nothing after it applying yet
Par.prototype.valAt = function (k, F) {
  const e = this.ev[k];
  switch (e.y) {
    case 3: return e.v + (this.vs(k) - e.v) * Math.exp(-(F - e.f) * e.m);
    case 4: { const c = e.c, n = c.length, u = (F - e.f) / e.d; if (u >= 1) return c[n - 1]; const x = u * (n - 1), i = x | 0; return i + 1 < n ? c[i] + (c[i + 1] - c[i]) * (x - i) : c[n - 1]; }
  }
  return e.v;
};
Par.prototype.startOf = function (k, t0) { const e = this.ev[k]; return e.y === 3 || e.y === 4 ? this.valAt(k, t0) : e.v; };
// where a target starts from: the value just before it (cached; nothing before it changes later)
Par.prototype.vs = function (k) { const e = this.ev[k]; if (e.s === undefined) { const sv = this.ev.slice(0, k); const q = new Par(this.d); q.ev = sv; q.flat = !sv.length; q.v = this.d; e.s = sv.length ? q.at(e.f) : this.d; } return e.s; };
// cancelAndHoldAtTime(F): keep what happens before F, hold the value it has at F
Par.prototype.hold = function (F) {
  const v = this.at(F);
  if (this.flat) { this.ev.length = 0; this.ev.push({ y: 0, f: -1e9, v: this.v }); this.p = 1; }
  const ev = this.ev; let i = 0; while (i < ev.length && ev[i].f <= F) i++;
  const nx = ev[i]; ev.length = i;
  ev.push(nx && (nx.y === 1 || nx.y === 2) ? { y: nx.y, f: F, v } : { y: 0, f: F, v });
  this.flat = false; if (this.p > i) this.p = i;
};
Par.prototype.settle = function (v) { this.v = v; this.flat = true; this.ev.length = 0; this.p = 0; };
// render frames [F0, F0 + n) into dst; returns true when the value moves inside the block
Par.prototype.fill = function (dst, F0, n) {
  if (this.flat) { const v = this.v; for (let i = 0; i < n; i++) dst[i] = v; return false; }
  const ev = this.ev; let k = 0, moved = false;
  while (k < n) {
    const F = F0 + k;
    while (this.p < ev.length && ev[this.p].f <= F) this.p++;
    const li = this.p - 1, e = ev[li], nx = ev[this.p];
    const end = nx ? Math.min(n, Math.max(k + 1, Math.ceil(nx.f) - F0)) : n;
    if (nx && (nx.y === 1 || nx.y === 2)) {
      const t0 = li < 0 ? 0 : e.f, v0 = li < 0 ? this.d : this.startOf(li, t0), span = nx.f - t0;
      if (nx.y === 1) { const sl = (nx.v - v0) / span; for (let j = k; j < end; j++) dst[j] = v0 + sl * (F0 + j - t0); }
      else if ((v0 > 0 && nx.v > 0) || (v0 < 0 && nx.v < 0)) { const r = Math.pow(nx.v / v0, 1 / span); let v = v0 * Math.pow(nx.v / v0, (F - t0) / span); for (let j = k; j < end; j++) { dst[j] = v; v *= r; } }
      else for (let j = k; j < end; j++) dst[j] = v0;
      moved = true;
    } else if (li < 0) { const v = this.d; for (let j = k; j < end; j++) dst[j] = v; }
    else if (e.y === 3) {
      const tv = e.v, m = Math.exp(-e.m); let v = tv + (this.vs(li) - tv) * Math.exp(-(F - e.f) * e.m);
      for (let j = k; j < end; j++) { dst[j] = v; v = tv + (v - tv) * m; }
      moved = true;
      if (!nx && Math.abs(v - tv) <= 1e-7 * Math.max(1e-3, Math.abs(tv))) { this.settle(tv); return true; }
    } else if (e.y === 4) {
      const c = e.c, N1 = c.length - 1, sc = N1 / e.d;
      for (let j = k; j < end; j++) { const x = (F0 + j - e.f) * sc; if (x >= N1) dst[j] = c[N1]; else { const i = x | 0; dst[j] = c[i] + (c[i + 1] - c[i]) * (x - i); } }
      moved = true;
      if (!nx && F0 + end - e.f >= e.d) { this.settle(c[N1]); return true; }
    } else {
      const v = e.v; for (let j = k; j < end; j++) dst[j] = v;
      if (!nx) { this.settle(v); return moved; }
    }
    k = end;
  }
  return moved;
};
Par.prototype.now = function (F) { return this.flat ? this.v : this.at(F); };

/* ---------- oscillator: wavetable, per-sample frequency (own timeline + FM input), detune ----------
   The browser's habit, measured: in an oscillator's first render block it reads its per-sample frequency from the start of
   the block instead of from where it started, r frames in. So for its first 128 − r samples it hears the frequency (and any FM
   input) r frames early: the default 440 Hz before its own start, then its timeline and its modulator r samples late. From the
   next block on everything lines up. A start right on a block edge keeps its sub-sample offset; others start at phase 0. */
function Osc(W, start, a, sr) {
  this.W = W; this.st = start; this.sr = sr;
  const r = start & 127; this.r = r; this.edge = start - r + 128;
  this.off = r === 0 ? a : 0;
  this.ph = 0; this.fr = new Par(440); this.dt = null; this.fm = null; this.lf = -1; this.t1 = null; this.t2 = null; this.tf = 0;
}
Osc.prototype.pickTab = function (f) {
  const W = this.W; if (W.sine) { this.t1 = this.t2 = W.tabs[0]; this.tf = 0; return; }
  const af = Math.abs(f), ratio = af > 0 ? af / W.low : 0.5;
  let pr = 1 + Math.log2(ratio) * 3;   // 1200 cents per octave / 400 per range
  pr = Math.max(0, Math.min(W.ranges - 1, pr));
  const i1 = pr | 0, i2 = i1 < W.ranges - 1 ? i1 + 1 : i1;
  this.t1 = W.tabs[i1]; this.t2 = W.tabs[i2]; this.tf = pr - i1;
};
// fill cnt samples; n0 = frames since start; F0 = absolute frame of dst[0]; S, S2 = scratch
Osc.prototype.fill = function (dst, cnt, n0, F0, S, S2) {
  const W = this.W, N = W.N, sc = W.scale, nyq = this.sr / 2, fm = this.fm, dt = this.dt;
  const fmv = this.fr.fill(S, F0, cnt);
  if (dt) { if (dt.fill(S2, F0, cnt)) for (let k = 0; k < cnt; k++) S[k] *= Math.pow(2, S2[k] / 1200); else { const m = Math.pow(2, S2[0] / 1200); for (let k = 0; k < cnt; k++) S[k] *= m; } }
  if (fm) for (let k = 0; k < cnt; k++) S[k] += fm[k];
  if (F0 < this.edge && this.r) {   // first block: everything r samples early
    const r = this.r, st = this.st;
    for (let k = 0; k < cnt && F0 + k < this.edge; k++) {
      const j = n0 + k - r;
      S[k] = j < 0 ? 440 : this.fr.at(st + j) * (dt ? Math.pow(2, dt.at(st + j) / 1200) : 1) + (fm ? fm[k - r] : 0);
    }
  }
  let ph = this.ph, k0 = 0;
  if (n0 === 0 && this.off) { let f = S[0]; if (f > nyq) f = nyq; else if (f < -nyq) f = -nyq; ph = this.off * f * sc; ph -= Math.floor(ph / N) * N; }
  if (W.sine) {
    const t = W.tabs[0];
    for (let k = k0; k < cnt; k++) {
      let f = S[k]; if (f > nyq) f = nyq; else if (f < -nyq) f = -nyq;
      const i = ph | 0, fr = ph - i; dst[k] = t[i] + (t[i + 1] - t[i]) * fr;
      ph += f * sc; if (ph >= N) ph -= N; else if (ph < 0) ph += N;
    }
  } else if (!fmv && !fm && !(dt && !dt.flat) && !(F0 < this.edge && this.r)) {   // steady pitch: one table pick per block
    let f = S[0]; if (f > nyq) f = nyq; else if (f < -nyq) f = -nyq;
    if (f !== this.lf) { this.lf = f; this.pickTab(f); }
    const t1 = this.t1, t2 = this.t2, tf = this.tf, inc = f * sc;
    if (tf) for (let k = 0; k < cnt; k++) { const i = ph | 0, fr = ph - i, hi = t1[i] + (t1[i + 1] - t1[i]) * fr; dst[k] = hi + (t2[i] + (t2[i + 1] - t2[i]) * fr - hi) * tf; ph += inc; if (ph >= N) ph -= N; else if (ph < 0) ph += N; }
    else for (let k = 0; k < cnt; k++) { const i = ph | 0, fr = ph - i; dst[k] = t1[i] + (t1[i + 1] - t1[i]) * fr; ph += inc; if (ph >= N) ph -= N; else if (ph < 0) ph += N; }
  } else {
    for (let k = k0; k < cnt; k++) {
      let f = S[k]; if (f > nyq) f = nyq; else if (f < -nyq) f = -nyq;
      if (f !== this.lf) { this.lf = f; this.pickTab(f); }
      const i = ph | 0, fr = ph - i, t1 = this.t1, hi = t1[i] + (t1[i + 1] - t1[i]) * fr;
      dst[k] = this.tf ? hi + (this.t2[i] + (this.t2[i + 1] - this.t2[i]) * fr - hi) * this.tf : hi;
      ph += f * sc; if (ph >= N) ph -= N; else if (ph < 0) ph += N;
    }
  }
  this.ph = ph;
};

/* ---------- biquad (Web Audio spec formulas) ---------- */
const LP = 0, HP = 1, BP = 2;
function bqSet(F, type, freq, Q, sr) {
  const nyq = sr / 2, fn = clamp(freq / nyq, 0, 1);
  let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  if (type === LP) {
    if (fn >= 1) b0 = 1; else if (fn <= 0) b0 = 0;
    else { const th = Math.PI * fn, al = Math.sin(th) / (2 * Math.pow(10, Q / 20)), c = Math.cos(th), be = (1 - c) / 2, a0 = 1 + al;
      b0 = be / a0; b1 = 2 * be / a0; b2 = be / a0; a1 = -2 * c / a0; a2 = (1 - al) / a0; }
  } else if (type === HP) {
    if (fn >= 1) b0 = 0; else if (fn <= 0) b0 = 1;
    else { const th = Math.PI * fn, al = Math.sin(th) / (2 * Math.pow(10, Q / 20)), c = Math.cos(th), be = (1 + c) / 2, a0 = 1 + al;
      b0 = be / a0; b1 = -2 * be / a0; b2 = be / a0; a1 = -2 * c / a0; a2 = (1 - al) / a0; }
  } else {
    if (fn > 0 && fn < 1) { if (Q > 0) { const th = Math.PI * fn, al = Math.sin(th) / (2 * Q), c = Math.cos(th), a0 = 1 + al;
      b0 = al / a0; b1 = 0; b2 = -al / a0; a1 = -2 * c / a0; a2 = (1 - al) / a0; } else b0 = 1; }
    else b0 = 0;
  }
  F.b0 = b0; F.b1 = b1; F.b2 = b2; F.a1 = a1; F.a2 = a2; F.cf = freq; F.cq = Q;
  return F;
}
function Bq(type, freq, Q, sr) { this.t = type; this.sr = sr; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.f = new Par(freq); this.q = new Par(Q); bqSet(this, type, freq, Q, sr); }
/* one block in place. While frequency or Q move, the browser recomputes the coefficients every sample (measured, 98 dB match);
   here they are recomputed whenever the frequency has moved by 1/10 000 or Q by 1/10 000 dB since (88 dB match, a fraction of the work) */
Bq.prototype.run = function (x, cnt, F0, S, S2) {
  const fm = this.f.fill(S, F0, cnt), qm = this.q.fill(S2, F0, cnt);
  if (!fm && !qm) { if (S[0] !== this.cf || S2[0] !== this.cq) bqSet(this, this.t, S[0], S2[0], this.sr); bqRun(this, x, 0, cnt); return; }
  let b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2, x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
  for (let k = 0; k < cnt; k++) {
    const f = S[k], q = S2[k], cf = this.cf;
    if (Math.abs(f - cf) > cf * 1e-4 || Math.abs(q - this.cq) > 1e-4) { bqSet(this, this.t, f, q, this.sr); b0 = this.b0; b1 = this.b1; b2 = this.b2; a1 = this.a1; a2 = this.a2; }
    const xi = x[k], y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = y; x[k] = y;
  }
  this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
};
function bqRun(F, x, a, b) {
  const b0 = F.b0, b1 = F.b1, b2 = F.b2, a1 = F.a1, a2 = F.a2; let x1 = F.x1, x2 = F.x2, y1 = F.y1, y2 = F.y2;
  for (let k = a; k < b; k++) { const xi = x[k], y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = y; x[k] = y; }
  F.x1 = x1; F.x2 = x2; F.y1 = y1; F.y2 = y2;
}
function bqS(F, x) { const y = F.b0 * x + F.b1 * F.x1 + F.b2 * F.x2 - F.a1 * F.y1 - F.a2 * F.y2; F.x2 = F.x1; F.x1 = x; F.y2 = F.y1; F.y1 = y; return y; }
const bqPlain = (type, f, q, sr) => bqSet({ x1: 0, x2: 0, y1: 0, y2: 0 }, type, f, q, sr);


/* ---------- noise: the old graph looped 2 s of white noise from a random offset. A sample player reads between samples
   (linear interpolation, a = how far), which softens the top a little; the offset was random, so a is too. ---------- */
function Nz(seed) { this.s = (seed * 4294967296 >>> 0) || 0x12345; this.a = this.r() * .5 + .5; this.c = this.r(); this.x = this.r(); }
Nz.prototype.r = function () { let s = this.s; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.s = s >>> 0; return this.s / 2147483648 - 1; };
Nz.prototype.fill = function (dst, cnt) { const a = this.a; let c = this.c, x = this.x;
  for (let k = 0; k < cnt; k++) { dst[k] = c + (x - c) * a; c = x; x = this.r(); } this.c = c; this.x = x; };
function hash(a, b, c) { let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15; return (h >>> 0) / 4294967296; }

/* ---------- WaveShaper: the browser's table lookup, and its 2× oversampling (95-tap halfband, 47 frames, flat to 20 kHz) ---------- */
function shapeT(c, x) { const n = c.length, v = (n - 1) / 2 * (x + 1); if (!(v > 0)) return c[0]; if (v >= n - 1) return c[n - 1]; const k = v | 0, f = v - k; return c[k] + (c[k + 1] - c[k]) * f; }
const CURVES = {};
function driveCurve(amount) {   // = audio.js driveCurve: tanh(k·x)/tanh(k), 1024 points, k from the amount in 1/32 steps
  const key = Math.round(amount * 32); if (CURVES[key]) return CURVES[key];
  const k = 1 + (key / 32) * 14, n = 1024, c = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
  return (CURVES[key] = c);
}
const SOFT_CLIP = (() => { const n = 2048, c = new Float32Array(n), k = 0.75;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 4 - 2, a = Math.abs(x); c[i] = Math.sign(x) * (a <= k ? a : k + (1 - k) * Math.tanh((a - k) / (1 - k))); }
  return c; })();
const HB = [0.3177359152, -0.1043903629, 0.06084295699, -0.04160057052, 0.03051340058, -0.02318772181, 0.01794025885, -0.01398881304,
  0.01092001598, -0.008493296301, 0.006557024438, -0.005008636775, 0.003774169066, -0.002797168813, 0.002032469807, -0.001442624435,
  0.000995842138, -0.0006647964171, 0.0004259301892, -0.0002590368783, 0.0001469810506, -7.547584072e-05, 3.28691094e-05, -9.913559757e-06];
const HN = HB.length, OS_LAT = 2 * HN - 1;
function Shp(c) { this.c = c; this.X = new Float64Array(128); this.A = new Float64Array(128); this.B = new Float64Array(128); this.n = 0; }
Shp.prototype.run = function (x) {   // 2× oversampled, OS_LAT frames late
  const X = this.X, A = this.A, B = this.B, c = this.c, n = this.n = (this.n + 1) & 63, m = n + 64;
  X[n] = x; X[m] = x;
  let o = 0;
  for (let j = 1; j <= HN; j++) o += HB[j - 1] * (X[m - HN + 1 - j] + X[m - HN + j]);
  const a = shapeT(c, X[m - HN]), bb = shapeT(c, 2 * o);
  A[n] = a; A[m] = a; B[n] = bb; B[m] = bb;
  let y = .5 * A[m - HN + 1];
  for (let j = 1; j <= HN; j++) y += HB[j - 1] * (B[m - HN + j] + B[m - HN + 1 - j]);
  return y;
};
// the same over a block, in place, with an optional gain in front (keeps the state in locals)
Shp.prototype.block = function (x, cnt, pre) {
  const X = this.X, A = this.A, B = this.B, c = this.c, nc = c.length - 1, h = nc / 2; let n = this.n;
  for (let k = 0; k < cnt; k++) {
    n = (n + 1) & 63; const m = n + 64, xi = x[k] * pre; X[n] = xi; X[m] = xi;
    let o = 0; const b0 = m - HN + 1, b1 = m - HN;
    for (let j = 0; j < HN; j++) o += HB[j] * (X[b0 - 1 - j] + X[b1 + 1 + j]);
    let v = h * (X[b1] + 1), a, bb;
    if (!(v > 0)) a = c[0]; else if (v >= nc) a = c[nc]; else { const i = v | 0; a = c[i] + (c[i + 1] - c[i]) * (v - i); }
    v = h * (2 * o + 1);
    if (!(v > 0)) bb = c[0]; else if (v >= nc) bb = c[nc]; else { const i = v | 0; bb = c[i] + (c[i + 1] - c[i]) * (v - i); }
    A[n] = a; A[m] = a; B[n] = bb; B[m] = bb;
    let y = .5 * A[b0]; for (let j = 0; j < HN; j++) y += HB[j] * (B[b0 + j] + B[b0 - 1 - j]);
    x[k] = y;
  }
  this.n = n;
};
Shp.prototype.reset = function () { this.X.fill(0); this.A.fill(0); this.B.fill(0); };
function Dly(N) { this.b = new Float64Array(256); this.n = 0; this.N = N; }
Dly.prototype.run = function (x) { const n = this.n = (this.n + 1) & 255; this.b[n] = x; return this.b[(n - this.N) & 255]; };
Dly.prototype.reset = function () { this.b.fill(0); };

/* ---------- the browser's DynamicsCompressor, ported: static curve with knee, detector, adaptive release, 6 ms look-ahead,
   automatic makeup (Chrome's 0.6 power). Starts settled, as after silence. ---------- */
const l2db = x => 20 * Math.log10(x), db2l = x => Math.pow(10, x / 20);
function Comp(sr, attack, release, knee) {
  this.sr = sr; this.pre = Math.floor(0.006 * sr); this.M = 1024; this.dL = new Float32Array(1024); this.dR = new Float32Array(1024);
  this.w = this.pre; this.r = 0; this.det = 1; this.g = 1; this.maxAtk = -1; this.div = 0;
  this.attack = attack; this.release = release; this.knee = knee; this.th = 0; this.ratio = 1; this.dirty = true;
}
Comp.prototype.set = function (th, ratio) { if (th !== this.th || ratio !== this.ratio) { this.th = th; this.ratio = ratio; this.dirty = true; } };
Comp.prototype.kneeCurve = function (x, k) { if (x < this.linTh) return x; return this.linTh + (1 - Math.exp(-k * (x - this.linTh))) / k; };
Comp.prototype.sat = function (x, k) { if (x < this.kneeTh) return this.kneeCurve(x, k); const xDb = l2db(x), yDb = this.ykDb + this.slope * (xDb - this.kneeDb); return db2l(yDb); };
Comp.prototype.slopeAt = function (x, k) { if (x < this.linTh) return 1; const x2 = x * 1.001, xDb = l2db(x), x2Db = l2db(x2), yDb = l2db(this.kneeCurve(x, k)), y2Db = l2db(this.kneeCurve(x2, k)); return (y2Db - yDb) / (x2Db - xDb); };
Comp.prototype.curve = function () {
  this.dirty = false;
  this.linTh = db2l(this.th); this.kneeDb = this.th + this.knee; this.kneeTh = db2l(this.kneeDb); this.slope = 1 / this.ratio;
  let mn = .1, mx = 10000, k = 5; const x = db2l(this.th + this.knee);
  for (let i = 0; i < 15; i++) { const s = this.slopeAt(x, k); if (s < this.slope) mx = k; else mn = k; k = Math.sqrt(mn * mx); }
  this.K = k; this.ykDb = l2db(this.kneeCurve(this.kneeTh, k));
  const full = this.sat(1, k); this.mk = Math.pow(1 / full, .6);
  const sr = this.sr; this.atkF = Math.max(.001, this.attack) * sr;
  const rf = sr * this.release, y1 = rf * .09, y2 = rf * .16, y3 = rf * .42, y4 = rf * .98;
  this.kA = .9999999999999998 * y1 + 1.8432219684323923e-16 * y2 - 1.9373394351676423e-16 * y3 + 8.824516011816245e-18 * y4;
  this.kB = -1.5788320352845888 * y1 + 2.3305837032074286 * y2 - .9141194204840429 * y3 + .1623677525612032 * y4;
  this.kC = .5334142869106424 * y1 - 1.272736789213631 * y2 + .9258856042207512 * y3 - .18656310191776226 * y4;
  this.kD = .08783463138207234 * y1 - .1694162967925622 * y2 + .08588057951595272 * y3 - .00429891410546283 * y4;
  this.kE = -.042416883008123074 * y1 + .1115693827987602 * y2 - .09764676325265872 * y3 + .028494263462021576 * y4;
  this.satRF = .0025 * sr; this.sr2 = db2l(2 / this.satRF) - 1;
};
Comp.prototype.run = function (L, R, n) {
  if (this.dirty) this.curve();
  const M1 = this.M - 1, dL = this.dL, dR = this.dR, K = this.K, mk = this.mk;
  let w = this.w, r = this.r, det = this.det, g = this.g, i = 0;
  while (i < n) {
    if (this.div === 0) {
      const sdg = Math.asin(det) / (Math.PI / 2);
      const rel = sdg > g; let cd = l2db(g / sdg);
      if (rel) { this.maxAtk = -1; if (!isFinite(cd)) cd = -1; let x = clamp(cd, -12, 0); x = .25 * (x + 12);
        const x2 = x * x, x3 = x2 * x, x4 = x2 * x2, rfr = this.kA + this.kB * x + this.kC * x2 + this.kD * x3 + this.kE * x4;
        this.rate = db2l(5 / rfr); }
      else { if (!isFinite(cd)) cd = 1; if (this.maxAtk === -1 || this.maxAtk < cd) this.maxAtk = cd;
        const eff = Math.max(.5, this.maxAtk); this.rate = 1 - Math.pow(.25 / eff, 1 / this.atkF); }
      this.sdg = sdg;
    }
    const cnt = Math.min(32 - this.div, n - i), rate = this.rate, sdg = this.sdg;
    for (let k = 0; k < cnt; k++, i++) {
      const xl = L[i], xr = R[i]; dL[w] = xl; dR[w] = xr;
      const al = xl < 0 ? -xl : xl, ar = xr < 0 ? -xr : xr, a = al > ar ? al : ar;
      let att, srr;
      if (a <= .0001 || a < this.linTh) { att = 1; srr = this.sr2; }
      else { att = this.sat(a, K) / a; let ad = -l2db(att); if (ad < 2) ad = 2; srr = db2l(ad / this.satRF) - 1; }
      det += (att - det) * (att > det ? srr : 1); if (det > 1) det = 1; if (!isFinite(det)) det = 1;
      if (rate < 1) g += (sdg - g) * rate; else { g *= rate; if (g > 1) g = 1; }
      const tg = mk * (g >= 1 ? 1 : Math.sin(Math.PI / 2 * g));
      L[i] = dL[r] * tg; R[i] = dR[r] * tg;
      w = (w + 1) & M1; r = (r + 1) & M1;
    }
    this.div = (this.div + cnt) & 31;
  }
  this.w = w; this.r = r; this.det = det; this.g = g;
};
Comp.prototype.settle = function () { this.det = 1; this.g = 1; this.maxAtk = -1; this.dL.fill(0); this.dR.fill(0); };

/* =====================================================================
   The six machines, node for node as machines.js built them.
   setup(V, p, e) makes the parts (e = start as a fractional frame) and returns how long the sound rings (seconds);
   render(V, X, cnt, n0, F0) writes cnt samples of the voice's output (before its filter) into X.
   dur(machine, p) gives the same length without building anything (the page uses it for note ends).
   ===================================================================== */
const R808 = [1, 1.4826, 1.8, 2.5463, 2.6304, 3.8956];
const RALT = [1, 1.342, 1.6531, 2.1181, 2.7362, 3.4607];
const PERC_RATIOS = [0.5, 1, 1.41, 1.5, 2, 2.76, 3.5, 4.2, 5.4, 7.1];
const TONE_RATIOS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 7, 9];
const CHORDS = [[0, 7, 12], [0, 3, 7], [0, 4, 7], [0, 2, 7], [0, 5, 7], [0, 3, 7, 10], [0, 4, 7, 11], [0, 4, 7, 10], [0, 3, 7, 10, 14],
  [0, 4, 7, 11, 14], [0, 3, 7, 10, 14, 17], [0, 4, 9, 14], [0, 3, 6], [0, 4, 8]];
const MACH = ['kick', 'snare', 'metal', 'perc', 'tone', 'chord'];
function dur(m, p) {
  switch (m) {
    case 'kick': return .08 + p.decay * p.decay * 2.2 + .02;
    case 'snare': { const b = .04 + p.decay * p.decay * .6, nd = b * (.5 + p.contour * 2.4) + .02; return Math.max(b, nd) + .02; }
    case 'metal': { const d = .025 + Math.pow(p.decay, 2.2) * 2.6; return p.contour * d * .6 + d + .02; }
    case 'perc': return .03 + p.decay * p.decay * 1.6 + .02;
    case 'tone': return .06 + p.decay * p.decay * 3.4 + .02;
    case 'chord': return .1 + p.decay * p.decay * 4 + .02;
  }
  return .1;
}
const env = (pk, e, d, sr) => new Par(0).set(Math.max(pk, .0001), e).exp(.0001, e + Math.max(.005, d) * sr);
const gl = (P, e, from, to, tc, sr) => P.set(from, e).tgt(to, e, Math.max(.001, tc) * sr);

function setup(C, V, m, p, e) {
  const sr = C.sr, st = V.st, a = st - e, sine = C.sine;
  const osc = (W) => new Osc(W, st, a, sr);
  const noise = () => new Nz(hash(st, V.i, 77));
  switch (m) {
    case 'kick': {
      const f0 = mtof(29 + p.semi), start = f0 * Math.pow(2, p.sweep * 4.5), tc = .004 + p.contour * p.contour * .11, dec = .08 + p.decay * p.decay * 2.2;
      V.car = osc(sine); gl(V.car.fr, e, start, f0, tc, sr);
      const ratio = .5 + p.shape * 3; V.mod = osc(sine); gl(V.mod.fr, e, start * ratio, f0 * ratio, tc, sr);
      const dev = p.color * p.color * f0 * 16 + .001; V.idx = new Par(0).set(dev, e).tgt(dev * .1, e, (.01 + p.contour * .12) * sr);
      V.amp = env(.95, e, dec, sr);
      V.nz = noise(); V.hp = new Bq(HP, 2200, .7, sr); V.cg = env(.28 * (1 - p.contour * .6), e, .008, sr);
      V.k = 0; return dec + .02; }
    case 'snare': {
      const f0 = mtof(53 + p.semi), bodyDec = .04 + p.decay * p.decay * .6, noiseDec = bodyDec * (.5 + p.contour * 2.4) + .02;
      const toneLvl = Math.cos(p.color * Math.PI / 2), noiseLvl = Math.sin(p.color * Math.PI / 2), drop = 1 + p.sweep * 2.5;
      V.a = osc(sine); gl(V.a.fr, e, f0 * drop, f0, .012 + p.sweep * .02, sr);
      V.b = osc(sine); gl(V.b.fr, e, f0 * 1.62 * drop, f0 * 1.62, .012, sr);
      V.mod = osc(sine); V.mod.fr.set(f0 * 2.31, e);
      V.mi = new Par(0).set(f0 * (.3 + p.contour * 1.4), e).tgt(0, e, .02 * sr);
      V.ga = env(toneLvl * .85, e, bodyDec, sr); V.gb = env(toneLvl * .35, e, bodyDec * .7, sr);
      V.nz = noise(); V.hp = new Bq(HP, 300 + p.shape * 2400, .7, sr); V.lp = new Bq(LP, 3500 + p.shape * 11000, .6, sr); V.gn = env(noiseLvl * .9, e, noiseDec, sr);
      V.k = 1; return Math.max(bodyDec, noiseDec) + .02; }
    case 'metal': {
      const base = 205 * Math.pow(2, p.semi / 12); V.os = [];
      for (let i = 0; i < 6; i++) { const o = osc(C.sq), r = lerp(R808[i], RALT[i], p.shape) * (1 + p.shape * .12 * i / 5); o.fr.set(base * r, e); V.os.push(o); }
      const center = 5200 + p.color * 7500; V.bp = new Bq(BP, center, .9, sr);
      if (p.sweep > .01) gl(V.bp.f, e, Math.min(18000, center * (1 + p.sweep * 1.6)), center, .01 + p.sweep * .3, sr);
      V.hp = new Bq(HP, 2400 + p.color * 4800, .7, sr);
      const dec = .025 + Math.pow(p.decay, 2.2) * 2.6, hold = p.contour * dec * .6;
      V.amp = new Par(0).set(1, e).set(1, e + hold * sr).exp(.0001, e + (hold + dec) * sr);
      V.k = 2; return hold + dec + .02; }
    case 'perc': {
      const f0 = mtof(45 + p.semi), r = pick(PERC_RATIOS, p.shape * .9999), sw = 1 + p.sweep * 3, tc = .008 + p.sweep * .04;
      V.car = osc(sine); gl(V.car.fr, e, f0 * sw, f0, tc, sr); V.mod = osc(sine); gl(V.mod.fr, e, f0 * r * sw, f0 * r, tc, sr);
      V.idx = new Par(0).set(Math.pow(p.color, 1.5) * f0 * r * 4 + .001, e).tgt(0, e, (.008 + p.contour * p.contour * .4) * sr);
      const dec = .03 + p.decay * p.decay * 1.6; V.amp = env(.9, e, dec, sr);
      V.k = 3; return dec + .02; }
    case 'tone': {
      const f0 = mtof(48 + p.semi), r = pick(TONE_RATIOS, p.color * .9999);
      V.car = osc(sine); V.m1 = osc(sine); V.m2 = osc(sine);
      if (p.slideSec > 0 && p.slideFrom != null && p.slideFrom !== p.semi) {
        const fs = mtof(48 + p.slideFrom), tc = p.slideSec / 4;
        gl(V.car.fr, e, fs, f0, tc, sr); gl(V.m1.fr, e, fs * r, f0 * r, tc, sr); gl(V.m2.fr, e, fs * r, f0 * r, tc, sr);
      } else { V.car.fr.set(f0, e); V.m1.fr.set(f0 * r, e); V.m2.fr.set(f0 * r, e); }
      const envTc = (.012 + p.contour * p.contour * 1.6) * sr, sus = p.contour > .85 ? (p.contour - .85) / .15 : 0;
      const d1 = p.shape * p.shape * f0 * r * 5 + .001, d2 = p.sweep * p.sweep * f0 * r * 3 + .001;
      V.i1 = new Par(0).set(d1, e).tgt(d1 * sus, e, envTc); V.i2 = new Par(0).set(d2, e).tgt(d2 * sus, e, envTc);
      const dec = .06 + p.decay * p.decay * 3.4; V.amp = env(.8, e, dec, sr);
      V.k = 4; return dec + .02; }
    case 'chord': {
      const ch = pick(CHORDS, p.shape * .9999), root = 48 + p.semi, W = p.color < .34 ? sine : p.color < .67 ? C.tri : C.saw;
      V.sum = .45 / Math.sqrt(ch.length * 2); const det = p.sweep * 28; V.os = [];
      for (const iv of ch) { const f = mtof(root + iv); for (const d of [-det, det]) { const o = osc(W); o.fr.set(f, e); o.dt = new Par(0).set(d, e); V.os.push(o); } }
      const f0 = mtof(root); V.lp = new Bq(LP, 1000, 1.4, sr); gl(V.lp.f, e, Math.min(18000, f0 * (1.6 + p.contour * 26)), f0 * 1.8 + 180, .02 + p.decay * .35, sr);
      const dec = .1 + p.decay * p.decay * 4; V.amp = env(1, e, dec, sr);
      V.k = 5; return dec + .02; }
  }
  V.k = -1; return .1;
}
// machine output (before the voice filter) for cnt samples into X
function render(C, V, X, cnt, n0, F0) {
  const S = C.S, S1 = C.S1, S2 = C.S2, S3 = C.S3, S4 = C.S4, S5 = C.S5;
  switch (V.k) {
    case 0: {   // KICK: sine with an FM sine on its frequency × amp, plus a noise click
      V.mod.fill(S1, cnt, n0, F0, S, S5); V.idx.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) S1[k] *= S2[k];
      V.car.fm = S1; V.car.fill(X, cnt, n0, F0, S, S5); V.amp.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) X[k] *= S2[k];
      V.nz.fill(S3, cnt); V.hp.run(S3, cnt, F0, S, S5); V.cg.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) X[k] += S3[k] * S2[k];
      return; }
    case 1: {   // SNARE
      V.mod.fill(S1, cnt, n0, F0, S, S5); V.mi.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) S1[k] *= S2[k];
      V.a.fm = S1; V.a.fill(X, cnt, n0, F0, S, S5); V.ga.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) X[k] *= S2[k];
      V.b.fill(S3, cnt, n0, F0, S, S5); V.gb.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) X[k] += S3[k] * S2[k];
      V.nz.fill(S3, cnt); V.hp.run(S3, cnt, F0, S, S5); V.lp.run(S3, cnt, F0, S, S5); V.gn.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) X[k] += S3[k] * S2[k];
      return; }
    case 2: {   // METAL: six squares × 0.7 → band-pass → high-pass → amp
      S3.fill(0, 0, cnt); for (const o of V.os) { o.fill(S1, cnt, n0, F0, S, S5); for (let k = 0; k < cnt; k++) S3[k] += S1[k]; }
      for (let k = 0; k < cnt; k++) S3[k] *= .7;
      V.bp.run(S3, cnt, F0, S, S5); V.hp.run(S3, cnt, F0, S, S5); V.amp.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) X[k] = S3[k] * S2[k];
      return; }
    case 3: {   // PERC: 2-op FM
      V.mod.fill(S1, cnt, n0, F0, S, S5); V.idx.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) S1[k] *= S2[k];
      V.car.fm = S1; V.car.fill(X, cnt, n0, F0, S, S5); V.amp.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) X[k] *= S2[k];
      return; }
    case 4: {   // TONE: m2 → m1 → car
      V.m2.fill(S1, cnt, n0, F0, S, S5); V.i2.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) S1[k] *= S2[k];
      V.m1.fm = S1; V.m1.fill(S3, cnt, n0, F0, S, S5); V.i1.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) S3[k] *= S2[k];
      V.car.fm = S3; V.car.fill(X, cnt, n0, F0, S, S5); V.amp.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) X[k] *= S2[k];
      return; }
    case 5: {   // CHORD: detuned pairs → plucked low-pass → amp
      S3.fill(0, 0, cnt); for (const o of V.os) { o.fill(S1, cnt, n0, F0, S, S5); for (let k = 0; k < cnt; k++) S3[k] += S1[k]; }
      const g = V.sum; for (let k = 0; k < cnt; k++) S3[k] *= g;
      V.lp.run(S3, cnt, F0, S, S5); V.amp.fill(S2, F0, cnt); for (let k = 0; k < cnt; k++) X[k] = S3[k] * S2[k];
      return; }
  }
  X.fill(0, 0, cnt);
}

/* =====================================================================
   The engine: voices → six track buses (dry / delay / reverb, each with its mute gate) → master.
     master   bus → DJ high-pass → DJ low-pass → drive in → drive (2×) → drive out → compressor → makeup →
              rack: ½ → soft clip · standalone: limiter (a second compressor) → volume
     delay    ping-pong: in → high-pass 160 → left line → right line → tone → feedback → left line; return × 0.9.
              The browser breaks that loop at the right line, which then runs one render block (128 frames) late:
              kept, so the right echoes land where they always did
     reverb   leaves on output 2 (to the page's convolver or the rack's room); its return comes in on input 1
   opt: { rack, clean, lean, fx, sweep, gates, msgs }   msgs = messages to apply at once (offline bounces)
   ===================================================================== */
const PAR_IDS = ['cutoff', 'reso', 'level', 'pan', 'delay', 'reverb'];
// high-pass then low-pass, in place over [a, b)
function dj2(H, L, x, a, b) {
  const hb0 = H.b0, hb1 = H.b1, hb2 = H.b2, ha1 = H.a1, ha2 = H.a2, lb0 = L.b0, lb1 = L.b1, lb2 = L.b2, la1 = L.a1, la2 = L.a2;
  let hx1 = H.x1, hx2 = H.x2, hy1 = H.y1, hy2 = H.y2, lx1 = L.x1, lx2 = L.x2, ly1 = L.y1, ly2 = L.y2;
  for (let k = a; k < b; k++) { const xi = x[k], h = hb0 * xi + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2; hx2 = hx1; hx1 = xi; hy2 = hy1; hy1 = h;
    const y = lb0 * h + lb1 * lx1 + lb2 * lx2 - la1 * ly1 - la2 * ly2; lx2 = lx1; lx1 = h; ly2 = ly1; ly1 = y; x[k] = y; }
  H.x1 = hx1; H.x2 = hx2; H.y1 = hy1; H.y2 = hy2; L.x1 = lx1; L.x2 = lx2; L.y1 = ly1; L.y2 = ly2;
}
function Core(sr, opt) {
  opt = opt || {};
  this.sr = sr; this.f = 0; this.rack = !!opt.rack; this.clean = !!opt.clean; this.lean = !!opt.lean; this.bare = false; this.xd = false;
  this.sine = sineSet(sr); this.sq = waveSet(sr, 1); this.saw = waveSet(sr, 2); this.tri = waveSet(sr, 3);
  ['S', 'S1', 'S2', 'S3', 'S4', 'S5', 'X', 'G', 'Lv', 'Pn', 'Ds', 'Rs'].forEach(k => { this[k] = new Float64Array(128); });
  this.B = {}; ['bl', 'br', 'dl', 'dr', 'rl', 'rr'].forEach(k => { this.B[k] = new Float64Array(128); });
  this.pend = []; this.vs = []; this.byId = new Map();
  this.T = []; for (let i = 0; i < 6; i++) this.T.push({ g: 1, gt: 1, dl: new Float64Array(128), dr: new Float64Array(128), sl: new Float64Array(128), sr: new Float64Array(128), rl: new Float64Array(128), rr: new Float64Array(128) });
  this.gm = Math.exp(-1 / (.008 * sr));
  // master
  const sm = tc => Math.exp(-1 / (tc * sr));
  this.m30 = sm(.03); this.m60 = sm(.06);
  this.dIn = { v: 1, t: 1 }; this.dOut = { v: 1, t: 1 }; this.mk = { v: 1, t: 1 }; this.vol = { v: 1, t: 1 }; this.fbG = { v: .5, t: .5 };
  this.hp = [bqPlain(HP, 10, .7, sr), bqPlain(HP, 10, .7, sr)]; this.lp = [bqPlain(LP, 22000, .7, sr), bqPlain(LP, 22000, .7, sr)];
  this.sw = { hf: 10, hq: .7, lf: 22000, lq: .7, hfT: 10, hqT: .7, lfT: 22000, lqT: .7 };
  this.mfm = sm(.025); this.mqm = sm(.05);
  this.dk = -1; this.shp = null; this.mdl = [new Dly(OS_LAT), new Dly(OS_LAT)];
  this.comp = new Comp(sr, .004, .18, 8);
  this.lim = new Comp(sr, .001, .08, 0); this.lim.set(-2.5, 20);
  // delay
  this.dN = Math.ceil(4.2 * sr); this.dLb = new Float64Array(this.dN); this.dRb = new Float64Array(this.dN); this.dW = 0;
  this.dT = { v: .3 * sr, t: .3 * sr }; this.dHP = bqPlain(HP, 160, .7, sr); this.dTone = bqPlain(LP, 4000, .5, sr); this.toneF = { v: 4000, t: 4000 };
  this.dHot = 0; this.mHot = 0; this.cold = true; this.vsh = 128 - OS_LAT;
  if (opt.fx) this.fx(opt.fx, true);
  if (opt.sweep) this.sweep(opt.sweep, true);
  if (opt.gates) opt.gates.forEach((on, i) => this.gate(i, on, true));
  if (opt.msgs) for (const m of opt.msgs) this.msg(m);
}
Core.prototype.latency = function () { const c = Math.floor(.006 * this.sr), os = this.lean ? 0 : OS_LAT;
  return this.clean ? os : os + os + (this.bare ? 0 : c) + (this.rack ? 0 : c); };
// fx: { dt (s), fb, tone (Hz), dr (0..1), c (0..1), vol }
Core.prototype.fx = function (x, imm) {
  const sr = this.sr;
  this.dT.t = x.dt * sr; this.fbG.t = x.fb; this.toneF.t = x.tone;
  const dr = x.dr, ck = Math.round(dr * .5 * 32);
  if (ck !== this.dk) { this.dk = ck; this.curve = driveCurve(dr * .5); this.shp = [new Shp(this.curve), new Shp(this.curve)]; }
  this.dIn.t = 1 + dr * 1.5; this.dOut.t = 1 / (1 + dr * .9);
  this.comp.set(-4 - x.c * 26, 1.5 + x.c * 6); this.mk.t = 1 + x.c * .9; this.vol.t = x.vol;
  if (imm) for (const p of [this.dT, this.fbG, this.toneF, this.dIn, this.dOut, this.mk, this.vol]) p.v = p.t;
  bqSet(this.dTone, LP, this.toneF.v, .5, sr);
};
// DJ sweep: { lf, lq, hf, hq }
Core.prototype.sweep = function (s, imm) { const w = this.sw; w.lfT = s.lf; w.lqT = s.lq; w.hfT = s.hf; w.hqT = s.hq; if (imm) { w.lf = s.lf; w.lq = s.lq; w.hf = s.hf; w.hq = s.hq; this.swSet(); } };
Core.prototype.swSet = function () { const w = this.sw, sr = this.sr; bqSet(this.hp[0], HP, w.hf, w.hq, sr); bqSet(this.hp[1], HP, w.hf, w.hq, sr); bqSet(this.lp[0], LP, w.lf, w.lq, sr); bqSet(this.lp[1], LP, w.lf, w.lq, sr); };
Core.prototype.gate = function (i, on, imm) { const T = this.T[i]; T.gt = on ? 1 : 0; if (imm) T.g = T.gt; };

/* a voice: { id, i, t, m, p, att, drv, vel, cut, res, lvl, pan, dly, rev, sl: { sec, from: {id: value} } | null,
   lfo: { dest, c: [values], d: seconds } | null }   (mix values already in audio units) */
Core.prototype.voice = function (m) {
  const sr = this.sr, e = m.t * sr, st = Math.ceil(e);   // exactly as the browser rounds a start time (no tolerance)
  const V = { id: m.id, i: m.i, st: Math.max(st, 0), n: 0 };
  const d = Math.min(12, (m.att || 0) + setup(this, V, m.m, m.p, e));
  V.endF = Math.ceil((m.t + d + .05) * sr) + 128;   // sources stop 50 ms after the end; a block more lets the filters ring out
  V.flt = new Bq(LP, m.cut, m.res, sr);
  if (m.drv > 1) { V.pre = 1 + (m.drv / 127) * 1.2; V.shp = new Shp(driveCurve(m.drv / 127)); }
  else V.al = new Dly(OS_LAT);
  V.vca = new Par(0).set(0, e); if (m.att > .002) V.vca.lin(m.vel, e + m.att * sr); else V.vca.set(m.vel, e);
  V.P = { cutoff: V.flt.f, reso: V.flt.q, level: new Par(m.lvl), pan: new Par(m.pan), delay: new Par(m.dly), reverb: new Par(m.rev) };
  const lfoTo = m.lfo ? m.lfo.dest : null;
  if (m.sl && m.sl.sec > 0) { const tc = m.sl.sec / 4 * sr, now = { cutoff: m.cut, reso: m.res, level: m.lvl, pan: m.pan, delay: m.dly, reverb: m.rev };
    for (const id of PAR_IDS) { const from = m.sl.from[id]; if (from === undefined || id === lfoTo || from === now[id]) continue; V.P[id].set(from, e).tgt(now[id], e, tc); } }
  if (m.lfo && V.P[lfoTo]) V.P[lfoTo].curve(m.lfo.c, e, d * sr);
  this.byId.set(V.id, V);
  const q = this.pend; let k = q.length; while (k > 0 && q[k - 1].st > V.st) k--; q.splice(k, 0, V);
  return V;
};
Core.prototype.msg = function (m) {
  const sr = this.sr;
  switch (m.c) {
    case 'v': this.voice(m); break;
    case 'lk': { const V = this.byId.get(m.id); if (!V) break; const F = m.t * sr, tc = m.tc * sr; for (const id in m.vals) if (V.P[id]) V.P[id].tgt(m.vals[id], F, tc); break; }
    case 'ch': { const V = this.byId.get(m.id); if (!V) break; const F = m.t * sr; V.vca.hold(F); V.vca.tgt(0, F, .004 * sr); V.endF = Math.min(V.endF, Math.ceil((m.t + .04) * sr) + 128); V.cut = Math.ceil((m.t + .04) * sr); break; }
    case 'k': { const V = this.byId.get(m.id); if (!V) break; this.byId.delete(m.id); let j = this.pend.indexOf(V); if (j >= 0) this.pend.splice(j, 1); j = this.vs.indexOf(V); if (j >= 0) this.vs.splice(j, 1); break; }
    case 'fx': this.fx(m.fx, m.imm); break;
    case 'sw': this.sweep(m.s, m.imm); break;
    case 'g': this.gate(m.i, m.on, m.imm); break;
    case 'lean': this.lean = !!m.on; break;
    case 'vsh': this.vsh = m.v; break;   // tests only
    case 'sup': this.xd = !!m.xd; if (!!m.bare !== this.bare) { this.bare = !!m.bare; this.comp.settle(); } break;
  }
};

/* render one block. inL/inR: reverb return · outL/outR: main · sL/sR: reverb send · xL/xR: echo send (Super lean, rack only) */
Core.prototype.process = function (inL, inR, outL, outR, sL, sR, n, xL, xR) {
  const f0 = this.f, sr = this.sr, B = this.B, X = this.X, lean = this.lean;
  const bl = B.bl, br = B.br, dl = B.dl, dr = B.dr, rl = B.rl, rr = B.rr;
  bl.fill(0, 0, n); br.fill(0, 0, n); dl.fill(0, 0, n); dr.fill(0, 0, n); rl.fill(0, 0, n); rr.fill(0, 0, n);
  while (this.pend.length && this.pend[0].st < f0 + n) { const V = this.pend.shift(); if (V.st < f0) V.st = f0; this.vs.push(V); }
  let any = false, dAny = false, rAny = false;
  const T = this.T;
  for (const t of T) { t.hot = false; }
  for (let v = 0; v < this.vs.length; v++) {
    const V = this.vs[v], j = V.st > f0 ? V.st - f0 : 0, cnt = Math.min(n - j, V.endF - (f0 + j));
    if (cnt <= 0) { this.vs.splice(v, 1); v--; this.byId.delete(V.id); continue; }
    any = true; const F0 = f0 + j, tr = T[V.i]; tr.hot = true;
    if (V.cut != null && F0 >= V.cut) X.fill(0, 0, cnt); else { render(this, V, X, cnt, V.n, F0); if (V.cut != null && F0 + cnt > V.cut) X.fill(0, V.cut - F0, cnt); }
    V.flt.run(X, cnt, F0, this.S, this.S5);
    if (V.shp) { const pg = V.pre, s = V.shp, c = s.c; if (lean) for (let k = 0; k < cnt; k++) X[k] = shapeT(c, X[k] * pg); else s.block(X, cnt, pg); }
    else if (!lean) { const a = V.al; for (let k = 0; k < cnt; k++) X[k] = a.run(X[k]); }
    /* The old graph's VCA, level, pan and sends sat after the voice's 128-frame shaper delay, so their automation ran
       128 frames ahead of the sound (an attack ramp started 2.9 ms early, a choke cut 2.9 ms early). The sound here is
       only OS_LAT late, so these timelines lead by the rest. Lean had no delay there, and has none here. */
    const G = this.G, Lv = this.Lv, Pn = this.Pn, Ds = this.Ds, Rs = this.Rs, Fm = F0 + (lean ? 0 : this.vsh);
    V.vca.fill(G, Fm, cnt); V.P.level.fill(Lv, Fm, cnt); const pm = V.P.pan.fill(Pn, Fm, cnt);
    const dm = V.P.delay.fill(Ds, Fm, cnt), rm = V.P.reverb.fill(Rs, Fm, cnt);
    const hasD = dm || Ds[0] !== 0, hasR = rm || Rs[0] !== 0;
    let gl0 = 0, gr0 = 0; if (!pm) { const x = (Pn[0] + 1) / 2; gl0 = Math.cos(x * Math.PI / 2); gr0 = Math.sin(x * Math.PI / 2); }
    const oL = tr.dl, oR = tr.dr, sl = tr.sl, srr = tr.sr, ql = tr.rl, qr = tr.rr;
    if (!tr.fresh) { tr.fresh = true; oL.fill(0, 0, n); oR.fill(0, 0, n); sl.fill(0, 0, n); srr.fill(0, 0, n); ql.fill(0, 0, n); qr.fill(0, 0, n); }
    for (let k = 0; k < cnt; k++) {
      const y = X[k] * G[k] * Lv[k];
      let gL = gl0, gR = gr0; if (pm) { const x = (Pn[k] + 1) / 2; gL = Math.cos(x * Math.PI / 2); gR = Math.sin(x * Math.PI / 2); }
      const L = y * gL, R = y * gR, o = j + k;
      oL[o] += L; oR[o] += R;
      if (hasD) { sl[o] += L * Ds[k]; srr[o] += R * Ds[k]; }
      if (hasR) { ql[o] += L * Rs[k]; qr[o] += R * Rs[k]; }
    }
    if (hasD) tr.dAny = true; if (hasR) tr.rAny = true;
    V.n += cnt;
  }
  // track buses through their gates
  for (let i = 0; i < 6; i++) {
    const t = T[i];
    if (!t.fresh) { if (t.g !== t.gt && Math.abs(t.g - t.gt) > 1e-6) t.g = t.gt; continue; }
    t.fresh = false; let g = t.g; const gt = t.gt, gm = this.gm, oL = t.dl, oR = t.dr, sl = t.sl, srr = t.sr, ql = t.rl, qr = t.rr, D = t.dAny, R = t.rAny;
    for (let k = 0; k < n; k++) { if (g !== gt) g = gt + (g - gt) * gm; bl[k] += oL[k] * g; br[k] += oR[k] * g; if (D) { dl[k] += sl[k] * g; dr[k] += srr[k] * g; } if (R) { rl[k] += ql[k] * g; rr[k] += qr[k] * g; } }
    if (Math.abs(g - gt) < 1e-6) g = gt; t.g = g;
    if (D) dAny = true; if (R) rAny = true; t.dAny = t.rAny = false;
  }
  // reverb send out
  if (sL) { if (rAny) { for (let k = 0; k < n; k++) { sL[k] = rl[k]; sR[k] = rr[k]; } } else { sL.fill(0); sR.fill(0); } }
  // echo send out (Super lean): the rack's Dub Delay gets what this delay's input would have; this loop rings out
  if (xL) { if (dAny && this.xd) { for (let k = 0; k < n; k++) { xL[k] = dl[k]; xR[k] = dr[k]; } } else { xL.fill(0); xR.fill(0); } }
  const dIn = dAny && !this.xd;
  // ping-pong delay (mono inside: the old merger summed each line to one channel)
  if (dIn) this.dHot = Math.round(sr * .5);
  const dL = this.B.dl, dR = this.B.dr;
  if (this.dHot > 0) {
    any = true; this.dHot -= n;
    const N = this.dN, LB = this.dLb, RB = this.dRb, dT = this.dT, m60 = this.m60, fbG = this.fbG, m30 = this.m30, hp = this.dHP, tn = this.dTone, tf = this.toneF;
    if (tf.v !== tf.t) { tf.v = tf.t + (tf.v - tf.t) * Math.pow(m30, n); if (Math.abs(tf.v - tf.t) < .01) tf.v = tf.t; bqSet(tn, LP, tf.v, .5, sr); }
    let w = this.dW, last = -1;
    for (let k = 0; k < n; k++) {
      dT.v = dT.t + (dT.v - dT.t) * m60; fbG.v = fbG.t + (fbG.v - fbG.t) * m30;
      const x = dIn ? bqS(hp, .5 * (dL[k] + dR[k])) : bqS(hp, 0);
      let rp = w - dT.v; if (rp < 0) rp += N; const i = rp | 0, fr = rp - i, i1 = i + 1 >= N ? 0 : i + 1;
      let rq = rp - 128; if (rq < 0) rq += N; const j = rq | 0, i2 = j + 1 >= N ? 0 : j + 1;
      const yl = LB[i] + (LB[i1] - LB[i]) * fr, yr = RB[j] + (RB[i2] - RB[j]) * fr;
      const lw = x + bqS(tn, yr) * fbG.v; LB[w] = lw; RB[w] = yl;
      dL[k] = yl * .9; dR[k] = yr * .9;
      if (lw > 1e-6 || lw < -1e-6 || yl > 1e-6 || yl < -1e-6) last = k;
      if (++w >= N) w = 0;
    }
    this.dW = w;
    // stay on while something is still travelling through the two lines
    if (last >= 0) this.dHot = Math.max(this.dHot, Math.ceil(2 * dT.v) + 512 - (n - last));
    if (this.dHot <= 0) { LB.fill(0); RB.fill(0); for (const f of [hp, tn]) f.x1 = f.x2 = f.y1 = f.y2 = 0; }
  } else { dL.fill(0, 0, n); dR.fill(0, 0, n); }
  // reverb return in
  let inAny = false;
  if (inL) for (let k = 0; k < n; k++) { const a = inL[k], b = inR ? inR[k] : a; if (a !== 0 || b !== 0) { inAny = true; break; } }
  if (any || inAny) this.mHot = Math.round(sr * .5);
  if (this.mHot <= 0) {
    if (!this.cold) { this.cold = true; this.comp.settle(); this.lim.settle(); for (const f of this.hp.concat(this.lp)) f.x1 = f.x2 = f.y1 = f.y2 = 0; for (const s of this.shp) s.reset(); this.mdl.forEach(d => d.reset()); }
    outL.fill(0); outR.fill(0); this.f += n;
    // parameters still glide while resting
    this.dIn.v = this.dIn.t; this.dOut.v = this.dOut.t; this.mk.v = this.mk.t; this.vol.v = this.vol.t; this.dT.v = this.dT.t; this.fbG.v = this.fbG.t;
    const w = this.sw; if (w.lf !== w.lfT || w.hf !== w.hfT || w.lq !== w.lqT || w.hq !== w.hqT) { w.lf = w.lfT; w.hf = w.hfT; w.lq = w.lqT; w.hq = w.hqT; this.swSet(); }
    return false;
  }
  this.cold = false; this.mHot -= n;
  for (let k = 0; k < n; k++) { bl[k] += dL[k]; br[k] += dR[k]; }
  if (inAny) for (let k = 0; k < n; k++) { bl[k] += inL[k]; br[k] += inR ? inR[k] : inL[k]; }
  const vol = this.vol, m30 = this.m30;
  if (this.clean) { for (let k = 0; k < n; k++) { vol.v = vol.t + (vol.v - vol.t) * m30; outL[k] = bl[k] * vol.v; outR[k] = br[k] * vol.v; } this.f += n; return true; }
  // DJ filter (coefficients every 8 samples while it moves)
  const w = this.sw, moving = w.lf !== w.lfT || w.hf !== w.hfT || w.lq !== w.lqT || w.hq !== w.hqT;
  const dI = this.dIn, dO = this.dOut, shp = this.shp, c = this.curve;
  if (moving) for (let k = 0; k < n; k += 8) { const a = Math.pow(this.mfm, 8), b = Math.pow(this.mqm, 8);
      w.lf = w.lfT + (w.lf - w.lfT) * a; w.hf = w.hfT + (w.hf - w.hfT) * a; w.lq = w.lqT + (w.lq - w.lqT) * b; w.hq = w.hqT + (w.hq - w.hqT) * b;
      if (Math.abs(w.lf - w.lfT) < .01) w.lf = w.lfT; if (Math.abs(w.hf - w.hfT) < .001) w.hf = w.hfT; if (Math.abs(w.lq - w.lqT) < 1e-5) w.lq = w.lqT; if (Math.abs(w.hq - w.hqT) < 1e-5) w.hq = w.hqT;
      this.swSet(); dj2(this.hp[0], this.lp[0], bl, k, Math.min(n, k + 8)); dj2(this.hp[1], this.lp[1], br, k, Math.min(n, k + 8)); }
  else { dj2(this.hp[0], this.lp[0], bl, 0, n); dj2(this.hp[1], this.lp[1], br, 0, n); }
  if (dI.v !== dI.t) for (let k = 0; k < n; k++) { dI.v = dI.t + (dI.v - dI.t) * m30; bl[k] *= dI.v; br[k] *= dI.v; }
  else { const g = dI.v; for (let k = 0; k < n; k++) { bl[k] *= g; br[k] *= g; } }
  if (lean) for (let k = 0; k < n; k++) { bl[k] = shapeT(c, bl[k]); br[k] = shapeT(c, br[k]); } else { shp[0].block(bl, n, 1); shp[1].block(br, n, 1); }
  for (let k = 0; k < n; k++) { if (dO.v !== dO.t) dO.v = dO.t + (dO.v - dO.t) * m30; outL[k] = bl[k] * dO.v; outR[k] = br[k] * dO.v; }
  if (Math.abs(dI.v - dI.t) < 1e-9) dI.v = dI.t; if (Math.abs(dO.v - dO.t) < 1e-9) dO.v = dO.t;
  if (!this.bare) this.comp.run(outL, outR, n);
  const mk = this.mk;
  if (this.rack) {
    for (let k = 0; k < n; k++) { mk.v = mk.t + (mk.v - mk.t) * m30; vol.v = vol.t + (vol.v - vol.t) * m30;
      outL[k] = shapeT(SOFT_CLIP, outL[k] * mk.v * .5) * vol.v; outR[k] = shapeT(SOFT_CLIP, outR[k] * mk.v * .5) * vol.v; }
  } else {
    for (let k = 0; k < n; k++) { mk.v = mk.t + (mk.v - mk.t) * m30; outL[k] *= mk.v; outR[k] *= mk.v; }
    this.lim.run(outL, outR, n);
    for (let k = 0; k < n; k++) { vol.v = vol.t + (vol.v - vol.t) * m30; outL[k] *= vol.v; outR[k] *= vol.v; }
  }
  this.f += n;
  return true;
};
Core.prototype.busy = function () { return this.pend.length > 0 || this.vs.length > 0 || this.mHot > 0; };

return { Core, dur, driveCurve, OS_LAT, MACH, PAR_IDS, waveSet, sineSet, fft, Par, Osc, Bq, bqSet, LP, HP, BP };
})();

/* ---------- the worklet ---------- */
if (typeof registerProcessor === 'function') {
  class HxtProc extends AudioWorkletProcessor {
    constructor(o) {
      super();
      const op = (o && o.processorOptions) || {};
      this.c = new HXT_CORE.Core(sampleRate, op);
      this.c.f = currentFrame;
      this.port.onmessage = e => { const d = e.data; if (Array.isArray(d)) for (const m of d) this.c.msg(m); else this.c.msg(d); };
    }
    process(ins, outs) {
      const o = outs[0], s = outs[1], x = outs[2], i = ins[0];
      const iL = i && i.length ? i[0] : null, iR = i && i.length > 1 ? i[1] : iL;
      this.c.f = currentFrame;
      this.c.process(iL, iR, o[0], o[1] || o[0], s ? s[0] : null, s ? (s[1] || s[0]) : null, o[0].length, x ? x[0] : null, x ? (x[1] || x[0]) : null);
      return true;
    }
  }
  registerProcessor('hextrig-core', HxtProc);
}
if (typeof module !== 'undefined') module.exports = HXT_CORE;
