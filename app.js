/* Markup — circle-and-annotate editing for Qwen-Image 2.1.
 *
 * Everything here that looks like a design decision came out of testing the model. The two that
 * matter most:
 *
 *   The noun sets the extent, the mark sets the location.  Circling part of a jacket and saying
 *   "replace the jacket" replaces the whole garment. Circling the same place and saying "turn
 *   this area black" paints a black patch inside the loop and nothing else. So a region has a
 *   MODE, the mode changes the sentence that gets written, and the UI says which is which
 *   instead of letting people discover it by accident.
 *
 *   A mark is a reference without a description.  Describing a thing in order to change it makes
 *   the model partly redraw it, which is why a described scuff came back half-erased and a
 *   circled one came back gone. So the assembled prompt names the target as little as it can get
 *   away with, and leans on one blanket preservation clause rather than walking the frame.
 *
 * Generations are kept rather than replaced. An edit is expensive — 45 s at 1 MP, eight minutes
 * at 2K — so throwing the last one away to show the next is the wrong trade. Each becomes a tile
 * in the filmstrip and can be reopened, and none of it touches the marks, so going back to the
 * edit costs nothing.
 */

const MARK_COLORS = [
  { name: 'red',     css: '#ff3b47' },
  { name: 'green',   css: '#22d861' },
  { name: 'blue',    css: '#3b82f6' },
  { name: 'magenta', css: '#f23ccd' },
  { name: 'yellow',  css: '#ffd028' },
  { name: 'cyan',    css: '#22d3ee' },
];

const state = {
  img: null,          // HTMLImageElement of the clean plate
  regions: [],        // { id, color, points:[[x,y],...] } — a mark is just a coloured shape now
  prompt: '',
  selected: null,
  tool: 'free',
  drawing: null,
  models: null,
  nextId: 1,
  gens: [],           // { id, status, progress, url, before, prompt, seed, steps, elapsed }
  activeGen: null,
  view: 'edit',       // 'edit' | 'result'
  cmpMode: 'result',  // 'result' | 'split' | 'before'
};

const $ = (id) => document.getElementById(id);
const base = $('base'), marks = $('marks'), badges = $('badges');
const bctx = base.getContext('2d'), mctx = marks.getContext('2d');
const gctx = badges.getContext('2d');

/* ------------------------------------------------------------------ prompt assembly */

/* The prompt is written whole by the person and sent exactly as typed.
 *
 * It used to be assembled: each mark carried its own instruction and a mode, and the app
 * stitched the fragments into a sentence. Every version of that stitching read badly — a trailing
 * ", the one marked by the red outline" on each clause, or a preservation clause bolted on the
 * end — and the seams were doing real damage, because the grammar of the sentence turns out to
 * change what the model edits.
 *
 * Qwen's own multi-region example is one natural sentence:
 *
 *   "Remove the metal watch in the blue circle, change the hair in the red circle to black, and
 *    replace the area in the green circle with gray short-sleeved linen pajamas."
 *
 * A person writes that in one go. No template produces it from three separate boxes without
 * guessing at verbs and word order. So the marks supply the colours, and the sentence is the
 * person's. Nothing is added to it on the way out.
 */
function buildPrompt() {
  return (state.prompt || '').trim();
}

const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const NO_CIRCLES = 'Do not render the circles in the output.';

/* ------------------------------------------------------------------ canvas */

function fitStage() {
  if (!state.img) return;
  const stage = $('stage');
  const pad = 70;
  const sw = stage.clientWidth - pad, sh = stage.clientHeight - pad;
  const scale = Math.min(sw / state.img.width, sh / state.img.height, 1);
  const w = Math.round(state.img.width * scale), h = Math.round(state.img.height * scale);
  for (const c of [base, marks, badges]) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
}

function loadImage(src, keep) {
  const img = new Image();
  img.onload = () => {
    state.img = img;
    if (!keep) { state.regions = []; state.selected = null; }
    base.width = marks.width = badges.width = img.width;
    base.height = marks.height = badges.height = img.height;
    bctx.drawImage(img, 0, 0);
    $('empty').classList.add('hide');
    fitStage();
    redraw();
    if (keep && typeof keep === 'function') keep();
  };
  img.onerror = () => setStatus('could not read that image', true);
  img.src = src;
}

/* The clean plate as a data URL. A session stores this rather than the flattened image, so the
 * marks stay editable when it is reopened — flattening is a one-way step and a saved session
 * that could only be looked at would not be worth saving. */
function plateDataUrl() {
  const out = document.createElement('canvas');
  out.width = base.width; out.height = base.height;
  out.getContext('2d').drawImage(base, 0, 0);
  return out.toDataURL('image/png');
}

/* Stroke weight is scaled to the image so a mark on a 2K frame is as visible to the model as the
 * same mark on a 1 MP one. Thin marks were not tested and thick ones demonstrably work. */
function strokeWidth() {
  return Math.max(3, Math.round(Math.max(base.width, base.height) / 190));
}

function drawPath(ctx, r, closing) {
  ctx.strokeStyle = r.color.css;
  ctx.lineWidth = strokeWidth();
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.beginPath();
  if (r.points.length === 2 && r.ellipse) {
    const [[x0, y0], [x1, y1]] = r.points;
    ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2,
      Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
  } else {
    r.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (closing !== false) ctx.closePath();
  }
  ctx.stroke();
}

/* The top-right extremity of a region, used to hang its badge off the shape. */
function anchor(r) {
  if (r.ellipse && r.points.length === 2) {
    const [[x0, y0], [x1, y1]] = r.points;
    return [Math.max(x0, x1), Math.min(y0, y1)];
  }
  let maxX = -Infinity, minY = Infinity;
  for (const [x, y] of r.points) { maxX = Math.max(maxX, x); minY = Math.min(minY, y); }
  return [maxX, minY];
}

/* Badges live on their own canvas and are never composited into what gets sent. A numeral drawn
 * beside a mark would otherwise be one more thing in the picture for the model to interpret. */
function drawBadges() {
  gctx.clearRect(0, 0, badges.width, badges.height);
  const rad = Math.max(12, Math.round(Math.max(badges.width, badges.height) / 58));
  state.regions.forEach((r, i) => {
    const [ax, ay] = anchor(r);
    const cx = ax + rad * 0.2, cy = ay - rad * 0.2;
    gctx.beginPath();
    gctx.arc(cx, cy, rad, 0, Math.PI * 2);
    gctx.fillStyle = r.color.css;
    gctx.fill();
    if (state.selected === r.id) {
      gctx.lineWidth = Math.max(2, rad / 6);
      gctx.strokeStyle = '#ffffff';
      gctx.stroke();
    }
    gctx.fillStyle = '#ffffff';
    gctx.font = `700 ${Math.round(rad * 1.25)}px "Oswald", system-ui, sans-serif`;
    gctx.textAlign = 'center';
    gctx.textBaseline = 'middle';
    gctx.fillText(String(i + 1), cx, cy + rad * 0.04);
  });
}

/* Canvas only. Dragging fires pointermove at screen rate, and rebuilding the region list on
 * every one of those was wrong twice over: it threw away and recreated the DOM sixty times a
 * second, and because each card starts its popin animation from opacity 0, restarting that
 * animation every frame left the whole list invisible for as long as the drag lasted. The panel
 * showed "Regions 1" above an empty box. */
function redrawCanvas() {
  mctx.clearRect(0, 0, marks.width, marks.height);
  for (const r of state.regions) drawPath(mctx, r);
  if (state.drawing) drawPath(mctx, state.drawing, false);
  drawBadges();
}

/* Canvas plus panel. For the moments when the set of regions actually changed. */
function redraw() {
  redrawCanvas();
  renderRegions();
  refreshPreview();
}

/* The flattened image is what the model sees: clean plate plus marks, one layer, no alpha. */
function flatten() {
  const out = document.createElement('canvas');
  out.width = base.width; out.height = base.height;
  const c = out.getContext('2d');
  c.drawImage(base, 0, 0);
  c.drawImage(marks, 0, 0);
  return out.toDataURL('image/png');
}

/* ------------------------------------------------------------------ pointer */

function toImageXY(ev) {
  const b = badges.getBoundingClientRect();
  return [
    (ev.clientX - b.left) * (badges.width / b.width),
    (ev.clientY - b.top) * (badges.height / b.height),
  ];
}

badges.addEventListener('pointerdown', (ev) => {
  if (!state.img) return;
  badges.setPointerCapture(ev.pointerId);
  const color = MARK_COLORS[state.regions.length % MARK_COLORS.length];
  state.drawing = {
    id: state.nextId, color,
    points: [toImageXY(ev)], ellipse: state.tool === 'ellipse',
  };
  redrawCanvas();
});

badges.addEventListener('pointermove', (ev) => {
  if (!state.drawing) return;
  const p = toImageXY(ev);
  if (state.drawing.ellipse) state.drawing.points[1] = p;
  else state.drawing.points.push(p);
  redrawCanvas();
});

function endStroke() {
  const d = state.drawing;
  state.drawing = null;
  if (!d) return;
  const enough = d.ellipse ? d.points.length === 2 : d.points.length > 6;
  if (!enough) { redrawCanvas(); return; }
  if (d.ellipse) {
    const [[x0, y0], [x1, y1]] = d.points;
    if (Math.abs(x1 - x0) < 8 || Math.abs(y1 - y0) < 8) { redrawCanvas(); return; }
  }
  state.nextId += 1;
  state.regions.push(d);
  state.selected = d.id;
  showTab('edit');
  redraw();
}

badges.addEventListener('pointerup', endStroke);
badges.addEventListener('pointercancel', endStroke);

/* ------------------------------------------------------------------ region list */

/* Write it the way Qwen's own examples do: a verb, the thing, then the change —
 * "change the leaf to a deep autumn red". Markup inserts "in the <colour> circle" after the
 * thing. Check the Prompt tab before generating; the finished sentence is shown there. */
function renderRegions() {
  const host = $('markList');
  host.innerHTML = '';
  state.regions.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'chip';
    el.innerHTML = `<span class="swatch" style="background:${r.color.css};color:${r.color.css}">`
      + `</span><span>${i + 1} &middot; ${r.color.name}</span>`
      + '<button class="del" title="Remove">&times;</button>';
    el.querySelector('.del').addEventListener('click', () => {
      state.regions = state.regions.filter((x) => x !== r);
      redraw();
    });
    host.appendChild(el);
  });
}

/* Typing must not rebuild the list under the caret, so the text path updates only the preview. */
function refreshPreview() {
  const prompt = buildPrompt();
  const busy = state.gens.some((g) => g.status === 'running');
  /* Marks are not required — a plain prompt with no marks at all is a valid edit, and refusing
   * to run one would be the app inventing a rule the model does not have. */
  $('go').disabled = !(state.img && prompt && state.models && !busy);
  $('saveSession').disabled = !state.img;
  $('exportMarked').disabled = !state.img;
  $('copyPrompt').disabled = !prompt;
  $('markCount').textContent = state.regions.length ? state.regions.length : '';
}

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab').forEach((s) => {
    s.classList.toggle('on', s.dataset.tab === name);
  });
}

document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    showTab(b.dataset.tab);
    // The Result tab and the result view are the same idea, so picking one picks the other.
    if (b.dataset.tab === 'result') {
      if (state.activeGen) showView('result');
    } else if (state.view === 'result') {
      showView('edit');
    }
  });
});

/* ------------------------------------------------------------------ views */

function showView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('on', v.dataset.view === view);
  });
  if (view === 'edit') {
    state.activeGen = null;
    const cur = document.querySelector('#tabs button.on');
    if (cur && cur.dataset.tab === 'result') showTab('edit');
  }
  $('tabResult').hidden = !state.gens.length;
  renderStrip();
}

function setCmpMode(mode) {
  state.cmpMode = mode;
  const h = $('holder');
  h.classList.toggle('split', mode === 'split');
  h.classList.toggle('before', mode === 'before');
  for (const [id, m] of [['vResult', 'result'], ['vSplit', 'split'], ['vBefore', 'before']]) {
    $(id).classList.toggle('on', m === mode);
  }
}

function openGen(id) {
  const g = state.gens.find((x) => x.id === id);
  if (!g) return;
  state.activeGen = id;
  $('tabResult').hidden = false;
  $('genPrompt').textContent = g.prompt;

  if (g.status === 'done') {
    $('cmpAfter').src = g.url;
    $('cmpBefore').src = g.before;
    setCmpMode(state.cmpMode);
    $('genMeta').innerHTML = [
      ['seed', g.seed], ['steps', g.steps],
      ['size', g.size || '—'], ['took', g.elapsed ? g.elapsed + ' s' : '—'],
    ].map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
  } else {
    // Nothing to show yet, so the marked plate sits under the dial rather than a blank stage.
    $('cmpAfter').src = g.before;
    $('cmpBefore').src = g.before;
    setCmpMode('result');
    $('genMeta').innerHTML = `<b>state</b><span>${g.status === 'error' ? 'failed' : 'generating…'}`
      + '</span>';
  }
  showTab('result');
  showView('result');
}

/* ------------------------------------------------------------------ filmstrip */

function renderStrip() {
  const strip = $('strip');
  strip.classList.toggle('on', state.gens.length > 0);
  strip.innerHTML = '';

  state.gens.forEach((g, i) => {
    const el = document.createElement('div');
    el.className = 'shot'
      + (g.status === 'running' ? ' busy' : '')
      + (g.status === 'error' ? ' failed' : '')
      + (state.activeGen === g.id && state.view === 'result' ? ' sel' : '');
    const img = g.url || g.before;
    // No percentage on the tile — the dial carries that. The tile only says which one is working.
    el.innerHTML = `
      ${img ? `<img src="${img}" alt="">` : ''}
      ${g.status === 'error' ? '<div class="veil">failed</div>' : ''}
      <div class="cap"><span>${String(i + 1).padStart(2, '0')}</span>
        <span class="t">${g.status === 'done' ? g.elapsed + 's' : g.status}</span></div>`;
    el.addEventListener('click', () => openGen(g.id));
    strip.appendChild(el);
  });
}

/* ------------------------------------------------------------------ progress */

const DIAL_CIRC = 364;

function setBusy(on, pct, label) {
  $('busy').classList.toggle('on', on);
  const known = typeof pct === 'number' && pct > 0;
  $('dial').classList.toggle('waiting', !known);
  if (known) {
    $('dialBar').setAttribute('stroke-dasharray', DIAL_CIRC);
    $('dialBar').setAttribute('stroke-dashoffset', DIAL_CIRC * (1 - pct / 100));
    $('dialPct').textContent = Math.round(pct) + '%';
  } else {
    /* Emptying the ring here is what stops a new generation flashing full. The indeterminate
     * sweep is a CSS animation, and an animation does not take effect until the next frame — so
     * a ring still carrying the last run's finished value (dashoffset 0, a complete circle)
     * painted one frame at 100% before the sweep took over. Resetting the attributes makes the
     * starting state empty instead of inherited. */
    $('dialBar').setAttribute('stroke-dasharray', DIAL_CIRC);
    $('dialBar').setAttribute('stroke-dashoffset', DIAL_CIRC);
    $('dialPct').textContent = '—';
  }
  if (label) $('busyLabel').textContent = label;
}

/* ------------------------------------------------------------------ generate */

/* Errors are set as text, never markup: they carry ComfyUI's own messages, filenames and
 * addresses, none of which this page wrote. Only the app's own progress lines use markup. */
function setStatus(msg, isErr) {
  const s = $('status');
  s.className = isErr ? 'err' : '';
  if (isErr) s.textContent = msg;
  else s.innerHTML = msg;
}

async function generate() {
  const prompt = buildPrompt();
  if (!prompt) return;

  const gen = {
    id: 'g' + Date.now(),
    status: 'running',
    progress: 0,
    before: flatten(),
    prompt,
    seed: Number($('seed').value) || 0,
    steps: Number($('steps').value) || 25,
    resolution: Number($('resolution').value) || 0,
    size: `${base.width}x${base.height}`,
  };
  state.gens.push(gen);
  refreshPreview();

  // The UI moves to the new generation the moment it starts, so the progress appears where the
  // result will be rather than somewhere else on screen.
  openGen(gen.id);
  setBusy(true, 0, 'uploading…');

  const started = Date.now();
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: gen.before, prompt, seed: gen.seed, steps: gen.steps,
        resolution: gen.resolution, models: state.models,
      }),
    });
    const { id, error } = await res.json();
    if (error) throw new Error(error);

    let job;
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      job = await (await fetch('/api/status?id=' + id)).json();

      if (job.status === 'running') {
        gen.progress = job.progress || 0;
        const secs = Math.round((Date.now() - started) / 1000);
        if (job.queued) {
          setBusy(true, 0, `queued behind another job… · ${secs}s`);
        } else if (job.phase === 'decoding') {
          setBusy(true, gen.progress, `decoding and saving… · ${secs}s`);
        } else if (job.phase === 'sampling' && job.max_step) {
          setBusy(true, gen.progress, `step ${job.step} of ${job.max_step} · ${secs}s`);
        } else {
          // No step count yet: loading weights and encoding the plate. On a 2K edit this is
          // minutes, so it gets an honest label and an indeterminate dial rather than a number.
          setBusy(true, 0, `loading the model and encoding the image… · ${secs}s`);
        }
        setStatus(`generating&hellip; <span class="t">${secs}s</span>`);
      }
      if (job.status === 'done' || job.status === 'error') break;
    }

    if (job.status === 'error') throw new Error(job.error);

    gen.status = 'done';
    gen.url = job.image;
    gen.elapsed = job.elapsed;
    gen.progress = 100;
    setBusy(false);
    $('useResult').disabled = false;
    setStatus(`done in <span class="t">${job.elapsed}s</span>`);
    if (state.activeGen === gen.id) openGen(gen.id); else renderStrip();
  } catch (e) {
    gen.status = 'error';
    gen.error = String(e.message || e);
    setBusy(false);
    setStatus(gen.error, true);
    showView('edit');
  } finally {
    refreshPreview();
  }
}

/* ------------------------------------------------------------------ compare */

function setWipe(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  $('holder').style.setProperty('--wipe', clamped + '%');
  $('slider').value = clamped;
}

$('slider').addEventListener('input', () => setWipe(Number($('slider').value)));
$('vResult').addEventListener('click', () => setCmpMode('result'));
$('vSplit').addEventListener('click', () => setCmpMode('split'));
$('vBefore').addEventListener('click', () => setCmpMode('before'));

$('genBack').addEventListener('click', () => showView('edit'));
$('genEdit').addEventListener('click', () => {
  const g = state.gens.find((x) => x.id === state.activeGen);
  if (!g || !g.url) return;
  showView('edit');
  loadImage(g.url);
});
$('genDownload').addEventListener('click', () => {
  const g = state.gens.find((x) => x.id === state.activeGen);
  if (!g || !g.url) return;
  download('markup-result-' + stamp() + '.png', g.url);
});

/* ------------------------------------------------------------------ session */

/* A session is the clean plate, the marks, and the settings — everything needed to reopen a
 * piece of work, not a record of a result. Marks are stored by colour *name* and re-matched to
 * the palette on load, so a session written by an older build cannot carry a dead hex value into
 * a prompt that names the colour out loud. */
const SESSION_VERSION = 1;

function download(name, href) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function saveSession() {
  if (!state.img) return;
  const doc = {
    format: 'markup-session',
    version: SESSION_VERSION,
    saved: new Date().toISOString(),
    image: plateDataUrl(),
    width: base.width,
    height: base.height,
    regions: state.regions.map((r) => ({
      color: r.color.name, ellipse: !!r.ellipse, points: r.points,
    })),
    settings: {
      seed: Number($('seed').value) || 0,
      steps: Number($('steps').value) || 25,
      resolution: Number($('resolution').value) || 0,
    },
    prompt: buildPrompt(),
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  download('markup-' + stamp() + '.json', url);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setStatus('session saved');
}

function applySession(doc) {
  if (!doc || doc.format !== 'markup-session') throw new Error('not a Markup session file');
  if (doc.version > SESSION_VERSION) {
    throw new Error('session is version ' + doc.version + ', this build reads ' + SESSION_VERSION);
  }
  if (!doc.image) throw new Error('session has no image in it');

  const regions = (doc.regions || []).map((r, i) => ({
    id: i + 1,
    color: MARK_COLORS.find((c) => c.name === r.color) || MARK_COLORS[i % MARK_COLORS.length],
    ellipse: !!r.ellipse,
    points: Array.isArray(r.points) ? r.points : [],
  })).filter((r) => r.points.length >= (r.ellipse ? 2 : 3));

  const s = doc.settings || {};
  if (s.seed !== undefined) $('seed').value = s.seed;
  if (s.steps !== undefined) $('steps').value = s.steps;
  if (s.resolution !== undefined) $('resolution').value = s.resolution;

  /* The image loads first and the marks go back in its callback, because the canvases are
   * resized to fit the image and anything drawn before that resize is wiped by it. */
  showView('edit');
  loadImage(doc.image, () => {
    state.regions = regions;
    state.nextId = regions.length + 1;
    state.selected = null;
    state.prompt = typeof doc.prompt === 'string' ? doc.prompt : '';
    $('promptBox').value = state.prompt;
    redraw();
    setStatus('loaded ' + regions.length + (regions.length === 1 ? ' mark' : ' marks'));
  });
}

/* ------------------------------------------------------------------ comfy address */

async function connectTo(addr, quiet) {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comfy: addr }),
  });
  const body = await res.json();
  if (!res.ok) {
    /* The server keeps the previous address when a new one does not answer, so the field is put
     * back to what is actually in use rather than left showing an address that was refused. */
    if (body.comfy) $('comfyAddr').value = body.comfy;
    throw new Error(body.error || 'could not connect');
  }
  $('comfyAddr').value = body.comfy;
  try { localStorage.setItem('markup.comfy', body.comfy); } catch (e) { /* private mode */ }
  await loadModels();
  if (!quiet) setStatus('connected to ' + body.comfy);
}

/* Preference order, most wanted first. This used to be a single `includes()` substring match,
 * which picked whichever filename happened to sort first — and with both quantisations on disk
 * that was `qwen_image_2.1_int4_convrot`, not the int8 build every measurement in this project
 * used. The app had been quietly running a different model than the numbers beside it. Order is
 * explicit now so adding a file to the models directory cannot change what gets loaded. */
const MODEL_PREFS = {
  unet: ['qwen_image_2.1_int8_convrot', 'qwen_image_2.1_int4_convrot', 'qwen_image_2.1'],
  clip: ['qwen3vl_8b_int8_convrot', 'qwen3vl_8b_w4a8', 'qwen3vl_8b'],
  vae: ['qwen_image_2.1_vae'],
};

/* No match is null, not the first file in the folder. Falling back to whatever UNet happened to
 * be installed would send a Qwen-Image 2.1 graph to some other model and fail somewhere deep in
 * ComfyUI with an error that names neither the problem nor the fix. */
function pickModel(list, prefs) {
  for (const want of prefs) {
    const hit = list.find((x) => x.includes(want));
    if (hit) return hit;
  }
  return null;
}

const MODELS_URL = 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1';
const MODEL_FOLDERS = { unet: 'diffusion_models', clip: 'text_encoders', vae: 'vae' };

async function loadModels() {
  let chip = 'ComfyUI unreachable';
  try {
    const res = await fetch('/api/models');
    const m = await res.json();
    if (m.error) {
      if (m.kind === 'nodes') chip = 'ComfyUI too old';
      throw new Error(m.error);
    }
    const picked = {
      unet: pickModel(m.unet, MODEL_PREFS.unet),
      clip: pickModel(m.clip, MODEL_PREFS.clip),
      vae: pickModel(m.vae, MODEL_PREFS.vae),
    };
    const missing = Object.keys(picked).filter((k) => !picked[k]);
    if (missing.length) {
      chip = 'models missing';
      throw new Error('ComfyUI is running but the Qwen-Image 2.1 files are not installed. '
        + 'Missing: ' + missing.map((k) => MODEL_PREFS[k][0] + ' (models/' + MODEL_FOLDERS[k] + ')')
          .join(', ')
        + '. Download them from ' + MODELS_URL + ', restart ComfyUI, then press Connect.');
    }
    state.models = picked;
    $('conn').className = 'ok';
    $('conn').textContent = state.models.unet;
  } catch (e) {
    state.models = null;
    $('conn').className = 'bad';
    $('conn').textContent = chip;
    throw e;
  } finally {
    refreshPreview();
  }
}

/* ------------------------------------------------------------------ wiring */

function openFileInto(f) {
  const fr = new FileReader();
  fr.onload = () => { showView('edit'); loadImage(fr.result); };
  fr.readAsDataURL(f);
}

$('open').addEventListener('click', () => $('file').click());
$('empty').addEventListener('click', () => $('file').click());
/* Anywhere on the empty editing surface opens the picker, not just the exact stage element.
   The .view overlay sits on top of #stage, so an identity check against #stage alone never
   matched once the result view was added. */
$('stage').addEventListener('click', (e) => {
  if (state.img) return;
  const t = e.target;
  if (t === $('stage') || t.closest('.view[data-view="edit"]')) $('file').click();
});
$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) openFileInto(f);
  e.target.value = '';
});

['dragover', 'drop'].forEach((t) => {
  document.addEventListener(t, (e) => {
    e.preventDefault();
    if (t !== 'drop') return;
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) openFileInto(f);
  });
});

$('tFree').addEventListener('click', () => {
  state.tool = 'free'; $('tFree').classList.add('on'); $('tEllipse').classList.remove('on');
});
$('tEllipse').addEventListener('click', () => {
  state.tool = 'ellipse'; $('tEllipse').classList.add('on'); $('tFree').classList.remove('on');
});
$('undo').addEventListener('click', () => { state.regions.pop(); redraw(); });
$('clear').addEventListener('click', () => { state.regions = []; redraw(); });
$('go').addEventListener('click', generate);

/* Chaining edits is the normal way this gets used: circle, generate, then circle something on
 * the result. The clean plate becomes the output and the marks start again. */
$('useResult').addEventListener('click', () => {
  const done = state.gens.filter((g) => g.status === 'done');
  const g = state.gens.find((x) => x.id === state.activeGen && x.url) || done[done.length - 1];
  if (!g || !g.url) return;
  showView('edit');
  loadImage(g.url);
});

$('saveSession').addEventListener('click', saveSession);
$('loadSession').addEventListener('click', () => $('sessionFile').click());
$('sessionFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      applySession(JSON.parse(fr.result));
    } catch (err) {
      setStatus('could not load that session: ' + err.message, true);
    }
  };
  fr.readAsText(f);
  e.target.value = '';
});

$('exportMarked').addEventListener('click', () => {
  if (!state.img) return;
  download('markup-marked-' + stamp() + '.png', flatten());
  setStatus('marked image exported');
});

$('promptBox').addEventListener('input', (e) => {
  state.prompt = e.target.value;
  refreshPreview();
});

$('copyPrompt').addEventListener('click', async () => {
  const prompt = buildPrompt();
  if (!prompt) return;
  try {
    await navigator.clipboard.writeText(prompt);
    setStatus('prompt copied');
  } catch (e) {
    $('promptBox').select();
    setStatus('clipboard blocked — the prompt is selected, press Ctrl+C', true);
  }
});

/* The one sentence everybody forgets and every run needs. */
$('addTail').addEventListener('click', () => {
  const box = $('promptBox');
  const cur = box.value.trim();
  if (cur.includes('render the circle')) return;
  // Close the sentence first: "...bright golden yellow Do not render the circles" runs two
  // sentences together and the model is being asked to read this literally.
  const stem = cur ? (/[.!?]$/.test(cur) ? cur + ' ' : cur + '. ') : '';
  box.value = stem + NO_CIRCLES;
  state.prompt = box.value;
  refreshPreview();
  box.focus();
});

$('rndSeed').addEventListener('click', (e) => {
  e.preventDefault();
  $('seed').value = Math.floor(Math.random() * 2147483647);
});

$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  try {
    await connectTo($('comfyAddr').value);
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    $('connect').disabled = false;
  }
});
$('comfyAddr').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('connect').click();
});

window.addEventListener('resize', fitStage);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && state.view === 'edit') {
    state.regions.pop(); redraw();
  }
});

(async function init() {
  let remembered = null;
  try { remembered = localStorage.getItem('markup.comfy'); } catch (e) { /* private mode */ }

  try {
    const cfg = await (await fetch('/api/config')).json();
    $('comfyAddr').value = cfg.comfy || '';
    /* A remembered address is only tried when it differs from the one the server was started
     * with. The command line is the more deliberate of the two and wins a tie. */
    if (remembered && remembered !== cfg.comfy) {
      try {
        await connectTo(remembered, true);
      } catch (e) {
        setStatus('saved address ' + remembered + ' did not answer, using ' + cfg.comfy, true);
        $('comfyAddr').value = cfg.comfy || '';
        try { await loadModels(); } catch (e2) { /* reported in the connection chip */ }
      }
    } else {
      await loadModels();
    }
    if (cfg.progress_ws === false) {
      $('wsHint').textContent = 'Connected, but the progress websocket is not up, so a generation '
        + 'will show elapsed time without a percentage.';
    }
  } catch (e) {
    setStatus(String(e.message || e), true);
  }
  setWipe(50);
  redraw();
})();
