/* =====================================================================
   HEXTRIG · oled.js
   The little screen: pattern + tempo, a live scope of the master output,
   six track activity cells, and a parameter readout whenever a value
   changes. Drawn on a 256 × 64 logical canvas with a pixel font.

   Text is the expensive part of a canvas (shaping every glyph, every
   frame). So the words live on their own layer that is redrawn only
   when what it says changes: a few times a second while playing, never
   while nothing moves. Each frame only paints the scope, the activity
   cells and that layer.
   ===================================================================== */
(function (HX) {
  'use strict';
  const S = HX.state;
  const O = (HX.oled = {});
  const W = 256, H = 64;
  let cv, main, layer, lg, g, scale = 1, overlay = null, scope = null, textKey = '';
  const act = [0, 0, 0, 0, 0, 0];
  let colors = { fg: '#e4edf5', dim: '#3a4650', led: '#ff4a1c', bg: '#050607' };

  O.init = function (canvas) {
    cv = canvas;
    main = cv.getContext('2d');
    layer = document.createElement('canvas');
    lg = layer.getContext('2d');
    const cs = getComputedStyle(document.documentElement);
    const pick = (n, d) => (cs.getPropertyValue(n).trim() || d);
    colors = { fg: pick('--oled-fg', colors.fg), dim: pick('--oled-dim', colors.dim), led: pick('--led', colors.led), bg: pick('--oled-bg', colors.bg) };
    resize();
    window.addEventListener('resize', resize);
    // the pixel font arriving changes every word's shape and width
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => { widths.clear(); textKey = ''; });
  };
  function resize() {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(W, Math.round(r.width * dpr));
    if (w === cv.width && layer.width === w) return;
    cv.width = layer.width = w;
    cv.height = layer.height = Math.round(w * H / W);
    scale = w / W;
    curFont = ''; curAlign = '';
    lg.textBaseline = 'top';
    textKey = '';
  }

  O.show = function (label, value, norm, bipolar) {
    overlay = { label, value: String(value), norm: norm == null ? null : norm, bipolar, until: performance.now() + 1300 };
  };
  O.flash = (i, vel) => { act[i] = Math.max(act[i], 0.35 + vel * 0.65); };

  /* ---------- text (on the layer) ---------- */
  const FONTS = { 8: '8px Silkscreen, monospace', 16: '16px Silkscreen, monospace' };
  let curFont = '', curAlign = '';
  const font = size => { const f = FONTS[size] || (FONTS[size] = size + 'px Silkscreen, monospace'); if (f !== curFont) { g.font = f; curFont = f; } };
  const widths = new Map();
  const text = (s, x, y, size = 8, color = colors.fg, align = 'left') => {
    font(size);
    g.fillStyle = color;
    if (align !== curAlign) { g.textAlign = align; curAlign = align; }
    g.fillText(s, x, y);
  };
  const chipW = s => {
    let w = widths.get(s);
    if (w == null) { font(8); w = Math.ceil(g.measureText(s).width) + 5; if (widths.size > 200) widths.clear(); widths.set(s, w); }
    return w;
  };
  const invChip = (s, x, y, color) => {
    const w = chipW(s);
    g.fillStyle = color; g.fillRect(x, y - 1, w, 10);
    text(s, x + 3, y, 8, colors.bg);
    return w;
  };

  /* What the words say right now, as a list of draw calls (and a key to compare). */
  function describe(now) {
    const P = S.pat(), seq = HX.seq, ops = [];
    const blink = Math.floor(now / 250) % 2;
    ops.push(['t', 'A' + (S.project.current + 1), 3, 3, 8, 'fg']);
    ops.push(['t', P.name, 22, 3, 8, 'dim']);
    const ext = S.project.clock.sync === 1;
    const bpm = ext && seq.ext.bpm ? seq.ext.bpm : S.project.bpm * (1 + seq.nudge * 0.04);
    ops.push(['t', bpm.toFixed(1), 226, 3, 8, seq.nudge ? 'led' : 'fg', 'right']);
    ops.push(['t', ext ? 'EXT' : 'BPM', 253, 3, 8, 'dim', 'right']);
    const chips = [];
    const q = seq.queued();
    if (q !== null && blink) chips.push(['>A' + (q + 1), 'fg']);
    if (seq.rec) chips.push([seq.playing ? 'REC' : 'STEP REC', 'led']);
    if (seq.fill) chips.push(['FILL', 'fg']);
    const PF = HX.perform;
    if (PF.edit) chips.push(['SCN ' + PF.edit.toUpperCase() + (S.project.perform[PF.edit] + 1), 'fg', 200]);
    else if (PF.all) chips.push(['ALL', 'fg', 200]);
    const R = HX.rec;
    if (R && R.state === 'armed' && blink) chips.push(['CAP', 'led']);
    if (R && R.state === 'rec') {
      const done = Math.max(0, Math.floor((seq.posNow() - R.startPos) / 16)) + 1;
      chips.push(['CAP ' + done + (R.endPos != null ? '/' + (R.endPos - R.startPos) / 16 : ''), 'led']);
    }
    const song = S.project.song;
    if (song.on && song.entries.length) chips.push(['SONG ' + ((seq.playing ? seq.info().songIdx : 0) + 1) + '/' + song.entries.length, 'dim', 190]);
    ops.push(['chips', chips]);

    if (overlay && now < overlay.until) {
      ops.push(['t', overlay.label, 3, 17, 8, 'dim']);
      ops.push(['t', overlay.value, 3, 28, 16, 'fg']);
      if (overlay.norm != null) ops.push(['bar', Math.round(overlay.norm * 248), overlay.bipolar ? 1 : 0]);
      return ops;
    }
    let status;
    const ac = HX.audio.ctx();
    const blocked = ac && ac.state !== 'running' && (seq.playing || HX.audio.triedSound);
    if (blocked) status = blink ? 'SOUND IS OFF · TAP ANYWHERE' : '';
    else if (seq.waitExt) status = blink ? 'WAITING FOR MIDI START' : '';
    else if (seq.playing && seq.uiCount) status = 'COUNT-IN ' + seq.uiCount;
    else if (seq.playing) {
      const pos = Math.max(0, seq.uiPos || 0);
      status = (Math.floor(pos / 16) + 1) + '.' + (Math.floor(pos / 4) % 4 + 1) + '.' + (pos % 4 + 1) +
        '  STEP ' + String((seq.uiMaster || 0) + 1).padStart(2, '0') + '/' + P.len;
    } else if (seq.paused) status = blink ? 'PAUSED' : '';
    else status = 'STOPPED · ' + P.len + ' STEPS';
    ops.push(['t', status, 253, 54, 8, 'dim', 'right']);
    if (seq.stats.lastStall > 0 && HX.audio.now() - seq.stats.lastStall < 2) ops.push(['chip', 'SYNC', 84, 54, 'led']);
    return ops;
  }

  function paintLayer(ops) {
    g = lg;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, layer.width, layer.height);
    g.setTransform(scale, 0, 0, scale, 0, 0);
    for (const o of ops) {
      if (o[0] === 't') text(o[1], o[2], o[3], o[4], colors[o[5]], o[6]);
      else if (o[0] === 'chip') invChip(o[1], o[2], o[3], colors[o[4]]);
      else if (o[0] === 'chips') {
        let cx = 80;
        for (const c of o[1]) { if (c[2] && cx >= c[2]) continue; cx += invChip(c[0], cx, 3, colors[c[1]]) + 3; }
      } else if (o[0] === 'bar') {
        const norm = o[1] / 248;
        g.strokeStyle = colors.dim; g.lineWidth = 1;
        g.strokeRect(3.5, 51.5, 249, 6);
        g.fillStyle = colors.fg;
        if (o[2]) {
          const z = 4 + 248 * 0.5, x = 4 + 248 * norm;
          g.fillRect(Math.min(z, x), 53, Math.abs(x - z) || 1, 4);
          g.fillRect(z, 50, 1, 9);
        } else g.fillRect(4, 53, 248 * norm, 4);
      }
    }
  }

  O.draw = function () {
    if (!main) return;
    const now = performance.now();
    const ops = describe(now);
    const key = JSON.stringify(ops);
    if (key !== textKey) { textKey = key; paintLayer(ops); }

    g = main;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = colors.bg;
    g.fillRect(0, 0, W, H);
    if (!(overlay && now < overlay.until)) {
      drawScope();
      for (let i = 0; i < 6; i++) {
        const x = 3 + i * 13;
        g.fillStyle = colors.dim;
        g.fillRect(x, 54, 10, 7);
        if (act[i] > 0.02) { g.globalAlpha = act[i]; g.fillStyle = colors.fg; g.fillRect(x, 54, 10, 7); g.globalAlpha = 1; }
        if (!HX.seq.audible(i)) { g.fillStyle = colors.bg; g.fillRect(x + 2, 57, 6, 1); }
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(layer, 0, 0);
    for (let i = 0; i < 6; i++) act[i] *= 0.86;
  };

  function drawScope() {
    const an = HX.audio.analyser();
    const y0 = 34, amp = 15;
    g.strokeStyle = colors.dim;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(3, y0 + 0.5); g.lineTo(253, y0 + 0.5); g.stroke();
    if (!an) {
      // drawn straight on the screen, only until the audio exists
      g.font = '8px Silkscreen, monospace'; g.fillStyle = colors.dim; g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText('PRESS PLAY', 128, 30);
      return;
    }
    if (!scope || scope.length !== an.fftSize) scope = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(scope);
    // align to a rising zero crossing for a steady picture
    let s0 = 0;
    for (let k = 1; k < scope.length / 2; k++) if (scope[k - 1] < 0 && scope[k] >= 0) { s0 = k; break; }
    const n = 250, stride = 2;
    g.strokeStyle = colors.fg;
    g.beginPath();
    for (let x = 0; x < n; x++) {
      const v = scope[Math.min(scope.length - 1, s0 + x * stride)] || 0;
      const y = y0 - Math.max(-1, Math.min(1, v * 1.4)) * amp;
      if (x === 0) g.moveTo(3 + x, y); else g.lineTo(3 + x, y);
    }
    g.stroke();
  }
})(window.HX);
