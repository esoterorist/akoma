/* Akoma Ntoaso ANT—07 · stem split
   One file, two lives. Loaded with a <script> tag it is the driver (window.StemSplit) that the rack and Funtunfunefu
   call; started as a module worker (it starts itself from its own address) it is the engine.

   The model is HTDemucs (Meta, MIT): a mix in, four stems out: drums, bass, vocals and "other" (everything else).
   It runs in the worker with ONNX Runtime Web, on WebGPU where the browser has it and on WebAssembly where it has not
   (many times slower). The demucs-web library (MIT) does the model's own bookkeeping: 7.8 s segments, the STFT, the
   overlap-add. Engine, library and model come from other sites on first use; the model (about 172 MB) is kept in the
   browser's Cache storage afterwards, so the next split starts in seconds.

   Nothing here touches the rack's audio. A split works on copies and hands back four stereo pairs at the rate and
   length it was given. Cancel ends the worker; nothing is kept. */
(function () {
  'use strict';
  var CFG = {
    ort: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.webgpu.bundle.min.mjs',
    wasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/',
    lib: 'https://cdn.jsdelivr.net/npm/demucs-web@1.0.2/src/processor.js',
    model: 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx',
    cache: 'ant07-stem-1',
    bytes: 172e6,      // shown while downloading when the server does not say how long the file is
    rate: 44100        // the rate the model was trained at
  };
  var NAMES = ['drums', 'bass', 'vocals', 'other'];

  /* ------------------------------------------------------------------ the engine (worker) */
  if (typeof document === 'undefined') {
    var post = function (m, tr) { self.postMessage(m, tr || []); };
    var getModel = async function (cfg) {
      var c = null, hit = null;
      try { c = await caches.open(cfg.cache); hit = await c.match(cfg.model); } catch (e) { c = null; }
      if (hit) { post({ t: 'ph', ph: 'cached' }); return await hit.arrayBuffer(); }
      post({ t: 'dl', got: 0, total: cfg.bytes });
      var res = await fetch(cfg.model);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var len = +res.headers.get('content-length') || 0, total = len || cfg.bytes, got = 0, u8, last = 0;
      if (res.body && res.body.getReader) {
        var rd = res.body.getReader(), parts = [];
        if (len) u8 = new Uint8Array(len);
        for (;;) {
          var r = await rd.read(); if (r.done) break;
          if (u8 && got + r.value.length <= u8.length) u8.set(r.value, got); else { if (u8) { parts.push(u8.subarray(0, got)); u8 = null; } parts.push(r.value); }
          got += r.value.length;
          var now = Date.now(); if (now - last > 120) { last = now; post({ t: 'dl', got: got, total: Math.max(total, got) }); }
        }
        if (!u8) { u8 = new Uint8Array(got); var o = 0; for (var i = 0; i < parts.length; i++) { u8.set(parts[i], o); o += parts[i].length; } }
        else if (got < u8.length) throw new Error('the download ended early');
      } else u8 = new Uint8Array(await res.arrayBuffer());
      post({ t: 'dl', got: u8.length, total: u8.length });
      var kept = false;
      if (c) try { await c.put(cfg.model, new Response(u8, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(u8.length) } })); kept = true; } catch (e) {}
      if (!kept) post({ t: 'note', n: 'nocache' });
      return u8.buffer;
    };
    self.onmessage = async function (e) {
      var m = e.data; if (!m || m.c !== 'go') return;
      var cfg = m.cfg, step = 'lib';
      try {
        post({ t: 'ph', ph: 'lib' });
        var ort = await import(cfg.ort); if (ort.default && ort.default.InferenceSession) ort = ort.default;
        var lib = await import(cfg.lib);
        var gpu = false;
        try { gpu = !!(self.navigator && self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch (e2) {}
        // threads need a cross-origin isolated page; GitHub Pages is not one, so the fallback there is one thread
        try { ort.env.wasm.wasmPaths = cfg.wasm; ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, self.navigator.hardwareConcurrency || 4) : 1; } catch (e3) {}
        post({ t: 'be', gpu: gpu });
        step = 'net';
        var buf = await getModel(cfg);
        step = 'init'; post({ t: 'ph', ph: 'init' });
        var proc = new lib.DemucsProcessor({
          ort: ort,
          sessionOptions: { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'] },
          onProgress: function (p) { var o = typeof p === 'number' ? { progress: p } : (p || {}); post({ t: 'p', p: +o.progress || 0, i: o.currentSegment | 0, n: o.totalSegments | 0 }); }
        });
        await proc.loadModel(buf); buf = null;
        step = 'run'; post({ t: 'ph', ph: 'run' });
        var r = await proc.separate(m.L, m.R), out = {}, tr = [];
        for (var k = 0; k < NAMES.length; k++) {
          var s = r && r[NAMES[k]];
          if (!s || !s.left || !s.right) throw new Error('the model gave back no ' + NAMES[k]);
          out[NAMES[k]] = { L: s.left, R: s.right }; tr.push(s.left.buffer, s.right.buffer);
        }
        post({ t: 'done', stems: out }, tr);
      } catch (err) { post({ t: 'err', step: step, why: String((err && err.message) || err).slice(0, 300) }); }
    };
    return;
  }

  /* ------------------------------------------------------------------ the driver (page) */
  var SRC = (document.currentScript && document.currentScript.src) || 'stem.js', RUN = null;
  var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  var mb = function (b) { return Math.round(b / 1e6); };
  var mmss = function (s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  // a keyboard-and-mouse machine: the model is too heavy for a phone
  function desktop() { try { return matchMedia('(hover: hover) and (pointer: fine)').matches; } catch (e) { return false; } }

  async function resample(ch, from, to, n) {
    if (from === to) return ch;
    var oc = new OC(2, n, to), b = oc.createBuffer(2, ch[0].length, from);
    b.copyToChannel(ch[0], 0); b.copyToChannel(ch[1], 1);
    var s = oc.createBufferSource(); s.buffer = b; s.connect(oc.destination); s.start(0);
    var r = await oc.startRendering();
    return [r.getChannelData(0), r.getChannelData(1)];
  }

  function why(step, raw) {
    var tail = raw ? ' (' + raw + ')' : '';
    if (step === 'lib') return 'Split could not load its engine from cdn.jsdelivr.net. Check the connection and try again.' + tail;
    if (step === 'net') return 'Split could not download its model from huggingface.co. A claude.ai artifact page is not allowed to reach other sites: open the rack at its own address. Otherwise check the connection and try again.' + tail;
    if (step === 'init') return 'The model would not start in this browser. Chrome or Edge on a computer with a recent graphics card works best.' + tail;
    if (step === 'run') return 'The split stopped part way: the browser may have run out of memory. Try a shorter file.' + tail;
    return 'Split failed.' + tail;
  }

  // one line for a chip or a status row, and how far along (0…1, or −1 = no figure)
  function describe(s) {
    if (!s) return { txt: '', p: -1 };
    var slow = s.gpu === false ? ' · no WebGPU here, so this is slow' : '';
    switch (s.ph) {
      case 'prep': return { txt: 'getting the audio ready', p: -1 };
      case 'lib': return { txt: 'loading the engine', p: -1 };
      case 'dl': return { txt: 'downloading the model, ' + mb(s.got) + ' of ' + mb(s.total) + ' MB (once)', p: s.total ? s.got / s.total : -1 };
      case 'cached': return { txt: 'model from this browser’s cache', p: -1 };
      case 'init': return { txt: 'starting the model' + (s.gpu ? ' on WebGPU' : '') + slow, p: -1 };
      case 'run': return { txt: (s.n ? 'part ' + Math.min(s.n, s.i + 1) + ' of ' + s.n : 'separating') + ' · ' + Math.round(s.p * 100) + '%' + (s.eta != null ? ' · about ' + mmss(s.eta) + ' left' : '') + slow, p: s.p };
      case 'back': return { txt: 'finishing', p: 1 };
    }
    return { txt: '', p: -1 };
  }

  /* run(buf, on): buf is an AudioBuffer (or anything with sampleRate, length, numberOfChannels, getChannelData).
     Resolves to [{ name, L, R }] in the order drums, bass, vocals, other, at buf's own rate and length.
     Rejects with an Error whose .code is 'cancel', 'busy' or the step that failed, and whose .message can be shown. */
  function run(buf, on) {
    if (RUN) { var eb = new Error('A split is already running.'); eb.code = 'busy'; return Promise.reject(eb); }
    var R = RUN = { w: null, st: { ph: 'prep', gpu: null }, dead: false, rej: null, t0: 0 };
    var say = function (o) { if (RUN !== R) return; for (var k in o) R.st[k] = o[k]; try { if (on) on(R.st); } catch (e) { console.error(e); } };
    var fin = function () { if (R.w) { try { R.w.terminate(); } catch (e) {} R.w = null; } if (RUN === R) RUN = null; };
    return new Promise(function (res, rej) {
      R.rej = function (code, msg) { if (R.dead) return; R.dead = true; fin(); var e = new Error(msg); e.code = code; rej(e); };
      (async function () {
        try {
          say({});
          var sr = buf.sampleRate, n = buf.length;
          var src = [new Float32Array(buf.getChannelData(0)), new Float32Array(buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0))];
          var n2 = Math.max(1, Math.round(n * CFG.rate / sr)), x = await resample(src, sr, CFG.rate, n2);
          if (R.dead) return;
          x = [new Float32Array(x[0]), new Float32Array(x[1])];   // our own copies: they go to the worker for good
          var w;
          try { w = R.w = new Worker(SRC, { type: 'module' }); } catch (e) { R.rej('lib', 'This browser cannot start the split engine (no module workers).'); return; }
          w.onerror = function (e) { R.rej(R.st.ph === 'prep' || R.st.ph === 'lib' ? 'lib' : 'run', why(R.st.ph === 'prep' || R.st.ph === 'lib' ? 'lib' : 'run', e && e.message)); };
          w.onmessage = async function (e) {
            var m = e.data; if (R.dead || !m) return;
            if (m.t === 'ph') { say({ ph: m.ph }); if (m.ph === 'run') { R.t0 = performance.now(); say({ p: 0, i: 0, n: 0, eta: null }); } }
            else if (m.t === 'be') say({ gpu: !!m.gpu });
            else if (m.t === 'dl') say({ ph: 'dl', got: m.got, total: m.total });
            else if (m.t === 'note') say({ nocache: true });
            else if (m.t === 'p') { var el = (performance.now() - R.t0) / 1000; say({ ph: 'run', p: m.p, i: m.i, n: m.n, eta: m.p > 0.04 && el > 3 ? el / m.p * (1 - m.p) : null }); }
            else if (m.t === 'err') R.rej(m.step, why(m.step, m.why));
            else if (m.t === 'done') {
              say({ ph: 'back', p: 1 });
              try {
                var out = [];
                for (var k = 0; k < NAMES.length; k++) {
                  var s = m.stems[NAMES[k]], y = await resample([s.L, s.R], CFG.rate, sr, n);
                  if (R.dead) return;
                  // exactly the length that came in: the four clips must end on the same sample
                  var L = new Float32Array(n), Rr = new Float32Array(n), c = Math.min(n, y[0].length);
                  L.set(y[0].subarray(0, c)); Rr.set(y[1].subarray(0, c));
                  out.push({ name: NAMES[k], L: L, R: Rr });
                }
                var st = R.st; R.dead = true; fin(); res({ stems: out, gpu: st.gpu, secs: (performance.now() - R.t0) / 1000, nocache: !!st.nocache });
              } catch (e2) { R.rej('run', why('run', e2 && e2.message)); }
            }
          };
          w.postMessage({ c: 'go', cfg: CFG, L: x[0], R: x[1] }, [x[0].buffer, x[1].buffer]);
          say({ ph: 'lib' });
        } catch (e) { R.rej('run', why('run', e && e.message)); }
      })();
    });
  }

  function cancel() { if (!RUN) return false; RUN.rej('cancel', 'Split cancelled.'); return true; }

  window.StemSplit = { cfg: CFG, names: NAMES, desktop: desktop, run: run, cancel: cancel, busy: function () { return !!RUN; }, describe: describe };
})();
