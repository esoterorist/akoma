/* =====================================================================
   HEXTRIG · audio.js
   The page side of the engine. Every sound is made by one pure-JS core
   (core.js) that runs in an AudioWorklet live and in an OfflineAudioContext
   when bouncing to WAV (export.js): same code, same sound.

     · core (worklet)  voices (machine → filter → drive → VCA → level → pan →
                       sends), six track buses with mute gates, ping-pong
                       delay, master: DJ filter → drive → compressor → limiter
                       or the rack's soft clip → volume
     · on the page     the reverb (a ConvolverNode: core output 2 → pre-delay
                       → convolver → tone → core input 1, fed only while a
                       reverb send rings), the metronome, the scope

   HX.audio.* is the live engine (the one you hear).
   HX.audio.Engine(ctx, opts) makes another one; offline, call
   `await engine.commit()` after scheduling and before startRendering().
   ===================================================================== */
(function (HX) {
  'use strict';
  const U = HX.util;
  const A = (HX.audio = {});
  const CORE = HXT_CORE;   // core.js, loaded just before this file

  /* ---------- value maps (param units → audio units) ---------- */
  const MAP = {
    cutoff: x => U.cutoffHz(x),
    reso: x => 0.5 + Math.pow(x / 127, 2) * 16,
    pan: x => U.clamp(x / 64, -1, 1),
    level: x => Math.pow(x / 100, 2),
    delay: x => Math.pow(x / 127, 2),
    reverb: x => Math.pow(x / 127, 2),
  };
  A.MAP = MAP;
  const IDS = ['cutoff', 'reso', 'level', 'pan', 'delay', 'reverb'];

  function lfoCurve(lfo, base, dur, id) {
    const d = HX.PARAM[id];
    const n = Math.max(8, Math.min(800, Math.ceil(dur * 100)));
    const out = new Float32Array(n);
    const span = (d.max - d.min) / 2;
    for (let k = 0; k < n; k++) {
      const tk = (k / (n - 1)) * dur;
      const w = HX.lfo.wave(lfo.wave, lfo.phase0 + tk / lfo.cycleSec, lfo.seed);
      out[k] = MAP[id](U.clamp(base + w * lfo.depth * span, d.min, d.max));
    }
    return out;
  }

  // the core as a worklet module: one load per context (absolute URL, so it also resolves inside the rack)
  const CORE_URL = new URL('js/core.js', document.baseURI).href;
  const MODS = new WeakMap();
  const loadCore = ac => {
    if (!MODS.has(ac)) MODS.set(ac, (ac.audioWorklet ? ac.audioWorklet.addModule(CORE_URL).then(() => true) : Promise.resolve(false)).catch(() => false));
    return MODS.get(ac);
  };
  const rackLean = () => !!(window.RACK && RACK.lean && RACK.lean());

  /* =====================================================================
     Engine
       ac     any BaseAudioContext
       opts   { fx, bpm, sweep, gates[6], clean, rack }
              clean = skip the master drive / comp / limiter / DJ filter (stems)
     ===================================================================== */
  function Engine(ac, opts = {}) {
    const E = {};
    const M = {};
    const sr = ac.sampleRate;
    const offline = typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext;
    let bpm = opts.bpm || 120;
    // In the rack the safety limiter is a zero-latency soft clip instead of a second look-ahead compressor
    const racked = opts.rack != null ? !!opts.rack : !!window.RACK;
    const clean = !!opts.clean;
    E.lean = !offline && rackLean();
    E.bare = false;
    let nid = 1;
    const tracks = [];
    for (let i = 0; i < HX.CONST.TRACKS; i++) tracks.push({ voices: [] });

    const g = v => { const n = ac.createGain(); n.gain.value = v; return n; };
    M.out = g(1);                       // program output (what Capture records)
    M.clickBus = g(1);                  // metronome: straight to the speakers, never recorded
    M.out.connect(ac.destination);
    M.clickBus.connect(ac.destination);
    if (!offline) { M.analyser = ac.createAnalyser(); M.analyser.fftSize = 1024; M.out.connect(M.analyser); }

    // reverb: (core output 2) → in → pre-delay → convolver → tone → out → (core input 1)
    M.rIn = g(1);
    M.rPre = ac.createDelay(1);
    M.rConv = ac.createConvolver();
    M.rTone = ac.createBiquadFilter(); M.rTone.type = 'lowpass'; M.rTone.frequency.value = 6000; M.rTone.Q.value = 0.5;
    M.rOut = g(0.85);
    M.rIn.connect(M.rPre).connect(M.rConv).connect(M.rTone).connect(M.rOut);

    /* ---------- the core ---------- */
    let node = null, sp = null, core = null;
    const queue = [];
    const send = m => { if (node) node.port.postMessage(m); else if (core) core.msg(m); else queue.push(m); };
    const fxMsg = (fx, b) => ({
      dt: Math.min(3.9, HX.DELAY_DIVS[fx.dlyTime].s * (15 / b)), fb: (fx.dlyFb / 127) * 0.9, tone: U.cutoffHz(50 + fx.dlyTone * 0.6),
      dr: fx.mDrive / 127, c: fx.comp / 127, vol: Math.pow(fx.volume / 100, 2) * 0.88,
    });
    const sweepMsg = v => {
      const x = Math.abs(v) / 64, q = v === 0 ? 0.7 : 0.7 + x * 3.2;
      return { lf: v < 0 ? 22000 * Math.pow(90 / 22000, Math.pow(x, 0.8)) : 22000, lq: v < 0 ? q : 0.7,
        hf: v > 0 ? 10 * Math.pow(7000 / 10, Math.pow(x, 0.9)) : 10, hq: v > 0 ? q : 0.7 };
    };
    const procOpts = () => ({ rack: racked, clean, lean: E.lean, msgs: queue.splice(0) });
    function attach(n, s) {
      node = n; sp = s;
      (s || n).connect(M.out, 0);
      if (n && offline) { n.connect(M.rIn, 1); M.rOut.connect(n); }   // offline bounces always run the room; live, only while it rings (below)
      E.mode = s ? 'main thread' : 'worklet';
      if (rr) { const d = rr; rr = null; E.rackRev(d); }
      if (rd) { const d = rd; rd = null; E.rackDly(d); }
    }
    // live: the worklet as soon as its module is in; without worklets, the same core on the main thread (no reverb then)
    E.ready = (async () => {
      if (offline) return;
      if (await loadCore(ac)) {
        try {
          const outs = racked ? 3 : 2;
          attach(new AudioWorkletNode(ac, 'hextrig-core', { numberOfInputs: 1, numberOfOutputs: outs, outputChannelCount: new Array(outs).fill(2), processorOptions: procOpts() }), null);
          return;
        } catch (e) { console.warn('Hextrig: worklet failed, using the main thread', e); }
      }
      core = new CORE.Core(sr, { rack: racked, clean, lean: E.lean, msgs: queue.splice(0) });
      const s = ac.createScriptProcessor(1024, 0, 2);
      s.onaudioprocess = ev => { const b = ev.outputBuffer, L = b.getChannelData(0), R = b.getChannelData(1); core.f = Math.round(ev.playbackTime * sr);
        for (let o = 0; o < b.length; o += 128) core.process(null, null, L.subarray(o, o + 128), R.subarray(o, o + 128), null, null, Math.min(128, b.length - o)); };
      attach(null, s);
    })();
    // offline: everything scheduled so far goes in with the node, so nothing waits on a message
    E.commit = async function () {
      if (!offline || node) return;
      if (!(await loadCore(ac))) throw new Error('This browser cannot run the bounce engine (no AudioWorklet).');
      attach(new AudioWorkletNode(ac, 'hextrig-core', { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [2, 2], processorOptions: procOpts() }), null);
    };

    /* Latency in frames from a voice's start time to the output: the voice drive's 2× oversampling (clean voices wait the
       same), the master drive's, the compressor's 6 ms look-ahead, and standalone the limiter's. Lean (rack) runs both
       shapers at 1×; bare (Super lean) drops the compressor. Constant while playing, so the rack compensates one number. */
    E.latency = () => Engine.latency(sr, clean, racked, E.lean, E.bare);

    /* ---------- reverb feed ----------
       A convolution reverb costs CPU even fed with silence. Its input is only connected while a note that sends to it (or
       its tail) can still ring; a voice reconnects it before it starts (voices are scheduled ahead). */
    let rvOn = false, rvUntil = 0;
    const revTail = () => (M.rConv.buffer ? M.rConv.buffer.duration : 6) + M.rPre.delayTime.value + 0.2;
    function wake(which, until) {
      if (which !== 'rev' || offline || E.rackRoom || !node) return;
      rvUntil = Math.max(rvUntil, until);
      if (!rvOn) { node.connect(M.rIn, 1); M.rOut.connect(node); rvOn = true; }
    }
    // the convolver's way in and its way back are both cut while it rests: nothing pulls it, so it costs nothing
    const rvRest = () => { try { node.disconnect(M.rIn); } catch (e) {} try { M.rOut.disconnect(node); } catch (e) {} rvOn = false; };
    E.wake = wake;
    if (!offline) E.restTimer = setInterval(() => { if (rvOn && ac.currentTime > rvUntil) rvRest(); }, 250);
    E.resting = () => ({ all: !node, rev: !rvOn, dly: false });

    /* ---------- reverb impulse ---------- */
    let lastImpulseKey = '', impulseTimer = null, pendingImpulse = '';
    function makeImpulse(size, tone) {
      const key = size + ':' + tone;
      if (key === lastImpulseKey) return;
      lastImpulseKey = key;
      const s = size / 127, damp = 1 - tone / 127;
      const dur = 0.5 + s * 5.5;
      const len = Math.floor(sr * dur);
      const buf = ac.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const tt = i / len;
          const c = 1 - Math.min(0.94, damp * (0.25 + tt * 1.1));   // darker as it decays
          lp += c * ((Math.random() * 2 - 1) - lp);
          d[i] = lp * Math.exp(-tt * (5 + (1 - s) * 3)) * (i < 64 ? i / 64 : 1);
        }
      }
      M.rConv.buffer = buf;
    }
    E.reverbSeconds = fx => 0.5 + (fx.revSize / 127) * 5.5;

    /* In the rack, with a shared Reverb: the reverb sends (core output 2) go to the rack's room instead of the convolver,
       which then gets no input and rests for good. dst null = back to its own reverb. */
    const RTRIM = 6;      // level match with its own reverb, drive and compressor; times the master volume
    let rr = null, rd = null;
    E.rackRev = function (dst) {
      if (offline) return;
      if (!node) { rr = dst; return; }
      if (dst) {
        if (E.rackRoom) return;
        E.rackRoom = true;
        if (rvOn) rvRest();
        if (!M.rTrim) { M.rTrim = g(RTRIM * (E._vol || 0.6)); M.rTrim.connect(dst); }
        node.connect(M.rTrim, 1);
      } else {
        if (!E.rackRoom) return;
        E.rackRoom = false;
        try { node.disconnect(M.rTrim); } catch (e) {}
      }
    };
    /* Super lean (rack): the delay sends leave on core output 3 for the rack's Dub Delay; this delay rings out and rests.
       DTRIM matches its level: the loop's 0.9 return, drive and makeup; times the master volume. */
    const DTRIM = 1.25;
    E.rackDly = function (dst) {
      if (offline || !racked) return;
      if (!node) { rd = dst; return; }
      if (dst) {
        if (E.rackEcho) return;
        E.rackEcho = true;
        if (!M.dTrim) { M.dTrim = g(DTRIM * (E._vol || 0.6)); M.dTrim.connect(dst); }
        node.connect(M.dTrim, 2);
      } else {
        if (!E.rackEcho) return;
        E.rackEcho = false;
        try { node.disconnect(M.dTrim); } catch (e) {}
      }
      send({ c: 'sup', xd: !!E.rackEcho, bare: E.bare });
    };
    /* Super lean (rack), bare: the master compressor (6 ms look-ahead) steps aside for the rack's Master. Drive, makeup and
       the clip stay. Changes latency, so the rack only switches it while stopped. */
    E.rackBare = function (on) {
      if (offline || !racked || clean) return;
      on = !!on; if (on === E.bare) return; E.bare = on;
      send({ c: 'sup', xd: !!E.rackEcho, bare: on });
    };
    // Lean (rack): both drives at 1× and no oversampling delay; latency drops by 2 × 47 frames
    E.setLean = function (on) { on = !!on && !offline; if (on === E.lean) return; E.lean = on; send({ c: 'lean', on }); };

    /* ---------- master FX / settings ---------- */
    E.applyFx = function (fx, immediate, newBpm) {
      if (newBpm) bpm = newBpm;
      const now = ac.currentTime;
      const set = immediate
        ? (param, v) => { param.cancelScheduledValues(0); param.value = v; }
        : (param, v, tc = 0.03) => param.setTargetAtTime(v, now, tc);
      send({ c: 'fx', fx: fxMsg(fx, bpm), imm: !!immediate });
      // the loop core → pre-delay → convolver → core is broken at the pre-delay, which adds one render block (measured):
      // take it off here. Pre-delays under two blocks (5.8 ms at 44.1 kHz) can't go lower.
      set(M.rPre.delayTime, Math.max(0, (fx.revPre / 127) * 0.25 - 128 / sr));
      set(M.rTone.frequency, U.cutoffHz(60 + fx.revTone * 0.53));
      // rebuild the reverb only when its size or tone really changed (it is slow)
      const ik = fx.revSize + ':' + fx.revTone;
      if (immediate) { clearTimeout(impulseTimer); makeImpulse(fx.revSize, fx.revTone); }
      else if (ik !== lastImpulseKey && ik !== pendingImpulse) {
        clearTimeout(impulseTimer);
        pendingImpulse = ik;
        impulseTimer = setTimeout(() => { pendingImpulse = ''; makeImpulse(fx.revSize, fx.revTone); }, 160);
      }
      E._vol = Math.pow(fx.volume / 100, 2) * 0.88;
      if (M.rTrim) set(M.rTrim.gain, RTRIM * E._vol);         // in the rack's shared room the reverb follows the volume
      if (M.dTrim) set(M.dTrim.gain, DTRIM * E._vol);         // and so does the echo in the shared Dub Delay
      // a bigger room while a tail is ringing: let it ring out in full
      if (!offline && rvOn) setTimeout(() => wake('rev', ac.currentTime + revTail()), 200);
    };

    /* Master performance filter. v: -64 (low-pass sweep) … 0 (open) … +63 (high-pass sweep) */
    E.setSweep = function (v, immediate) { send({ c: 'sw', s: sweepMsg(v), imm: !!immediate }); };

    /* Mute / solo gate for a track bus (0 or 1). */
    E.setGate = function (i, on, immediate) { send({ c: 'g', i, on: !!on, imm: !!immediate }); };

    /* ---------- voices ----------
       snd: resolved sound (see seq.resolve)   vel: 0..1   gateSec: 0 = natural */
    E.voice = function (i, t, snd, vel, gateSec) {
      const tr = tracks[i], id = nid++;
      const p = snd.p, att = Math.pow(snd.attack / 127, 2) * 1.5;
      const dur = Math.min(att + CORE.dur(snd.machine.id, p), 12);
      const lfoTo = snd.lfo ? snd.lfo.dest : null;
      const has = { delay: false, reverb: false };
      const wants = k => snd[k] > 0 || lfoTo === k || !!(snd.from && snd.from.sec > 0 && snd.from.cont[k] > 0);
      has.delay = wants('delay'); has.reverb = wants('reverb');
      let sl = null;
      if (snd.from && snd.from.sec > 0) {
        const from = {};
        IDS.forEach(k => { const f = snd.from.cont[k]; if (f === undefined || k === lfoTo || f === snd[k]) return; from[k] = MAP[k](f); });
        sl = { sec: snd.from.sec, from };
      }
      const lfo = snd.lfo && IDS.indexOf(lfoTo) >= 0 ? { dest: lfoTo, c: lfoCurve(snd.lfo, snd[lfoTo], dur, lfoTo) } : null;
      send({ c: 'v', id, i, t, m: snd.machine.id,
        p: { semi: p.semi, decay: p.decay, color: p.color, shape: p.shape, sweep: p.sweep, contour: p.contour, slideFrom: p.slideFrom, slideSec: p.slideSec },
        att, drv: snd.drive, vel, cut: MAP.cutoff(snd.cutoff), res: MAP.reso(snd.reso), lvl: MAP.level(snd.level), pan: MAP.pan(snd.pan),
        dly: MAP.delay(snd.delay), rev: MAP.reverb(snd.reverb), sl, lfo });
      if (!offline && window.RACK && RACK.note) RACK.note();

      // monophonic per track. Voices can be created out of time order (a live pad between scheduled notes), so: choke
      // whatever is ringing at t, and end this voice where the next already-scheduled one begins.
      let nextStart = Infinity;
      tr.voices.forEach(r => {
        if (r.t < t && r.end > t) r.choke(t);
        else if (r.t > t && r.t < nextStart) nextStart = r.t;
      });
      const cur = {}; IDS.forEach(k => { cur[k] = snd[k]; });
      const end = t + dur;
      const rec = {
        id, t, end, lfoDest: lfoTo, cur, pre: Object.assign({}, snd.pre || cur), has, params: has,
        hold(r) { if (r.has.reverb) wake('rev', r.end + revTail()); },
        kill() { send({ c: 'k', id }); },             // silence a note that has not started yet (stop / pause)
        choke(tc) { if (tc >= end) return; send({ c: 'ch', id, t: tc }); },
      };
      if (gateSec > 0 || nextStart < Infinity) rec.choke(Math.min(nextStart, gateSec > 0 ? t + gateSec : Infinity));
      rec.hold(rec);
      const now = offline ? -1 : ac.currentTime;
      tr.voices = tr.voices.filter(r => r.end > now);
      if (offline && tr.voices.length > 8) tr.voices = tr.voices.slice(-8);
      tr.voices.push(rec);
      return rec;
    };

    // The voice that is sounding on track i at time t (the latest one started).
    function ringing(i, t) {
      let best = null;
      tracks[i].voices.forEach(r => { if (r.t <= t + 1e-6 && r.end > t && (!best || r.t > best.t)) best = r; });
      return best;
    }

    /* Lock-only step: move the ringing note's mix params (cutoff, level, …) at time t.
       vals = values to reach, pre = the same before the scene blend, slideSec 0 = jump. */
    E.lockVoice = function (i, t, vals, pre, slideSec) {
      const r = ringing(i, t);
      if (!r) return false;
      const tc = slideSec > 0 ? slideSec / 4 : 0.003, out = {};
      Object.keys(vals).forEach(id => {
        if (id === r.lfoDest || IDS.indexOf(id) < 0) return;
        out[id] = MAP[id](vals[id]);
        if (id === 'delay' || id === 'reverb') r.has[id] = true;
        r.cur[id] = vals[id];
        if (pre && pre[id] !== undefined) r.pre[id] = pre[id];
      });
      send({ c: 'lk', id: r.id, t, tc, vals: out });
      r.hold(r);
      return true;
    };

    /* Crossfader moved: re-blend the mix params of every note still sounding. */
    E.retouch = function (blend) {
      const now = ac.currentTime;
      tracks.forEach((tr, i) => tr.voices.forEach(r => {
        if (r.end <= now) return;
        const out = {}; let any = false;
        IDS.forEach(id => {
          if (id === r.lfoDest) return;
          const v = blend(i, id, r.pre[id]);
          if (Math.abs(v - r.cur[id]) < 1e-4) return;
          out[id] = MAP[id](v); any = true;
          r.cur[id] = v;
          if (id === 'delay' || id === 'reverb') r.has[id] = true;
        });
        if (!any) return;
        send({ c: 'lk', id: r.id, t: Math.max(now, r.t), tc: 0.025, vals: out });   // ≈ the master FX glide
        r.hold(r);
      }));
    };

    /* Cancel every voice scheduled to start after `time` (tails already sounding keep ringing). */
    E.cancelAfter = function (time) {
      tracks.forEach(tr => {
        tr.voices.forEach(r => { if (r.t > time + 0.0005) r.kill(); });
        tr.voices = tr.voices.filter(r => r.t <= time + 0.0005);
      });
    };

    /* Metronome click: to the speakers only, never into recordings. */
    E.click = function (t, accent, level) {
      if (level <= 0) return;
      const o = ac.createOscillator(), gn = ac.createGain();
      o.type = 'sine';
      o.frequency.value = accent ? 2000 : 1300;
      gn.gain.setValueAtTime(0.0001, t);
      gn.gain.exponentialRampToValueAtTime(0.5 * level, t + 0.002);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      o.connect(gn).connect(M.clickBus);
      o.start(t); o.stop(t + 0.06);
      o.onended = () => { o.disconnect(); gn.disconnect(); };
    };

    E._send = send; E._queue = () => queue.slice();   // tests
    E.output = () => M.out;
    E.analyser = () => M.analyser || null;

    if (opts.fx) E.applyFx(opts.fx, true, opts.bpm);
    E.setSweep(opts.sweep || 0, true);
    if (opts.gates) opts.gates.forEach((on, i) => E.setGate(i, on, true));
    return E;
  }
  A.Engine = Engine;
  // the same number an Engine reports, without building one (export.js)
  Engine.latency = (sr, clean, rack, lean, bare) => {
    const racked = rack != null ? !!rack : !!window.RACK, compF = Math.floor(0.006 * sr), os = lean ? 0 : CORE.OS_LAT;
    return clean ? os : os + os + (bare ? 0 : compF) + (racked ? 0 : compF);
  };

  /* =====================================================================
     The live engine
     ===================================================================== */
  let ac = null, live = null;
  A._sweep = 0;
  A._gates = [1, 1, 1, 1, 1, 1];

  A.ctx = () => ac;
  A.now = () => (ac ? ac.currentTime : 0);
  // frames from a voice's start to the program output (constant; see Engine)
  A.latencyFrames = () => (live ? live.latency() : 0);
  A.bare = () => !!(live && live.bare);
  A.resting = () => (live ? live.resting() : null);
  A.keepAwake = until => { if (live) live.wake('all', until); };
  A.analyser = () => (live ? live.analyser() : null);
  A.output = () => (live ? live.output() : null);

  /* Create (or resume) the context. Browsers only let audio start inside a user
     gesture; on phones that is the moment a finger LIFTS (touchend / pointerup /
     click), not when it touches down. See A.unlock and main.js. */
  A.ensure = function () {
    if (ac) { if (ac.state !== 'running' && ac.state !== 'closed') ac.resume().catch(() => {}); return ac; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ac = new Ctx({ latencyHint: 'interactive' });
    live = Engine(ac, { fx: PFfx(HX.state.project.fx), bpm: HX.state.project.bpm, sweep: PFsweep(A._sweep), gates: A._gates });
    // in the rack: reverb sends play into the rack's shared room while it has one
    if (window.RACK && RACK.onFx) { const sn = RACK.fxSend('reverb'), sd = RACK.fxSend('delay'); if (sn) { const e = live; RACK.onFx(s => { e.rackRev(s.reverb ? sn : null); e.rackDly(s.delay && sd ? sd : null); e.rackBare(!!s.bare); }); } }
    if (window.RACK && RACK.onLean) { const e = live; RACK.onLean(on => e.setLean(on)); }
    ac.addEventListener('statechange', () => {
      if (HX.seq && HX.seq.onAudioState) HX.seq.onAudioState(ac.state);
      if (HX.state.changed) HX.state.changed();
    });
    return ac;
  };
  A.running = () => !!ac && ac.state === 'running';

  /* ---------- phones: unlocking sound ----------
     · iOS mutes web audio when the ring / silent switch is on silent, unless the
       page asks for "playback" audio. Newer iOS has navigator.audioSession for
       that; older iOS gets the same effect from a silent <audio> element.
     · iOS can also leave the context "interrupted" (another app, a call, the
       screen locking). Every gesture tries again until it is running. */
  let keepAlive = null;
  function silentWavURI() {
    const n = 4410, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer);   // 0.1 s of 16-bit silence
    const str = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 44100, true); v.setUint32(28, 88200, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    let bin = ''; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return 'data:audio/wav;base64,' + btoa(bin);
  }
  A.unlock = function () {
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) {}
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && !navigator.audioSession && !keepAlive) {
      try {
        keepAlive = document.createElement('audio');
        keepAlive.setAttribute('x-webkit-airplay', 'deny');
        keepAlive.preload = 'auto'; keepAlive.loop = true; keepAlive.playsInline = true;
        keepAlive.src = silentWavURI();
        const p = keepAlive.play();
        if (p && p.catch) p.catch(() => { keepAlive = null; });
      } catch (e) { keepAlive = null; }
    } else if (keepAlive && keepAlive.paused) { try { keepAlive.play().catch(() => {}); } catch (e) {} }
    const ctx = A.ensure();
    if (ctx.state !== 'running') {
      try {   // a one-sample buffer played inside the gesture: the classic iOS unlock
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination); src.start(0);
      } catch (e) {}
    }
    return ctx;
  };

  // Master FX and sweep go through the scene blend (perform.js).
  const PFfx = fx => (HX.perform && HX.state.project ? HX.perform.fx(fx) : fx);
  const PFsweep = v => (HX.perform && HX.state.project ? HX.perform.sweep(v) : v);
  A.applyFx = (fx, immediate) => { if (live) live.applyFx(PFfx(fx), immediate, HX.state.project.bpm); };
  A.setSweep = v => { A._sweep = v; if (live) live.setSweep(PFsweep(v)); };
  A.lockVoice = (i, t, vals, pre, sec) => (live ? live.lockVoice(i, t, vals, pre, sec) : false);
  A.retouch = () => {
    if (!live || !HX.perform) return;
    const view = HX.perform.view();
    live.retouch((i, id, base) => HX.perform.blend(view, 't', i, id, base));
  };
  // A slider moved during live REC: let the ringing note follow right away.
  A.lockNow = (i, id, v) => {
    if (!live || HX.sound.CONT.indexOf(id) < 0) return;
    const view = HX.perform ? HX.perform.view() : null;
    live.lockVoice(i, ac.currentTime + 0.005, { [id]: view ? HX.perform.blend(view, 't', i, id, v) : v }, { [id]: v }, 0);
  };
  A.setGate = (i, on) => { A._gates[i] = on; if (live) live.setGate(i, on); };
  A.voice = (i, t, snd, vel, gateSec) => (live ? live.voice(i, t, snd, vel, gateSec) : null);
  A.cancelAfter = time => { if (live) live.cancelAfter(time); };
  A.click = (t, accent, level) => { if (live) live.click(t, accent, level); };
})(window.HX);
