/* =====================================================================
   AKOMA NTOASO · rack-client.js
   Loaded first inside every instrument page that runs in the rack.

   · new AudioContext() returns the rack's one shared context, seen
     through a thin wrapper whose `destination` is this machine's mixer
     channel. One context = one sample clock for every machine.
   · requestAnimationFrame goes to the rack's one display loop, so all
     machines draw in the same pass and hidden ones take turns.
   · MIDI notes wake this machine if the rack has put it to rest.
   · window.RACK is the link back to the rack: tempo map, transport,
     register(). Outside the rack nothing here runs and window.RACK is
     undefined, so every instrument still works on its own.
   ===================================================================== */
(function () {
  'use strict';
  var me = (document.currentScript && document.currentScript.dataset.dev) || '';
  var H = null;
  try { if (window.parent !== window && window.parent.RACK_HOST) H = window.parent.RACK_HOST; } catch (e) { H = null; }
  // Outside Claude (e.g. GitHub Pages): saving falls back to a plain browser download
  if (!H) { (function(w){if(w.claude)return;var dl={save:function(o){return new Promise(function(ok,no){try{var d=o&&o.data,b=d instanceof Blob?d:new Blob([d],{type:(o&&o.mimeType)||'application/octet-stream'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=(o&&o.filename)||'download';a.style.display='none';(document.body||document.documentElement).appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},30000);ok()}catch(e){if(e&&!e.code)try{e.code='error'}catch(_){}no(e)}})}};try{Object.defineProperty(w,'claude',{configurable:true,value:{use:function(n){return Promise.resolve(n==='downloads'?dl:null)}}})}catch(e){}})(window); return; }
  var W = window;

  // capabilities (file downloads) live on the rack page
  try {
    if (!W.claude) Object.defineProperty(W, 'claude', { configurable: true, get: function () { return H.win.claude; } });
  } catch (e) {}

  // the shared audio context
  var shared = function () { return H.contextFor(me, W); };
  W.AudioContext = shared;
  W.webkitAudioContext = shared;
  var NAWN = W.AudioWorkletNode;
  W.AudioWorkletNode = function (ctx, name, opts) {
    var real = H.unwrap(ctx);
    if (real !== ctx) {
      var n = new H.win.AudioWorkletNode(real, name, opts);
      // the rack parks this node if the machine is taken off the canvas, so it never runs again
      if (H.track) H.track(me, n);
      return n;
    }
    return new NAWN(ctx, name, opts);
  };

  // one display loop for the whole rack (the host decides who draws this frame)
  if (H.raf) {
    W.requestAnimationFrame = function (cb) { return H.raf(me, cb, W); };
    W.cancelAnimationFrame = function (id) { H.caf(me, id); };
  }

  // MIDI: a note or a start message wakes this machine before its own handler runs
  var nav = W.navigator;
  if (nav && nav.requestMIDIAccess && H.wake) {
    var rma = nav.requestMIDIAccess.bind(nav);
    var seen = new WeakSet();
    var wakeOn = function (e) { var d = e.data, s = d && d[0]; if (!s) return; if (((s & 0xf0) === 0x90 && d[2] > 0) || s === 0xfa || s === 0xfb) H.wake(me); };
    var hook = function (acc) {
      acc.inputs.forEach(function (i) { if (!seen.has(i)) { seen.add(i); i.addEventListener('midimessage', wakeOn); } });
    };
    nav.requestMIDIAccess = function (o) {
      return rma(o).then(function (acc) { try { hook(acc); acc.addEventListener('statechange', function () { hook(acc); }); } catch (e) {} return acc; });
    };
  }

  var map = function () { return H.map; };
  W.RACK = {
    id: me,
    linked: function () { return H.linked(me); },
    playing: function () { return H.playing; },
    visible: function () { return H.visible(me); },
    outDelay: function () { return H.outDelay ? H.outDelay() : 0; },
    bpm: function () { return H.bpm; },
    timeAt: function (p) { return map().timeAt(p); },
    posAt: function (t) { return map().posAt(t); },
    adv: function (t, n) { var m = map(); return m.timeAt(m.posAt(t) + n); },
    segs: function (t) { return H.segs(t); },
    nextGrid: function (t, q) { return H.nextGrid(t, q); },
    toggle: function () { H.localToggle(me); },
    rejoin: function () { H.rejoin(me); },
    register: function (a) { H.register(me, a, W); },
    // the shared room: fxSend('reverb') is where this machine's own reverb sends go while onFx says { reverb: true }.
    // Super lean: fxSend('delay') is where its own echo sends go while onFx says { delay: true }, and { bare: true } means its
    // glue, look-ahead limiter and output clip step aside for the rack's Master (only ever changes while the rack is stopped)
    fxSend: function (kind) { return H.fxSend ? H.fxSend(me, kind) : null; },
    onFx: function (fn) { if (H.onFx) H.onFx(me, fn); },
    // a machine with an input: listen('all' | a machine id | '') returns the node to plug into it; sources() lists who is on the canvas
    listen: function (src) { return H.listen ? H.listen(me, src) : null; },
    sources: function () { return H.sources ? H.sources(me) : []; },
    // Lean: lean() is the rack's switch; onLean(fn) is called now and on every change with true / false
    lean: function () { return !!(H.lean && H.lean()); },
    onLean: function (fn) { if (H.onLean) H.onLean(me, fn); },
    // a machine whose notes are made inside one worklet calls note() as it schedules each, so a resting channel wakes in time
    note: function () { if (H.note) H.note(me); },
    // note wires: notes({ k: 'on' | 'off', n, v, t }) for each note this machine schedules, while the rack listens (adapter.noteListen)
    notes: function (e) { if (H.notesOut) H.notesOut(me, e); },
    // the rack key: key() = { on, root, ivs, name } set on the Clock (on: false = no rack key). The rack keeps this machine's
    // notes in that key (or a section's own key) through the adapter's key() / keyMap() / adopt(); rekey() = "my own key changed"
    key: function () { return H.keyInfo ? H.keyInfo() : { on: false }; },
    rekey: function () { if (H.rekey) H.rekey(me); },
    // the scale in `list` (arrays of intervals) closest to `ivs`: same notes first, then fewest extra or missing
    nearestScale: function (ivs, list) {
      var best = 0, bs = -1e9;
      for (var i = 0; i < list.length; i++) {
        var a = list[i], s = 0;
        for (var k = 0; k < 12; k++) { var x = ivs.indexOf(k) >= 0, y = a.indexOf(k) >= 0; s += x && y ? 2 : x || y ? -1 : 0; }
        if (a.length === ivs.length) s += 0.5;
        if (s > bs) { bs = s; best = i; }
      }
      return best;
    },
    // the small "plays in" badge in the corner of this machine's page, shown from audio time t
    _kb: function (lab, t) { kbAt(lab, t); },
  };

  // the key badge: what the rack's key does to this machine, changing on the bar it starts
  var kb = null, kbT = [];
  function kbShow(lab) {
    if (!document.body) return;
    if (!kb) {
      kb = document.createElement('div');
      kb.setAttribute('role', 'status');
      kb.title = 'Set by the rack key (Clock node) or the section playing';
      kb.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483000;pointer-events:none;font:600 9px/1.2 ui-monospace,"Martian Mono",monospace;letter-spacing:.08em;text-transform:uppercase;background:#141412;color:#f5f4ef;padding:5px 8px;border-left:3px solid #f2d230;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      document.body.appendChild(kb);
    }
    kb.textContent = lab || '';
    kb.hidden = !lab;
  }
  function kbAt(lab, t) {
    var now = H.ctx ? H.ctx.currentTime : 0, ms = t != null && t > now ? (t - now) * 1000 : 0;
    kbT = kbT.filter(function (x) { if (x.t >= (t || 0)) { clearTimeout(x.id); return false; } return true; });
    if (!ms) { kbShow(lab); return; }
    var o = { t: t }; o.id = setTimeout(function () { kbT = kbT.filter(function (x) { return x !== o; }); kbShow(lab); }, ms); kbT.push(o);
  }

  // tempo moves made on the machine itself go to the whole rack
  setInterval(function () {
    var a = H.adapter(me);
    // the machine's own key (the one its notes are written in) changed, from its panel, a load or an undo: the rack re-maps
    if (a && a.key && H.rekey) { var k = ''; try { k = JSON.stringify(a.key()); } catch (e) {} if (k !== a._key) { var first = a._key == null; a._key = k; if (!first) H.rekey(me); } }
    if (!a || !a.getTempo || !H.linked(me)) return;
    var v = +a.getTempo();
    if (!v || Math.abs(v - (a._last || 0)) <= 0.05) return;
    // a machine that is still loading its saved state does not get to set the rack tempo
    if (performance.now() - (a._regT || 0) < 4000) { H.reapply(me); return; }
    a._last = v; H.localTempo(me, v);
  }, 150);
})();
