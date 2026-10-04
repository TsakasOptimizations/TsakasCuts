const $ = s => document.querySelector(s);
const FLASH = 0.25, FADE = 0.2; // keep in sync with export.js

const video = $('#video'), overlay = $('#overlay'), music = new Audio();
// Web Audio gain nodes so +dB is audible in preview (element volume caps at 1)
const actx = new AudioContext(), vGain = actx.createGain(), mGain = actx.createGain();
actx.createMediaElementSource(video).connect(vGain).connect(actx.destination);
actx.createMediaElementSource(music).connect(mGain).connect(actx.destination);

// clip: { id, path, url, name, duration, hasAudio, in, out, speed, db, transition }
// music: { path, url, name, duration, db, offset, fade }
// gameDb: master game-audio level added on top of every clip's own db
const S = { clips: [], music: null, beats: [], gameDb: 0, sel: null, t: 0, playing: false, zoom: 60 };
let cur = null, nextId = 1, projectPath = null, dirty = false;
const hist = [];

const dur = c => (c.out - c.in) / c.speed;
const total = () => S.clips.reduce((s, c) => s + dur(c), 0);
const startOf = c => { let s = 0; for (const x of S.clips) { if (x === c) break; s += dur(x); } return s; };
const gain = db => 10 ** (db / 20);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const dbText = db => db <= -60 ? 'Muted' : `${db > 0 ? '+' : ''}${db} dB`;
const selected = () => S.clips.find(c => c.id === S.sel);

// clip under timeline time t (past the end → last clip)
function at(t) {
  let s = 0;
  for (const c of S.clips) { if (t < s + dur(c)) return { c, s }; s += dur(c); }
  const c = S.clips.at(-1);
  return c && { c, s: s - dur(c) };
}

// ---------- history ----------
function snapshot() {
  dirty = true;
  hist.push(JSON.stringify({ clips: S.clips, music: S.music, beats: S.beats, gameDb: S.gameDb }));
  if (hist.length > 200) hist.shift();
}
function undo() {
  const h = hist.pop();
  if (!h) return;
  Object.assign(S, JSON.parse(h));
  render(); seek(S.t);
}

// ---------- playback ----------
function setSrc(el, url) { if (el.dataset.url !== url) { el.src = url; el.dataset.url = url; } }

function load(c, lt) {
  cur = c;
  setSrc(video, c.url);
  video.defaultPlaybackRate = video.playbackRate = c.speed;
  video.currentTime = c.in + lt * c.speed;
  if (S.playing) video.play().catch(() => {});
}

function seek(t) {
  S.t = clamp(t, 0, total());
  const hit = at(S.t);
  if (hit) load(hit.c, S.t - hit.s);
  else { cur = null; video.removeAttribute('src'); video.dataset.url = ''; video.load(); }
  if (S.music) {
    setSrc(music, S.music.url);
    music.currentTime = S.music.offset + S.t;
    if (S.playing) music.play().catch(() => {});
  }
  frame();
}

function play() {
  if (!S.clips.length) return;
  actx.resume();
  S.playing = true;
  if (S.t >= total() - 0.02) seek(0); else seek(S.t);
  $('#play').textContent = '❚❚';
  requestAnimationFrame(tick);
}
function pause() {
  S.playing = false;
  video.pause(); music.pause();
  $('#play').textContent = '▶';
}

function tick() {
  if (!S.playing) return;
  if (cur) {
    if (video.currentTime >= cur.out - 0.01 || video.ended) {
      const next = S.clips[S.clips.indexOf(cur) + 1];
      if (!next) { pause(); S.t = total(); frame(); return; }
      load(next, 0);
    } else S.t = startOf(cur) + (video.currentTime - cur.in) / cur.speed;
  }
  // video src switches stall the clock; pull the song back if it drifts
  if (S.music && !music.paused && Math.abs(music.currentTime - S.music.offset - S.t) > 0.15) music.currentTime = S.music.offset + S.t;
  frame();
  requestAnimationFrame(tick);
}

// per-frame UI: playhead, gains, transition overlay
function frame() {
  const T = total(), x = S.t * S.zoom, sc = $('#scroll');
  $('#playhead').style.left = x + 'px';
  $('#time').textContent = `${fmt(S.t)} / ${fmt(T)}`;
  if (S.playing && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40)) sc.scrollLeft = x - 40;

  vGain.gain.value = cur && cur.hasAudio ? gain(cur.db + S.gameDb) : 0;
  if (S.music) mGain.gain.value = gain(S.music.db) * (S.music.fade ? clamp(Math.min(S.t / 1, (T - S.t) / 2), 0, 1) : 1);

  let o = 0, color = '#fff';
  if (cur) {
    const lt = S.t - startOf(cur), d = dur(cur), next = S.clips[S.clips.indexOf(cur) + 1];
    if (cur.transition === 'flash' && lt < FLASH) o = 1 - lt / FLASH;
    if (cur.transition === 'fade' && lt < FADE) { o = 1 - lt / FADE; color = '#000'; }
    if (next?.transition === 'fade' && d - lt < FADE) { o = 1 - (d - lt) / FADE; color = '#000'; }
  }
  overlay.style.opacity = o;
  overlay.style.background = color;
}

// ---------- editing ----------
function addClips(files) {
  if (!files.length) return;
  snapshot();
  for (const f of files) S.clips.push({ ...f, id: nextId++, in: 0, out: f.duration, speed: 1, db: 0, transition: 'none' });
  render(); seek(S.t);
}
function setMusic([f]) {
  if (!f) return;
  snapshot();
  S.music = { ...f, db: 0, offset: 0, fade: true };
  render(); seek(S.t);
}

// CapCut-style: left = delete before playhead, right = delete after, mid = cut in two
function split(mode) {
  const hit = at(S.t);
  if (!hit) return;
  const { c, s } = hit, src = c.in + (S.t - s) * c.speed;
  if (src - c.in < 0.05 || c.out - src < 0.05) return;
  snapshot();
  if (mode === 'mid') {
    const b = { ...c, id: nextId++, in: src, transition: 'none' };
    c.out = src;
    S.clips.splice(S.clips.indexOf(c) + 1, 0, b);
    S.sel = b.id;
  } else if (mode === 'left') { c.in = src; S.t = s; }
  else c.out = src;
  S.sel ??= c.id;
  render(); seek(S.t);
}

function del() {
  const c = selected();
  if (!c) return;
  snapshot();
  S.clips.splice(S.clips.indexOf(c), 1);
  S.sel = null;
  render(); seek(S.t);
}

function editSel(fn) {
  const c = selected();
  if (!c) return;
  snapshot(); fn(c);
  render(); seek(S.t);
}

// drag a clip edge: left trims the start, right trims the end; preview shows the edge frame
function trim(e, c, left) {
  e.preventDefault(); // no native drag-to-reorder
  const x0 = e.clientX, in0 = c.in, out0 = c.out;
  S.sel = c.id;
  snapshot();
  const move = ev => {
    const d = (ev.clientX - x0) / S.zoom * c.speed;
    if (left) c.in = clamp(in0 + d, 0, c.out - 0.1);
    else c.out = clamp(out0 + d, c.in + 0.1, c.duration);
    render();
    seek(left ? startOf(c) : startOf(c) + dur(c) - 0.001);
  };
  move(e);
  addEventListener('mousemove', move);
  addEventListener('mouseup', () => removeEventListener('mousemove', move), { once: true });
}

// zoom the timeline keeping the time under screen x fixed
function zoomAt(z, clientX) {
  const sc = $('#scroll'), px = clientX - sc.getBoundingClientRect().left;
  const t = (sc.scrollLeft + px) / S.zoom;
  S.zoom = clamp(z, 5, 600);
  $('#zoom').value = S.zoom;
  render();
  sc.scrollLeft = t * S.zoom - px;
}
const playheadX = () => $('#scroll').getBoundingClientRect().left + S.t * S.zoom - $('#scroll').scrollLeft;

function markBeat() {
  // while playing, the song is what you hear, so time the tap against it
  const t = S.music && S.playing ? music.currentTime - S.music.offset : S.t;
  snapshot();
  S.beats.push(t);
  S.beats.sort((a, b) => a - b);
  render();
}

// end every clip on the beat nearest to its current end
function snapToBeats() {
  if (!S.beats.length || !S.clips.length) return;
  snapshot();
  let s = 0;
  for (const c of S.clips) {
    const end = s + dur(c);
    const b = S.beats.reduce((best, x) => x > s + 0.1 && Math.abs(x - end) < Math.abs(best - end) ? x : best, Infinity);
    if (b !== Infinity) c.out = Math.min(c.duration, c.in + (b - s) * c.speed);
    s += dur(c);
  }
  render(); seek(S.t);
}

// ---------- project ----------
const settings = ['format', 'res', 'fps'];
async function saveProject(saveAs) {
  const data = { clips: S.clips, music: S.music, beats: S.beats, gameDb: S.gameDb, nextId };
  for (const k of settings) data[k] = $('#' + k).value;
  const p = await api.saveProject(saveAs ? null : projectPath, JSON.stringify(data));
  if (!p) return;
  projectPath = p; dirty = false;
  document.title = 'TsakasCuts — ' + p.split(/[\\/]/).pop();
  $('#status').textContent = 'Saved ✓';
}
async function openProject() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  const r = await api.openProject();
  if (!r) return;
  const d = JSON.parse(r.data);
  pause();
  Object.assign(S, { clips: d.clips, music: d.music, beats: d.beats, gameDb: d.gameDb ?? 0, sel: null, t: 0 });
  nextId = d.nextId;
  for (const k of settings) $('#' + k).value = d[k];
  hist.length = 0;
  projectPath = r.path; dirty = false;
  document.title = 'TsakasCuts — ' + r.path.split(/[\\/]/).pop();
  render(); seek(0);
}
// non-empty return value makes main.js ask before closing
onbeforeunload = e => { if (dirty) e.returnValue = 'unsaved'; };

// ---------- thumbnails ----------
const thumbs = {}; // path → { img, n }
function thumb(c) {
  let t = thumbs[c.path];
  if (!t) {
    t = thumbs[c.path] = { img: new Image(), n: 0 };
    api.thumbs(c.path, c.duration).then(r => { t.n = r.n; t.img.onload = render; t.img.src = r.url; }).catch(() => {});
  }
  return t.n && t.img.naturalWidth ? t : null;
}
// paint the frames that belong to this clip's trimmed/sped-up range, unstretched
function filmstrip(c) {
  const canvas = document.createElement('canvas'), t = thumb(c);
  if (!t) return canvas;
  const fw = t.img.naturalWidth / t.n, fh = t.img.naturalHeight, w = Math.max(1, Math.round(dur(c) * S.zoom));
  canvas.width = w; canvas.height = fh;
  const ctx = canvas.getContext('2d');
  for (let x = 0; x < w; x += fw) {
    const i = Math.min(t.n - 1, Math.floor((c.in + x / S.zoom * c.speed) / c.duration * t.n));
    ctx.drawImage(t.img, i * fw, 0, fw, fh, x, 0, fw, fh);
  }
  return canvas;
}

// ---------- render ----------
function block(cls, left, width, title, sub) {
  const el = document.createElement('div');
  el.className = cls;
  el.style.left = left + 'px';
  el.style.width = width + 'px';
  el.append(Object.assign(document.createElement('b'), { textContent: title }),
            Object.assign(document.createElement('small'), { textContent: sub }));
  return el;
}

function render() {
  const z = S.zoom, m = S.music;
  $('#tl').style.width = (Math.max(total(), m ? m.duration - m.offset : 0) * z + 300) + 'px';
  $('#tl').style.setProperty('--z', z + 'px');

  let s = 0;
  $('#vtrack').replaceChildren(...S.clips.map(c => {
    const icon = { flash: '⚡ ', fade: '◐ ' }[c.transition] || '';
    const el = block('clip' + (c.id === S.sel ? ' sel' : ''), s * z, dur(c) * z, icon + c.name, `${dbText(c.db)} · ${c.speed}x`);
    el.prepend(filmstrip(c));
    el.append(Object.assign(document.createElement('i'), { className: 'h l', title: 'Drag to trim start' }),
              Object.assign(document.createElement('i'), { className: 'h r', title: 'Drag to trim end' }));
    el.draggable = true;
    el.dataset.id = c.id;
    s += dur(c);
    return el;
  }));
  $('#mtrack').replaceChildren(...(m ? [block('mus', 0, (m.duration - m.offset) * z, '♪ ' + m.name, dbText(m.db))] : []));
  $('#beats').replaceChildren(...S.beats.map(b => Object.assign(document.createElement('i'), { className: 'beat', style: `left:${b * z}px` })));

  const c = selected();
  $('#clipBox').disabled = !c;
  $('#clipName').textContent = c ? c.name : 'Click a clip on the timeline';
  $('#clipVol').value = c ? c.db : 0;
  $('#clipDb').textContent = c ? dbText(c.db) : '–';
  $('#gameVol').value = S.gameDb;
  $('#gameDb').textContent = dbText(S.gameDb);
  $('#speed').value = c ? c.speed : 1;
  $('#trans').value = c ? c.transition : 'none';

  $('#musicBox').disabled = !m;
  $('#musicName').textContent = m ? m.name : 'No music yet';
  $('#musicVol').value = m ? m.db : 0;
  $('#musicDb').textContent = m ? dbText(m.db) : '–';
  $('#offset').value = m ? m.offset : 0;
  $('#mfade').checked = m ? m.fade : true;
  $('#beatCount').textContent = `${S.beats.length} beats`;
  $('#stage').classList.toggle('tiktok', $('#format').value === 'tiktok');
  frame();
}

// ---------- events ----------
$('#importClips').onclick = async () => addClips(await api.open('video'));
$('#addMusic').onclick = async () => setMusic(await api.open('music'));
$('#saveProject').onclick = () => saveProject(false);
$('#openProject').onclick = openProject;
$('#play').onclick =() => S.playing ? pause() : play();
$('#split').onclick = () => split('mid');
$('#splitLeft').onclick = () => split('left');
$('#splitRight').onclick = () => split('right');
$('#del').onclick = del;
$('#undo').onclick = undo;
$('#snap').onclick = snapToBeats;
$('#clearBeats').onclick = () => { snapshot(); S.beats = []; render(); };
$('#mute').onclick = () => editSel(c => c.db = c.db <= -60 ? 0 : -60);
$('#speed').onchange = e => editSel(c => c.speed = +e.target.value);
$('#trans').onchange = e => editSel(c => c.transition = e.target.value);
$('#offset').onchange = e => { snapshot(); S.music.offset = Math.max(0, +e.target.value || 0); render(); seek(S.t); };
$('#mfade').onchange = e => { snapshot(); S.music.fade = e.target.checked; render(); };
$('#format').onchange = render;
$('#zoom').oninput = e => zoomAt(+e.target.value, playheadX());
$('#clipVol').oninput = e => { selected().db = +e.target.value; render(); };
$('#gameVol').oninput = e => { S.gameDb = +e.target.value; render(); };
$('#musicVol').oninput = e => { S.music.db = +e.target.value; render(); };
// one undo step per slider drag; blur after so Space goes back to play/pause
for (const id of ['#clipVol', '#gameVol', '#musicVol', '#zoom']) {
  if (id !== '#zoom') $(id).addEventListener('pointerdown', snapshot);
  $(id).addEventListener('change', e => e.target.blur());
}
// focus the window itself, not the ✕ button, so Space doesn't close it
$('#keysBtn').onclick = () => { $('#keys').showModal(); $('#keys').focus(); };
$('#keysClose').onclick = () => $('#keys').close();
$('#keys').onclick = e => { if (e.target === $('#keys')) $('#keys').close(); }; // click outside

// keep buttons from taking focus, so Space always means play/pause
addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });

// click timeline to seek + select; drag on the ruler to scrub
$('#scroll').addEventListener('mousedown', e => {
  if (e.button) return;
  const h = e.target.closest('.h');
  if (h) return trim(e, S.clips.find(c => c.id === +h.parentElement.dataset.id), h.classList.contains('l'));
  const toTime = ev => (ev.clientX - $('#tl').getBoundingClientRect().left) / S.zoom;
  const clip = e.target.closest('.clip');
  if (clip) S.sel = +clip.dataset.id;
  render(); seek(toTime(e));
  if (e.target.id !== 'ruler') return;
  const move = ev => seek(toTime(ev));
  addEventListener('mousemove', move);
  addEventListener('mouseup', () => removeEventListener('mousemove', move), { once: true });
});

// Ctrl+wheel zooms at the mouse, plain wheel scrolls sideways
$('#scroll').addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) zoomAt(S.zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX);
  else $('#scroll').scrollLeft += e.deltaY || e.deltaX;
}, { passive: false });

// drag clips to reorder (drop on right half = after)
$('#vtrack').addEventListener('dragstart', e => e.dataTransfer.setData('clip', e.target.dataset.id));
$('#vtrack').addEventListener('dragover', e => e.preventDefault());
$('#vtrack').addEventListener('drop', e => {
  const id = +e.dataTransfer.getData('clip'), target = e.target.closest('.clip');
  if (!id) return;
  e.preventDefault(); e.stopPropagation();
  if (!target || +target.dataset.id === id) return;
  snapshot();
  const [c] = S.clips.splice(S.clips.findIndex(x => x.id === id), 1);
  const r = target.getBoundingClientRect();
  const to = S.clips.findIndex(x => x.id === +target.dataset.id) + (e.clientX > r.left + r.width / 2);
  S.clips.splice(to, 0, c);
  render(); seek(S.t);
});

// drop files from Explorer: videos → timeline, audio → music
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  const probed = await api.probe(files);
  const audio = probed.filter(f => /\.(mp3|wav|m4a|ogg)$/i.test(f.path));
  addClips(probed.filter(f => !audio.includes(f)));
  setMusic(audio);
});

addEventListener('keydown', e => {
  if (e.target.matches('input, select') || $('#keys').open) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'z') return undo();
  if (e.ctrlKey && k === 's') return saveProject(e.shiftKey);
  if (e.ctrlKey && k === 'o') return openProject();
  if (k === ' ') { e.preventDefault(); S.playing ? pause() : play(); }
  else if (k === 's') split('mid');
  else if (k === 'q') split('left');
  else if (k === 'w') split('right');
  else if (k === 'b') markBeat();
  else if (k === 'delete' || k === 'backspace') del();
  else if (k === 'arrowleft') seek(S.t - 1 / 60);
  else if (k === 'arrowright') seek(S.t + 1 / 60);
  else if (k === '=' || k === '+') zoomAt(S.zoom * 1.25, playheadX());
  else if (k === '-') zoomAt(S.zoom * 0.8, playheadX());
});

// ---------- export ----------
api.version().then(v => { $('#version').textContent = 'v' + v; });
$('#updates').onclick = async () => {
  encoder = 'Update';
  $('#prog').hidden = false; $('#prog').value = 0;
  await api.checkUpdates().catch(err => alert(err.message));
  $('#prog').hidden = true; $('#status').textContent = '';
};

let encoder = '';
api.onEncoder(e => { encoder = e; });
api.onProgress(p => { $('#prog').value = p; $('#status').textContent = `${encoder} ${Math.round(p * 100)}%`; });
$('#export').onclick = async () => {
  if (!S.clips.length) return alert('Import some clips first.');
  pause();
  $('#export').disabled = true;
  $('#prog').hidden = false; $('#prog').value = 0;
  try {
    const out = await api.export({ clips: S.clips, music: S.music, gameDb: S.gameDb, format: $('#format').value, res: $('#res').value, fps: +$('#fps').value });
    $('#status').textContent = out ? 'Exported ✓' : '';
  } catch (err) {
    $('#status').textContent = 'Export failed';
    alert('Export failed:\n\n' + err.message.slice(-1500));
  }
  $('#export').disabled = false;
  $('#prog').hidden = true;
};

render();
