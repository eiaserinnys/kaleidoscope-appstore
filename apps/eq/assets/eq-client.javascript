"use strict";
(() => {
  const FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const BAND_NAMES = ["깊은 저음", "저음", "저음", "중저음", "중음", "중음", "중고음", "고음", "고음", "공기감"];
  const Q = 1.41; // 한 옥타브 폭. 이웃 밴드가 자연스럽게 겹친다.
  const FS = 48000;
  const GAIN_LIMIT = 15; // 밴드 하나의 최종 이득 한계(dB).
  const TONE_LIMIT = 12; // 저음·중음·고음 손잡이 한계(dB).
  const HEADROOM_DB = 4;
  const REVERB_TRIM_DB = 2;
  const TONES = [
    { key: "low", label: "저음", hz: "32–250 Hz", bands: [0, 1, 2, 3] },
    { key: "mid", label: "중음", hz: "500 Hz–2 kHz", bands: [4, 5, 6] },
    { key: "high", label: "고음", hz: "4–16 kHz", bands: [7, 8, 9] },
  ];
  const SPATIAL = [
    { value: "0", label: "끔", amount: 0 },
    { value: "0.35", label: "약하게", amount: 0.35 },
    { value: "0.65", label: "보통", amount: 0.65 },
    { value: "1", label: "강하게", amount: 1 },
  ];
  const SCENES = [
    { key: "studio", name: "Original", desc: "더하거나 빼지 않은 원래 소리 그대로", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], reverb: null },
    { key: "concert-hall", name: "Concert Hall", desc: "넓은 홀의 긴 잔향과 따뜻한 저음", gains: [3, 3, 2, 0, -1, -1, 0, 1, 2, 1], reverb: { decay: 2.4, predelay: 28, wet: -2 } },
    { key: "jazz-club", name: "Jazz Club", desc: "가까운 무대, 짧고 포근한 울림", gains: [3, 3, 1, 2, 0, -1, 0, 2, 2, 2], reverb: { decay: 0.9, predelay: 9, wet: -9 } },
    { key: "live", name: "Live", desc: "공연장 앞줄처럼 생생하고 힘 있게", gains: [2, 2, 0, -1, 0, 2, 3, 3, 2, 1], reverb: { decay: 1.3, predelay: 15, wet: -5 } },
    { key: "club", name: "Club", desc: "몸으로 느끼는 묵직한 저음", gains: [7, 6, 3, 0, -2, -1, 0, 1, 3, 3], reverb: { decay: 0.7, predelay: 6, wet: -9 } },
    { key: "cinema", name: "Cinema", desc: "또렷한 대사와 큰 공간감", gains: [4, 3, 1, 0, 0, 1, 2, 2, 2, 1], reverb: { decay: 1.6, predelay: 20, wet: -8 } },
  ];
  const GENRES = [
    { key: "rock", name: "Rock", desc: "힘 있는 저음과 또렷한 기타", gains: [5, 4, 3, 0, -2, -1, 2, 4, 5, 5], reverb: null },
    { key: "pop", name: "Pop", desc: "보컬과 비트를 앞으로", gains: [-1, 2, 4, 5, 3, 0, -1, -1, 2, 3], reverb: null },
    { key: "jazz", name: "Jazz", desc: "따뜻한 베이스와 부드러운 고음", gains: [4, 3, 1, 2, -1, -1, 0, 2, 3, 4], reverb: null },
    { key: "classical", name: "Classical", desc: "넓은 음역을 고르게", gains: [5, 4, 3, 2, -1, -1, 0, 2, 4, 4], reverb: null },
    { key: "electronic", name: "Electronic", desc: "깊은 저음과 반짝이는 고음", gains: [7, 6, 2, 0, -2, 1, 0, 2, 5, 6], reverb: null },
    { key: "hip-hop", name: "Hip-Hop", desc: "단단한 킥과 베이스", gains: [7, 6, 3, 3, -1, -1, 1, 0, 2, 3], reverb: null },
    { key: "acoustic", name: "Acoustic", desc: "악기의 결을 자연스럽게", gains: [3, 3, 2, 1, 2, 2, 3, 4, 3, 2], reverb: null },
  ];
  const COLORS = [
    { key: "deep-bass", name: "Deep Bass", desc: "몸으로 느끼는 깊은 저음", gains: [10, 9, 6, 2, -1, -1, 0, 0, 0, 0], reverb: null },
    { key: "bass-boost", name: "Bass Boost", desc: "저음을 조금 더", gains: [7, 6, 4, 2, 0, 0, 0, 0, 0, 0], reverb: null },
    { key: "bass-cut", name: "Bass Cut", desc: "웅웅거리는 저음을 덜어 내기", gains: [-8, -6, -4, -2, 0, 0, 0, 0, 0, 0], reverb: null },
    { key: "treble-boost", name: "Treble Boost", desc: "또렷하고 반짝이게", gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7], reverb: null },
    { key: "treble-cut", name: "Treble Cut", desc: "쏘는 고음을 부드럽게", gains: [0, 0, 0, 0, 0, -1, -3, -5, -6, -7], reverb: null },
    { key: "vocal", name: "Vocal", desc: "목소리와 팟캐스트를 앞으로", gains: [-3, -2, -1, 1, 3, 4, 4, 3, 1, 0], reverb: null },
    { key: "spoken-word", name: "Spoken Word", desc: "말소리를 또렷하게", gains: [-6, -4, -1, 1, 3, 5, 5, 3, 1, -2], reverb: null },
    { key: "late-night", name: "Late Night", desc: "작게 틀어도 또렷하게", gains: [-4, -3, -1, 0, 0, 1, 1, 0, -1, -3], reverb: null },
    { key: "loudness", name: "Loudness", desc: "작은 볼륨에서도 저음과 고음이 살게", gains: [7, 5, 1, 0, -2, 0, -1, -1, 5, 4], reverb: null },
    { key: "small-speakers", name: "Small Speakers", desc: "노트북·작은 스피커를 크게", gains: [-5, -2, 3, 4, 2, 1, 1, 2, 3, 2], reverb: null },
    { key: "footsteps", name: "Footsteps", desc: "게임의 발소리와 효과음을 앞으로", gains: [-4, -3, -2, 0, 0, 2, 5, 6, 4, 0], reverb: null },
  ];
  const AXES = [
    { field: "genre", list: GENRES },
    { field: "color", list: COLORS },
  ];
  const FRESH = { scene: "studio", genre: null, color: null, edits: {}, spatial: 0, enabled: true, auto_preamp: true, preamp: 0 };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clamp01 = v => clamp(Number.isFinite(v) ? v : 0, 0, 1);
  const round1 = v => Math.round(v * 10) / 10;
  const zeros = () => FREQS.map(() => 0);
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const vec = a => FREQS.map((_, i) => num(a && a[i]));
  function peaking(f0, gain) {
    const A = Math.pow(10, gain / 40), w0 = 2 * Math.PI * f0 / FS;
    const alpha = Math.sin(w0) / (2 * Q), c = Math.cos(w0);
    const a0 = 1 + alpha / A;
    return { b0: (1 + alpha * A) / a0, b1: -2 * c / a0, b2: (1 - alpha * A) / a0, a1: -2 * c / a0, a2: (1 - alpha / A) / a0 };
  }
  function magDb(f, filters) {
    const w = 2 * Math.PI * f / FS, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    let db = 0;
    for (const h of filters) {
      const nr = h.b0 + h.b1 * c1 + h.b2 * c2, ni = -(h.b1 * s1 + h.b2 * s2);
      const dr = 1 + h.a1 * c1 + h.a2 * c2, di = -(h.a1 * s1 + h.a2 * s2);
      db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
    }
    return db;
  }
  const filtersOf = gains => gains.map((g, i) => [FREQS[i], g]).filter(([, g]) => g !== 0).map(([f, g]) => peaking(f, g));
  function curve(gains, n) {
    const fs = filtersOf(gains), out = [];
    for (let i = 0; i < n; i++) { const f = 20 * Math.pow(1000, i / (n - 1)); out.push([f, magDb(f, fs)]); }
    return out;
  }
  function autoPreamp(gains, hasReverb) {
    const peak = Math.max(0, ...curve(gains, 400).map(([, d]) => d));
    const trim = Math.max(0, peak - HEADROOM_DB) + (hasReverb ? REVERB_TRIM_DB : 0);
    return trim === 0 ? 0 : -Math.ceil(trim * 10) / 10;
  }
  function catalog(mine) {
    return SCENES.concat((mine || []).map(p => ({ key: p.key, name: p.name, desc: p.desc || "내 프리셋", gains: vec(p.gains), reverb: p.reverb || null, mine: true })));
  }
  const sceneOf = (cat, key) => cat.find(s => s.key === key) || cat[0];
  const pickOf = (p, axis) => (p[axis.field] && axis.list.find(x => x.key === p[axis.field])) || null;
  const picksOf = (cat, p) => (sceneOf(cat, p.scene).mine ? [] : AXES.map(a => pickOf(p, a)).filter(Boolean));
  const amountOf = (p, key) => clamp01(p.amounts && p.amounts[key] != null ? num(p.amounts[key]) : 1);
  const scaledReverb = (r, a) => (!r || a < 0.02 ? null : a >= 0.995 ? r : { ...r, wet: round1(r.wet + 20 * Math.log10(a)) });
  const pct = a => (a < 0.995 ? ` ${Math.round(a * 100)}%` : "");
  function layerOf(cat, p) {
    const space = sceneOf(cat, p.scene), picks = picksOf(cat, p);
    const sa = space.mine ? 1 : amountOf(p, space.key);
    if (!picks.length && sa >= 0.995) return space;
    const spaceName = space.name + (space.key === SCENES[0].key ? "" : pct(sa));
    const parts = picks.map(x => ({ x, a: amountOf(p, x.key) }));
    return { key: [space.key, ...picks.map(x => x.key)].join("+"), mine: space.mine,
             name: [spaceName, ...parts.map(({ x, a }) => x.name + pct(a))].join(" + "),
             desc: [space.desc, ...picks.map(x => x.desc)].join(", "),
             gains: space.gains.map((g, i) => parts.reduce((sum, { x, a }) => sum + x.gains[i] * a, g * sa)),
             reverb: scaledReverb(space.reverb, sa) };
  }
  const profileOf = (profiles, id, start = FRESH) => moved({ ...start, ...((profiles && id && profiles[id]) || {}) });
  const MOVED_TO_COLOR = ["vocal", "late-night"];
  function moved(p) {
    if (!MOVED_TO_COLOR.includes(p.scene)) return p;
    const edits = { ...(p.edits || {}) };
    for (const k of Object.keys(edits)) if (k === p.scene || k.startsWith(p.scene + "+")) {
      edits[[SCENES[0].key, ...k.split("+").slice(1), p.scene].join("+")] = edits[k];
      delete edits[k];
    }
    return { ...p, scene: SCENES[0].key, color: p.color || p.scene, edits };
  }
  function startOf(legacy) {
    if (!legacy || !Array.isArray(legacy.gains)) return FRESH;
    const on = legacy.presets || [];
    const space = SCENES.find(x => on.includes(x.key));
    const start = { ...FRESH, scene: space ? space.key : FRESH.scene };
    for (const a of AXES) { const x = a.list.find(y => on.includes(y.key)); if (x) start[a.field] = x.key; }
    if (!space && AXES.every(a => !start[a.field])) return FRESH;
    const scene = layerOf(SCENES, start);
    const edits = vec(legacy.gains).map((g, i) => g - scene.gains[i]);
    return { ...start, edits: edits.some(e => e !== 0) ? { [scene.key]: edits } : {},
             enabled: legacy.enabled !== false, auto_preamp: legacy.auto_preamp !== false, preamp: Number(legacy.preamp) || 0 };
  }
  const editsKey = p => [p.scene, ...AXES.map(a => pickOf(p, a)).filter(Boolean).map(x => x.key)].join("+");
  const editsOf = p => vec(p.edits && p.edits[editsKey(p)]);
  const gainsOf = (p, scene) => scene.gains.map((g, i) => clamp(g + editsOf(p)[i], -GAIN_LIMIT, GAIN_LIMIT));
  const isCustom = p => editsOf(p).some(v => Math.abs(v) > 1e-9);
  const labelOf = (p, scene) => (isCustom(p) ? `${scene.name} (커스텀)` : scene.name);
  function withEdits(p, edits) {
    const all = { ...(p.edits || {}) };
    if (edits.some(v => Math.abs(v) > 1e-9)) all[editsKey(p)] = edits.map(round1);
    else delete all[editsKey(p)];
    return { ...p, edits: all };
  }
  function setBand(p, scene, index, g) {
    const e = editsOf(p);
    e[index] = clamp(num(g), -GAIN_LIMIT, GAIN_LIMIT) - scene.gains[index];
    return withEdits(p, e);
  }
  const toneOf = (p, tone) => round1(tone.bands.reduce((s, i) => s + editsOf(p)[i], 0) / tone.bands.length);
  function setTone(p, tone, v) {
    const e = editsOf(p), d = clamp(num(v), -TONE_LIMIT, TONE_LIMIT) - toneOf(p, tone);
    for (const i of tone.bands) e[i] += d;
    return withEdits(p, e);
  }
  const resetScene = p => withEdits(p, zeros());
  const preampOf = (p, scene) => (p.auto_preamp === false ? num(p.preamp) : autoPreamp(gainsOf(p, scene), !!scene.reverb));
  function renderConfig(p, scene) {
    const gains = gainsOf(p, scene);
    return {
      enabled: p.enabled !== false,
      preamp: preampOf(p, scene),
      peaks: gains.map((g, i) => [FREQS[i], Q, round1(g)]).filter(([, , g]) => g !== 0),
      reverb: scene.reverb ? { ...scene.reverb } : null,
      spatial: clamp01(num(p.spatial)),
    };
  }
  function newPreset(mine, p, scene) {
    const base = `${scene.name.replace(/( ·)? 내 설정( \d+)?$/, "")} 내 설정`;  // 예전 판의 「… · 내 설정」도 알아본다
    const names = new Set((mine || []).map(m => m.name));
    let name = base, n = 2;
    while (names.has(name)) name = `${base} ${n++}`;
    let key = "user-" + name.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "");
    const keys = new Set(catalog(mine).map(s => s.key));
    while (keys.has(key)) key += "-";
    return { key, name, desc: `${scene.name}에서 만든 내 프리셋`, gains: gainsOf(p, scene).map(round1), reverb: scene.reverb || null };
  }
  function splitName(name) {
    const s = String(name || "").trim(), at = s.indexOf(" (");
    if (at < 0 || !s.endsWith(")")) return { title: s, sub: "" };
    let title = s.slice(at + 2, -1).trim();
    for (let prev = ""; prev !== title;) { prev = title; title = title.replace(/\s+(stereo|hands-?free|ag audio)$/i, "").trim(); }
    return { title: title || s, sub: s.slice(0, at).trim() };
  }
  function musicDevice(device, devices, last) {
    if (!device) return null;
    if (device.kind !== "headset") return device;
    const same = splitName(device.name).title;
    return (devices || []).find(d => d.kind !== "headset" && splitName(d.name).title === same) || last || null;
  }
  const DURATION = 450;
  const easeOutCubic = t => 1 - Math.pow(1 - clamp01(t), 3);
  const progress = (start, now) => clamp01((now - start) / DURATION);
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpVec = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
  function tween(value) { return { from: value, to: value, start: null, value }; }
  function retarget(tw, to) { tw.from = tw.value; tw.to = to; tw.start = null; }
  function stepTween(tw, now) {
    if (tw.start === null) tw.start = now;
    const p = progress(tw.start, now), e = easeOutCubic(p);
    tw.value = Array.isArray(tw.to) ? lerpVec(tw.from, tw.to, e) : lerp(tw.from, tw.to, e);
    return p < 1;
  }
  const k = window.kaleidoscope;
  const BRIDGE = {"gz": "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", "key": "eq-bridge-551d855be6b5"};
  async function gunzip(b64) {
    if (typeof DecompressionStream !== "function") throw new Error("이 쉘은 압축 풀기(DecompressionStream)를 지원하지 않아요");
    const gz = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }
  const ENGINE = {"asset": "eq-engine", "sha256": "f1775e7ffd530455b3496ee1d96b455cf49adcb6993efc7190b57dd845227002"};
  const WORK = "work"; // 다리를 띄울 작업 폴더 권한(파일은 만들지 않는다).
  let profiles = {}, mine = [], legacy = null;
  let bridge = { phase: "starting", message: "" };
  let engine = null, device = null, devices = [], lastMusic = null;
  let busy = "", note = "";
  const cat = () => catalog(mine);
  const current = () => {
    const d = musicDevice(device, devices, lastMusic);
    const p = profileOf(profiles, d && d.id, startOf(legacy)), scene = layerOf(cat(), p);
    return { d, p, scene };
  };
  let saveTimer = null, saving = 0, remoteProfiles = null;
  function updateProfile(change) {
    const { d, p } = current();
    if (!d) return;
    const next = change(p);
    profiles = { ...profiles, [d.id]: { ...next, name: d.name, kind: d.kind } };
    changed();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProfiles, 250);
  }
  async function saveProfiles() {
    saveTimer = null;
    saving++;
    try { await k.setStorage("profiles", profiles); }
    catch (e) { fail(e); }
    finally {
      saving--;
      if (!saving && !saveTimer && remoteProfiles) { profiles = remoteProfiles; remoteProfiles = null; changed(); }
    }
  }
  function onRemoteProfiles(v) {
    const value = v && typeof v === "object" ? v : {};
    if (saving || saveTimer) { remoteProfiles = value; return; }
    profiles = value;
    changed();
  }
  async function saveMine(next) { mine = next; changed(); await k.setStorage("my_presets", next); }
  const KEY = BRIDGE.key;
  const BLOB = `bridge/${KEY}.ps1`;
  let handle = null, after = 0, partial = "", starting = null, seq = 0, writeChain = Promise.resolve();
  const waiting = new Map();
  function pathOf(uri) {
    const u = new URL(uri), path = decodeURIComponent(u.pathname);
    const local = /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
    return (u.host ? "\\\\" + u.host : "") + local.replace(/\//g, "\\");
  }
  async function scriptPath() {
    const bytes = await gunzip(BRIDGE.gz);
    await k.blobs.put({ key: BLOB, bytes: bytes.buffer });
    return pathOf(await k.process.file_uri(BLOB));
  }
  const SPEC = file => ({ key: KEY, permission: "bridge", cwd_permission: WORK,
    spec: { name: "EQ 사운드 엔진 다리", command: "powershell",
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", loader(file)], env: {} } });
  function loader(file) {
    const long = file.startsWith("\\\\") ? "\\\\?\\UNC\\" + file.slice(2) : "\\\\?\\" + file;
    return `& ([scriptblock]::Create([IO.File]::ReadAllText('${long.replace(/'/g, "''")}')))`;
  }
  async function launch() {
    const file = await scriptPath();
    if (!handle) setBridge("permission");
    return k.process.start(SPEC(file));
  }
  function adopt(r) {
    if (handle) return true;
    if (!r || r.status === "cancelled" || !r.handle || r.exit) return false;
    handle = r.handle; after = r.after ?? 0; partial = "";
    setBridge("ready");
    drain();
    return true;
  }
  function ensureBridge() {
    if (handle) return Promise.resolve(true);
    if (starting) return starting;
    starting = (async () => {
      try {
        if (adopt(await k.process.attach({ key: KEY }))) return true;
        if (!k.files.grant(WORK)) { setBridge("need_folder"); return false; }
        if (adopt(await launch())) return true;
        setBridge("cancelled");
        return false;
      } catch (e) {
        setBridge("error", messageOf(e));
        return false;
      } finally { starting = null; }
    })();
    return starting;
  }
  async function askAgain() {
    try { if (adopt(await launch())) await request({ op: "status" }); }
    catch (e) { setBridge("error", messageOf(e)); }
  }
  function dropBridge(message) {
    handle = null;
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
    setBridge(message ? "error" : "starting", message || "");
  }
  let draining = false, again = false;
  async function drain() {
    if (draining) { again = true; return; }
    draining = true;
    try { do { again = false; await drainOnce(); } while (again); }
    catch (e) { setBridge("error", messageOf(e)); }
    finally { draining = false; }
  }
  async function drainOnce() {
    if (!handle) return;
    const h = handle;
    for (;;) {
      const r = await k.process.read({ handle: h, after, max_bytes: 65536 });
      const bytes = new Uint8Array(r.bytes || []);
      if (bytes.length) {
        partial += new TextDecoder().decode(bytes, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop();
        for (const l of lines) if (l.trim()) { try { onLine(JSON.parse(l)); } catch { /* 다리의 진단 줄은 넘긴다 */ } }
        after = r.next;
        await k.process.ack({ handle: h, after, checkpoint: {} });
        continue;
      }
      if (r.exit) {
        const tail = new TextDecoder().decode(new Uint8Array(r.stderr_tail || [])).trim().split(/\r?\n/).slice(-3).join(" ");
        dropBridge(`사운드 엔진 다리가 멈췄어요${r.exit.code != null ? ` (코드 ${r.exit.code})` : ""}.${tail ? " " + tail.slice(-300) : ""}`);
      }
      return;
    }
  }
  function onLine(msg) {
    if (msg.event === "device") { setDevice(msg.device); changed(); void request({ op: "status" }); return; }
    if (msg.status === "ok") {
      if ("engine" in msg) engine = msg.engine;
      if ("device" in msg) setDevice(msg.device);
      if (Array.isArray(msg.devices)) devices = msg.devices;
      if (bridge.phase === "error") setBridge("ready");
    } else if (msg.status === "error") note = `엔진이 답했어요: ${msg.message || "알 수 없는 오류"}`;
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (resolve) resolve(msg);
    changed();
  }
  function setDevice(d) {
    const before = current().d;
    device = d || null;
    if (device && device.kind !== "headset") lastMusic = device;
    const now = current().d;
    if ((before && before.id) !== (now && now.id)) schedule(); // 장치가 바뀌면 그 장치의 프로필로 곧바로.
  }
  const ascii = s => s.replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  async function request(body) {
    if (!(await ensureBridge())) return null;
    const id = ++seq, h = handle;
    const answer = new Promise(resolve => waiting.set(id, resolve));
    const bytes = new TextEncoder().encode(ascii(JSON.stringify({ id, ...body })) + "\n");
    writeChain = writeChain.then(async () => {
      for (let o = 0; o < bytes.length; o += 65536)
        await k.process.write({ handle: h, bytes: bytes.subarray(o, o + 65536), checkpoint: {} });
    }).catch(e => { waiting.delete(id); fail(e); });
    return answer;
  }
  let dirty = false, applying = false, applyTimer = null, applied = "", retries = 0;
  function schedule() {
    dirty = true;
    clearTimeout(applyTimer);
    applyTimer = setTimeout(flush, 40);
  }
  async function flush() {
    if (applying) return;
    applying = true;
    try {
      while (dirty) {
        dirty = false;
        const { d, p, scene } = current();
        if (!handle || !engine || !engine.installed || !d) continue;
        const body = { op: "apply", device_id: d.id, config: renderConfig(p, scene) };
        const key = JSON.stringify([handle, engine, d.registered, body]);
        if (key === applied) continue;
        applied = key;
        const r = await request(body);
        if (r && r.status === "ok") {
          if (retries && note.startsWith("엔진이 답했어요")) note = ""; // 다시 보내서 들어갔으면 오류 안내도 거둔다
          retries = 0;
          continue;
        }
        applied = "";
        if (retries < 3) setTimeout(schedule, 500 * 2 ** retries++);
      }
    } catch (e) { fail(e); }
    finally { applying = false; }
  }
  const KIND = { headphones: "헤드폰", headset: "통화용 헤드셋", speakers: "스피커", other: "출력 장치" };
  const messageOf = e => (e && e.message ? e.message : String(e));
  function fail(e) { note = `문제가 생겼어요: ${messageOf(e)}`; changed(); }
  function setBridge(phase, message = "") { bridge = { phase, message }; changed(); }
  function setup(d) {
    if (bridge.phase === "need_folder") return { key: "folder", title: "시작하기",
      text: "EQ가 Windows 소리 설정과 이야기하려면 작업 폴더 하나를 정해야 해요. 아래에서 허용하면 끝이에요. 그 폴더에 파일을 만들지는 않아요." };
    if (bridge.phase === "cancelled") return { key: "allow", title: "실행 허용이 필요해요",
      text: "EQ는 PowerShell로 사운드 엔진과 이야기해요. 「다시 시도」를 누르고 실행을 허용해 주세요.", button: "다시 시도", icon: "refresh-cw" };
    if (bridge.phase === "permission") return { key: "permission", title: "PowerShell 실행 허용을 기다려요",
      text: "이 창에 「이 앱이 이 PC에서 powershell을(를) 실행하게 할까요?」가 떠 있으면 「허용」을 눌러 주세요. 처음 한 번만 물어요. 허용 창이 보이지 않으면 아래 단추로 다시 띄워요.",
      button: "허용 창 다시 띄우기", icon: "refresh-cw" };
    if (bridge.phase === "error") return { key: "allow", title: "사운드 엔진과 연결하지 못했어요",
      text: bridge.message || "알 수 없는 오류", button: "다시 시도", icon: "refresh-cw" };
    if (bridge.phase !== "ready" || !engine) return { key: "loading", title: "사운드 엔진 상태를 읽는 중…",
      text: "처음 한 번은 3~5초쯤 걸려요." };
    if (busy === "install") return { key: "busy", title: "사운드 엔진 설치 중…",
      text: "Windows 확인 창에서 「예」를 눌러 주세요. 소리가 1초쯤 끊겼다가 돌아와요." };
    if (!ENGINE && !engine.installed) return { key: "manual", title: "사운드 엔진이 필요해요",
      text: "이 판에는 사운드 엔진이 들어 있지 않아 따로 설치해야 해요. 설치하면 이 화면이 저절로 알아채요." };
    if (!ENGINE && d && !d.registered) return { key: "manual", title: `「${splitName(d.name).title}」은(는) 아직 연결 전이에요`,
      text: "이 판에는 사운드 엔진이 들어 있지 않아, 이 장치에 연결하려면 엔진을 따로 설치(또는 다시 설치)해야 해요. 연결되면 이 화면이 저절로 알아채요." };
    if (!engine.installed) return { key: "install", title: "사운드 엔진 설치",
      text: "Windows의 모든 소리에 EQ와 공간감을 걸려면 사운드 엔진을 한 번 설치해야 해요. 관리자 확인 창이 한 번 뜨고, 소리가 1초쯤 끊겼다가 돌아와요. 재부팅은 필요 없어요.",
      button: "사운드 엔진 설치", icon: "download" };
    if (d && !d.registered) return { key: "connect", title: `「${splitName(d.name).title}」에 연결`,
      text: "이 장치에는 아직 사운드 엔진이 붙어 있지 않아요. 관리자 확인 한 번이면 연결돼요.", button: "이 장치에 연결", icon: "power" };
    return null;
  }
  function progressOf(d) {
    const steps = [
      ["작업 폴더 허용", !!k.files.grant(WORK)],
      ["PowerShell 실행 허용", !!handle],
      ["엔진 상태 읽기", !!engine],
      ["사운드 엔진 설치", !!(engine && engine.installed)],
      ["이 장치에 연결", !!(d && d.registered)],
    ];
    const at = steps.findIndex(([, done]) => !done);
    const n = at < 0 ? steps.length : at;
    return { percent: Math.round((n / steps.length) * 100),
             label: at < 0 ? "" : `${n + 1}/${steps.length}단계: ${steps[at][0]}` };
  }
  function engineState(d) {
    if (bridge.phase !== "ready" || !engine) return "사운드 엔진 확인 중…";
    if (!engine.installed) return "사운드 엔진이 필요해요";
    if (!d) return "출력 장치를 찾는 중…";
    if (!d.registered) return "이 장치에는 아직 연결 전";
    return d.active ? "적용 중" : "소리가 나오면 적용돼요";
  }
  function axisOutputs(p) {
    const onMine = sceneOf(cat(), p.scene).mine, out = {};
    for (const a of AXES) {
      const x = onMine ? null : pickOf(p, a);
      out[a.field + "s"] = a.list.map(y => ({ key: y.key, name: y.name, on: !!x && y.key === x.key }));
      out[a.field + "_amount_show"] = !!x;
      out[a.field + "_amount"] = x ? Math.round(amountOf(p, x.key) * 100) : 100;
      out[a.field + "_desc"] = x ? `${x.desc}. 다시 누르면 꺼져요` : "공간에 겹쳐 쓸 수 있어요";
    }
    return out;
  }
  function publish() {
    const { d, p, scene } = current();
    const s = setup(d);
    const on = p.enabled !== false;
    const custom = isCustom(p);
    const label = labelOf(p, scene);
    const gains = gainsOf(p, scene);
    const preamp = preampOf(p, scene);
    const callMode = device && device.kind === "headset";
    const name = splitName(d && d.name);
    const others = Object.entries(profiles).filter(([id]) => !d || id !== d.id)
      .map(([id, q]) => ({ value: id, label: `${q.name ? splitName(q.name).title : "다른 기기"}: ${labelOf(profileOf(profiles, id), layerOf(cat(), profileOf(profiles, id)))}` }));
    const spatial = SPATIAL.reduce((a, b) => (Math.abs(b.amount - num(p.spatial)) < Math.abs(a.amount - num(p.spatial)) ? b : a));
    k.publish({
      device_title: d ? name.title : callMode ? splitName(device.name).title : "출력 장치 없음",
      device_meta: d ? [name.sub || KIND[d.kind] || KIND.other, on ? label : "꺼짐(원래 소리)", engineState(d)].join(", ")
        : callMode ? "통화용 연결(핸즈프리)에서는 EQ가 쉬어요" : engineState(null),
      no_device: !d,
      power: on,
      setup_show: !!s,
      setup_percent: progressOf(d).percent,
      setup_step: progressOf(d).label,
      setup_title: s ? s.title : "",
      setup_text: s ? s.text : "",
      setup_button: s && s.button ? s.button : "",
      setup_icon: s && s.icon ? s.icon : "download",
      setup_has_button: !!(s && s.button),
      need_folder: !!(s && s.key === "folder"),
      note_show: !!note,
      note,
      scenes: SCENES.map(x => ({ key: x.key, name: x.name, on: x.key === p.scene })),
      ...axisOutputs(p),
      space_amount_show: p.scene !== SCENES[0].key && !sceneOf(cat(), p.scene).mine,
      space_amount: Math.round(amountOf(p, p.scene) * 100),
      scene_desc: (s0 => (s0.mine ? "" : s0.desc + (s0.reverb ? `, 잔향 ${s0.reverb.decay.toFixed(1)}초` : "")
        + (s0.key !== SCENES[0].key ? ". 다시 누르면 꺼져요" : "")))(sceneOf(cat(), p.scene)),
      fresh_show: !!d && !profiles[d.id] && others.length > 0,
      fresh_text: startOf(legacy) === FRESH ? "처음 쓰는 기기라 원음으로 시작했어요."
        : `처음 쓰는 기기라 이전 EQ 설정(${layerOf(cat(), startOf(legacy)).name})으로 시작했어요.`,
      copy_options: others,
      copy_value: null, // 고르면 곧바로 가져오고 고르기는 비운다.
      spatial: spatial.value,
      spatial_options: SPATIAL.map(({ value, label: l }) => ({ value, label: l })),
      spatial_hint: d && d.kind === "speakers" ? "헤드폰용이에요. 스피커에서는 효과가 거의 없어요."
        : "호를 끌어 소리가 머리를 감싸는 정도를 정해요. 넓힐수록 스피커로 듣는 것처럼 머리 밖으로 퍼져요.",
      tones: TONES.map(t => ({ key: t.key, label: t.label, hz: t.hz, value: toneOf(p, t) })),
      bands: FREQS.map((f, i) => ({ key: String(i), index: i, label: BAND_NAMES[i],
                                    hz: f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`, gain: round1(gains[i]) })),
      custom,
      not_custom: !custom,
      custom_meta: custom ? "고친 값은 이 기기에 저절로 저장돼요" : "",
      auto_preamp: p.auto_preamp !== false,
      manual_preamp: p.auto_preamp === false,
      preamp: num(p.preamp),
      preamp_text: `지금 ${preamp > 0 ? "+" : ""}${preamp.toFixed(1)} dB${p.auto_preamp === false ? "" : " (자동)"}`,
      mine_show: mine.length > 0,
      mine: mine.map(m => ({ key: m.key, title: m.name, subtitle: m.desc || "" })),
      mine_selected: scene.mine ? scene.key : null,
      engine_show: !!(engine && engine.installed),
      engine_text: engine && engine.installed ? `사운드 엔진 ${engine.version || ""}`.trim() : "",
    });
  }
  let lastView = "";
  function retargetAll() {
    const { p, scene } = current();
    const view = { gains: gainsOf(p, scene).map(round1), power: p.enabled !== false ? 1 : 0, spatial: clamp01(num(p.spatial)) };
    const text = JSON.stringify(view);
    if (text === lastView) return;
    lastView = text;
    k.setState("view", view);
  }
  let lastStage = 0, lastCurve = 0;
  k.onStateChange(st => {
    const e = st && st.stage_input;
    if (e && typeof e === "object" && e.seq !== lastStage) {
      lastStage = e.seq;
      updateProfile(q => ({ ...q, spatial: clamp01(num(e.v)) }));
    }
    const b = st && st.curve_input;
    if (b && typeof b === "object" && b.seq !== lastCurve && Number.isInteger(b.band) && b.band >= 0 && b.band < FREQS.length) {
      lastCurve = b.seq;
      updateProfile(q => setBand(q, layerOf(cat(), q), b.band, b.gain));
    }
  });
  const keyOf = c => (c && c.item && c.item.key !== undefined ? c.item.key : c && c.key);
  const changed = () => { publish(); retargetAll(); schedule(); };
  k.handle("power", c => updateProfile(p => ({ ...p, enabled: !!c.event })));
  const OFF = SCENES[0].key;
  const toggled = (current, key) => (current === key ? OFF : key);
  k.handle("pick_scene", c => {
    const key = keyOf(c) ?? c.event;
    if (SCENES.some(s => s.key === key)) updateProfile(p => ({ ...p, scene: toggled(p.scene, key) }));
  });
  const setAmount = (p, key, v) => ({ ...p, amounts: { ...(p.amounts || {}), [key]: clamp01(num(v) / 100) } });
  k.handle("set_space_amount", c => updateProfile(p => (sceneOf(cat(), p.scene).mine ? p : setAmount(p, p.scene, c.event))));
  const noAxes = Object.fromEntries(AXES.map(a => [a.field, null]));
  function pickAxis(axis, key) {
    if (!axis.list.some(x => x.key === key)) return;
    updateProfile(p => ({ ...p, scene: sceneOf(cat(), p.scene).mine ? SCENES[0].key : p.scene,
                          [axis.field]: p[axis.field] === key ? null : key }));
  }
  function setAxisAmount(axis, v) {
    updateProfile(p => (pickOf(p, axis) && !sceneOf(cat(), p.scene).mine ? setAmount(p, p[axis.field], v) : p));
  }
  for (const axis of AXES) {
    k.handle(`pick_${axis.field}`, c => pickAxis(axis, keyOf(c) ?? c.event));
    k.handle(`set_${axis.field}_amount`, c => setAxisAmount(axis, c.event));
  }
  k.handle("set_band", c => {
    const i = Number(c.item && c.item.index);
    updateProfile(p => setBand(p, layerOf(cat(), p), i, c.event));
  });
  k.handle("set_tone", c => {
    const tone = TONES.find(t => t.key === keyOf(c));
    if (tone) updateProfile(p => setTone(p, tone, c.event));
  });
  k.handle("set_spatial", c => {
    const s = SPATIAL.find(x => x.value === String(c.event));
    if (s) updateProfile(p => ({ ...p, spatial: s.amount }));
  });
  k.handle("reset_scene", () => updateProfile(resetScene));
  k.handle("reset_all", () => {
    updateProfile(() => ({ ...FRESH }));
  });
  k.handle("set_auto_preamp", c => updateProfile(p => ({ ...p, auto_preamp: !!c.event, preamp: c.event ? p.preamp : preampOf(p, layerOf(cat(), p)) })));
  k.handle("set_preamp", c => updateProfile(p => ({ ...p, preamp: clamp(num(c.event), -24, 6) })));
  k.handle("save_mine", async () => {
    const { d, p, scene } = current();
    if (!d) return;
    const preset = newPreset(mine, p, scene);
    await saveMine(mine.concat([preset]));
    updateProfile(q => ({ ...q, scene: preset.key, ...noAxes }));
  });
  k.handle("pick_mine", c => { const key = c.event; if (mine.some(m => m.key === key)) updateProfile(p => ({ ...p, scene: toggled(p.scene, key), ...noAxes })); });
  k.handle("delete_mine", async c => {
    const key = c.event;
    if (!mine.some(m => m.key === key)) return;
    const moved = Object.fromEntries(Object.entries(profiles).map(([id, q]) => {
      if (q.scene !== key) return [id, q];
      const cur = gainsOf(profileOf(profiles, id), layerOf(cat(), profileOf(profiles, id)));
      const edits = { ...(q.edits || {}) }; delete edits[key];
      return [id, withEdits({ ...q, scene: SCENES[0].key, ...noAxes, edits }, cur.map((v, i) => v - SCENES[0].gains[i]))];
    }));
    profiles = moved;
    await saveMine(mine.filter(m => m.key !== key));
    clearTimeout(saveTimer); await saveProfiles();
  });
  k.handle("copy_from", c => { if (profiles[c.event]) updateProfile(() => profileOf(profiles, c.event)); });
  k.handle("setup", async () => {
    const { d } = current(), s = setup(d);
    if (!s) return;
    if (s.key === "allow") await restart();
    else if (s.key === "permission") await askAgain();
    else if (s.key === "install") await install();
    else if (s.key === "connect") await install([d.id]);
  });
  k.handle("reinstall", () => install()); // 엔진 없는 판에는 이 단추가 없다(build.py).
  k.handle("uninstall", async () => {
    busy = "uninstall"; note = ""; changed();
    try {
      const r = await request({ op: "uninstall" });
      if (r && r.elevated === "cancelled") note = "제거를 취소했어요.";
      await request({ op: "status" });
    } finally { busy = ""; changed(); }
  });
  k.handle("dismiss_note", () => { note = ""; changed(); });
  k.handle("recheck", () => restart());
  async function engineDll() {
    if (!ENGINE) throw new Error("이 판에는 사운드 엔진이 들어 있지 않아요");
    const text = new TextDecoder().decode(await k.assets.bytes(ENGINE.asset)).trim();
    const raw = await gunzip(JSON.parse(text.replace(/;$/, "")));
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map(b => b.toString(16).padStart(2, "0")).join("");
    if (hash !== ENGINE.sha256) throw new Error("엔진 파일 검증에 실패해서 설치하지 않았어요");
    let bin = "";
    for (let i = 0; i < raw.length; i += 32768) bin += String.fromCharCode(...raw.subarray(i, i + 32768));
    return btoa(bin);
  }
  async function install(endpoints) {
    busy = "install"; note = ""; changed();
    try {
      const dll_b64 = await engineDll();
      const r = await request({ op: "install", dll_b64, ...(endpoints ? { endpoints } : {}) });
      if (r && r.elevated === "cancelled") note = "설치를 취소했어요. 준비되면 다시 눌러 주세요.";
      await request({ op: "status" });
      schedule();
    } catch (e) { fail(e); }
    finally { busy = ""; changed(); }
  }
  async function restart() {
    if (handle) { const h = handle; dropBridge(); await k.process.stop({ handle: h }).catch(() => {}); }
    setBridge("starting");
    if (await ensureBridge()) await request({ op: "status" });
  }
  k.onStorageChange("profiles", onRemoteProfiles);
  k.onStorageChange("my_presets", v => { mine = Array.isArray(v) ? v : []; changed(); });
  k.onStorageChange("eq", v => { legacy = v && typeof v === "object" ? v : null; changed(); });
  k.process.onReady(h => { if (h === handle) drain(); });
  k.files.on_grant(WORK, name => { if (name && !handle) restart(); });
  publish();
  restart();
})();
