/* =====================================================================
   HEXTRIG · rack.js
   Link to the Akoma Ntoaso rack: the rack owns the clock and tempo.
   Only runs when this page is loaded inside the rack.
   ===================================================================== */
(function (HX) {
  'use strict';
  if (!window.RACK) return;
  const S = HX.state, seq = HX.seq;
  RACK.register({
    prepare() { HX.audio.ensure(); return Promise.resolve(); },
    playing: () => !!seq.playing,
    // fixed output delay in frames (look-ahead + oversampling): the rack lines every machine up to the slowest.
    // Lean runs both drives at 1× (2 × 47 frames go), Super lean's bare drops the compressor's 6 ms
    latency: () => HX.audio.latencyFrames(),
    getTempo: () => S.project.bpm,
    tempo(v) {
      const b = Math.round(v * 10) / 10;
      S.project.bpm = b; seq.map.spp = 15 / b; seq.map.bpm = b;
      HX.audio.applyFx(S.project.fx); S.changed();
    },
    unlink() { seq.unlinkMap(); },
    // note wires: every trig goes out while the rack listens, scheduled 0.12 s ahead like the sound
    noteListen(on) { HX.rackNotes = !!on; },
    // the rack's Arranger: which pattern plays in each section
    patterns: () => {
      const P = S.project.patterns, inf = seq.playing ? seq.info() : null;
      return { n: P.length, cur: inf ? inf.pat : S.project.current, label: i => String(i + 1), name: i => (P[i] && P[i].name) || '',
        used: P.map(p => p.tracks.some(T => T.steps.some((s, k) => k < p.len && s && !s.trigless))) };
    },
    cue(i, t) { seq.cueAt(i, t); },
    start(t0, p, pat) {
      HX.audio.ensure();
      if (seq.playing || seq.paused) seq.stop();
      seq.start({ fromTop: true, rack: true, at: t0, pat: pat != null ? pat : null });
    },
    stop(at) {
      if (!seq.playing) return;
      if (at != null && at > HX.audio.now() + 0.02) { seq.stopAt = at; return; }
      seq.stop();
    },
  });
})(window.HX);
