// ASBB Print: app shell, views and glue.
import { projects, uid, loadSettings, saveSettings, exportBackup, importBackup } from './store.js';
import {
  SIZES, sizeById, labelDots, mmToDots, openSource, findCropAreas, composeLabel, toMono, monoToCanvas,
  thumbFromMono, makeCanvas, packBits,
} from './image.js';
import { Printer, buildTspl, buildFeed, support } from './printer.js';
import { Editor, renderDesign, newElement, packingSlipDesign, parseCsv, FONTS, elId } from './designer.js';

const VERSION = '1.0.0';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let settings = loadSettings();
const printer = new Printer();
let job = null; // current print job
let editor = null; // designer
let editing = null; // project being designed { id?, name, design }
let installEvt = null;

// ---------- helpers ----------
let toastTimer;
function toast(msg, err = false, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const allSizes = () => [...SIZES, ...settings.customSizes];
function fillSizeSelect(sel, value) {
  sel.innerHTML = allSizes().map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  sel.value = value && allSizes().some((s) => s.id === value) ? value : settings.sizeId;
}
function setSeg(segEl, value) {
  for (const b of segEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(value));
}
function onSeg(segEl, fn) {
  segEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg(segEl, b.dataset.v);
    fn(b.dataset.v);
  });
}
function persist() { saveSettings(settings); }
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
for (const m of $$('.modal')) {
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
}

// ---------- navigation ----------
function show(view) {
  for (const v of ['home', 'job', 'design']) $(`#view-${v}`).hidden = v !== view;
  window.scrollTo(0, 0);
  if (view === 'home') renderProjects();
}
let viewStack = ['home'];
function go(view) { viewStack.push(view); history.pushState({ view }, ''); show(view); }
function back() { if (viewStack.length > 1) history.back(); else show('home'); }
window.addEventListener('popstate', () => {
  viewStack.pop();
  if (!viewStack.length) viewStack = ['home'];
  show(viewStack[viewStack.length - 1]);
});
for (const b of $$('[data-back]')) b.addEventListener('click', back);
$('#homeBtn').addEventListener('click', () => { while (viewStack.length > 1) { viewStack.pop(); } history.replaceState({ view: 'home' }, ''); show('home'); });

// ---------- printer status ----------
function updatePrinterUi() {
  const chip = $('#printerChip');
  chip.classList.toggle('on', printer.connected);
  chip.querySelector('.chip-text').textContent = printer.connected ? printer.name : 'Connect printer';
  const st = $('#printerStatus');
  st.textContent = printer.connected ? `Connected: ${printer.name} (${{ serial: 'Bluetooth', ble: 'Bluetooth LE', usb: 'USB' }[printer.kind]})` : 'Not connected';
  st.classList.toggle('ok', printer.connected);
}
printer.on(updatePrinterUi);

async function connect(kind) {
  try {
    if (kind === 'serial' && !support.serial) throw new Error('Bluetooth printers need Chrome on Android (version 148 or newer) or Chrome/Edge on a computer. Update Chrome and try again.');
    if (kind === 'ble' && !support.ble) throw new Error('Bluetooth LE isn’t available in this browser.');
    if (kind === 'usb' && !support.usb) throw new Error('USB printing isn’t available in this browser.');
    await printer.connect(kind);
    settings.transport = kind;
    persist();
    toast('Printer connected');
  } catch (e) {
    if (e && e.name === 'NotFoundError') { toast(kind === 'serial' ? 'No printer chosen. Is it paired in your phone’s Bluetooth settings?' : 'No printer chosen', true, 4200); return; }
    toast(e.message || String(e), true, 5000);
  }
}
$('#connSerial').addEventListener('click', () => connect('serial'));
$('#connBle').addEventListener('click', () => connect('ble'));
$('#connUsb').addEventListener('click', () => connect('usb'));
$('#connOff').addEventListener('click', () => printer.disconnect());
$('#printerChip').addEventListener('click', () => openSettings());

async function ensurePrinter() {
  if (printer.connected) return true;
  const t = await printer.restore(settings.transport).catch(() => null);
  if (t) return true;
  openSettings();
  toast('Connect your printer first', true);
  return false;
}

function printOpts(size) {
  return {
    wMm: size.w, hMm: size.h, gapType: settings.gapType, gapMm: settings.gapMm, density: settings.density, speed: settings.speed,
    offsetXmm: settings.offsetXmm, offsetYmm: settings.offsetYmm, flip: settings.flip, invert: settings.invert,
  };
}

let printing = false;
async function sendPages(pages, size) {
  if (printing) return false;
  if (!pages.length) { toast('Nothing to print', true); return false; }
  if (!(await ensurePrinter())) return false;
  printing = true;
  const chip = $('#printerChip');
  chip.classList.add('busy');
  try {
    toast('Sending to printer…', false, 60000);
    await printer.send(buildTspl(pages, printOpts(size)));
    toast(`Printed ${pages.reduce((n, p) => n + (p.copies || 1), 0)} label${pages.length > 1 || (pages[0].copies || 1) > 1 ? 's' : ''} ✓`);
    return true;
  } catch (e) {
    toast(`Couldn’t print: ${e.message || e}. Check the printer is on and close by.`, true, 6000);
    return false;
  } finally {
    printing = false;
    chip.classList.remove('busy');
  }
}

// ---------- test print ----------
function testPattern(size) {
  const d = labelDots(size);
  const c = makeCanvas(d.w, d.h);
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, d.w, d.h);
  x.fillStyle = '#000';
  const m = mmToDots(2);
  x.lineWidth = 6; x.strokeRect(m, m, d.w - 2 * m, d.h - 2 * m);
  const big = Math.min(d.w, d.h);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `700 ${Math.round(big * 0.1)}px Poppins, Arial, sans-serif`;
  x.fillText('ASBB Print', d.w / 2, d.h * 0.22);
  x.font = `400 ${Math.round(big * 0.05)}px Poppins, Arial, sans-serif`;
  x.fillText('Test print — it works!', d.w / 2, d.h * 0.32);
  x.fillText(`${size.name}`, d.w / 2, d.h * 0.39);
  // arrow showing top
  x.font = `700 ${Math.round(big * 0.07)}px Arial, sans-serif`;
  x.fillText('↑ TOP', d.w / 2, m + big * 0.07);
  // solid bar and checkerboard so a negative print is obvious
  x.fillRect(d.w * 0.15, d.h * 0.48, d.w * 0.7, d.h * 0.06);
  const cell = Math.round(big * 0.04);
  for (let r = 0; r < 4; r++) for (let k = 0; k < Math.floor((d.w * 0.7) / cell); k++) if ((r + k) % 2 === 0) x.fillRect(d.w * 0.15 + k * cell, d.h * 0.6 + r * cell, cell, cell);
  x.font = `400 ${Math.round(big * 0.04)}px Poppins, Arial, sans-serif`;
  x.fillText('The bar above should be solid black.', d.w / 2, d.h * 0.82);
  x.fillText('If it’s white, tick “negative” in Settings.', d.w / 2, d.h * 0.87);
  return toMono(c, 'sharp');
}
async function testPrint() {
  const size = sizeById(settings.sizeId, settings.customSizes);
  await sendPages([{ mono: testPattern(size), copies: 1 }], size);
}
$('#actTest').addEventListener('click', testPrint);
$('#testPrint').addEventListener('click', testPrint);
$('#feedBtn').addEventListener('click', async () => {
  if (!(await ensurePrinter())) return;
  try { await printer.send(buildFeed(printOpts(sizeById(settings.sizeId, settings.customSizes)))); toast('Fed one label'); } catch (e) { toast(e.message, true); }
});

// ---------- settings modal ----------
function openSettings() {
  fillSizeSelect($('#sSize'), settings.sizeId);
  $('#sGapType').value = settings.gapType;
  $('#sGap').value = settings.gapMm; $('#gapOut').textContent = `${settings.gapMm} mm`;
  $('#sDensity').value = settings.density; $('#densOut').textContent = settings.density;
  $('#sSpeed').value = settings.speed;
  $('#sOffX').value = settings.offsetXmm; $('#sOffY').value = settings.offsetYmm;
  $('#sFlip').checked = settings.flip; $('#sInvert').checked = settings.invert;
  $('#installBtn2').hidden = !installEvt;
  renderCustomSizes();
  updatePrinterUi();
  openModal('#settingsModal');
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#sSize').addEventListener('change', (e) => { settings.sizeId = e.target.value; persist(); });
$('#sGapType').addEventListener('change', (e) => { settings.gapType = e.target.value; persist(); });
$('#sGap').addEventListener('input', (e) => { settings.gapMm = Number(e.target.value); $('#gapOut').textContent = `${settings.gapMm} mm`; persist(); });
$('#sDensity').addEventListener('input', (e) => { settings.density = Number(e.target.value); $('#densOut').textContent = settings.density; persist(); });
$('#sSpeed').addEventListener('change', (e) => { settings.speed = e.target.value; persist(); });
$('#sOffX').addEventListener('change', (e) => { settings.offsetXmm = Number(e.target.value) || 0; persist(); });
$('#sOffY').addEventListener('change', (e) => { settings.offsetYmm = Number(e.target.value) || 0; persist(); });
$('#sFlip').addEventListener('change', (e) => { settings.flip = e.target.checked; persist(); });
$('#sInvert').addEventListener('change', (e) => { settings.invert = e.target.checked; persist(); });
function renderCustomSizes() {
  $('#customList').innerHTML = settings.customSizes.map((s) => `<span>${esc(s.name)} <button data-del="${esc(s.id)}" aria-label="Remove ${esc(s.name)}">✕</button></span>`).join('');
}
$('#customList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  settings.customSizes = settings.customSizes.filter((s) => s.id !== b.dataset.del);
  if (settings.sizeId === b.dataset.del) settings.sizeId = '4x6';
  persist(); renderCustomSizes(); fillSizeSelect($('#sSize'), settings.sizeId);
});
$('#addSize').addEventListener('click', () => {
  const w = Number($('#cW').value), h = Number($('#cH').value);
  if (!(w >= 10 && w <= 120 && h >= 10 && h <= 400)) { toast('Width 10–120 mm, height 10–400 mm', true); return; }
  const s = { id: `c${w}x${h}`, name: `${w} × ${h} mm (custom)`, w, h };
  if (!settings.customSizes.some((c) => c.id === s.id)) settings.customSizes.push(s);
  persist(); renderCustomSizes(); fillSizeSelect($('#sSize'), settings.sizeId);
  $('#cW').value = ''; $('#cH').value = '';
  toast('Size added');
});

// backup
async function doBackup() {
  try {
    const blob = await exportBackup();
    const name = `asbb-print-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'ASBB Print backup' }).catch(() => downloadBlob(blob, name));
    } else downloadBlob(blob, name);
    settings.lastBackup = Date.now(); settings.savesSinceBackup = 0; persist();
    $('#backupBanner').hidden = true;
  } catch (e) { toast(`Backup failed: ${e.message}`, true); }
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('#exportBtn').addEventListener('click', doBackup);
$('#backupNowBtn').addEventListener('click', doBackup);
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const n = await importBackup(f); toast(`Restored ${n} project${n === 1 ? '' : 's'}`); renderProjects(); } catch (err) { toast(err.message, true, 5000); }
});

// install
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('#installBanner').hidden = false;
  $('#installBtn2').hidden = false;
});
async function install() {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => {});
  installEvt = null;
  $('#installBanner').hidden = true; $('#installBtn2').hidden = true;
}
$('#installBtn').addEventListener('click', install);
$('#installBtn2').addEventListener('click', install);
window.addEventListener('appinstalled', () => { $('#installBanner').hidden = true; });

// ---------- projects ----------
const thumbUrls = new Map();
async function renderProjects() {
  const q = $('#projectSearch').value.trim().toLowerCase();
  let list = await projects.all();
  if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
  const grid = $('#projectGrid');
  for (const u of thumbUrls.values()) URL.revokeObjectURL(u);
  thumbUrls.clear();
  grid.innerHTML = list.map((p) => {
    let src = '';
    if (p.thumb instanceof Blob) { src = URL.createObjectURL(p.thumb); thumbUrls.set(p.id, src); }
    const size = sizeById(p.sizeId, settings.customSizes);
    const pages = p.type === 'crop' ? (p.pages?.length || 1) : (p.design?.data?.rows?.length || 1);
    return `<article class="tile" data-id="${esc(p.id)}">
      ${p.pinned ? '<span class="pin">PINNED</span>' : ''}
      <button class="tile-thumb" data-open aria-label="Open ${esc(p.name)}">${src ? `<img src="${src}" alt="">` : ''}</button>
      <div class="tile-body">
        <div class="tile-name">${esc(p.name)}</div>
        <div class="tile-meta">${esc(size.name.replace(/ \(.*\)/, ''))}${pages > 1 ? ` · ${pages} labels` : ''}</div>
        <div class="tile-row"><button class="btn primary small" data-print>Print</button><button class="btn ghost small" data-menu aria-label="More options">⋯</button></div>
      </div></article>`;
  }).join('');
  $('#projectsEmpty').hidden = list.length > 0 || !!q;
}
$('#projectSearch').addEventListener('input', renderProjects);
$('#projectGrid').addEventListener('click', async (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const p = await projects.get(tile.dataset.id);
  if (!p) return;
  if (e.target.closest('[data-print]')) quickPrint(p);
  else if (e.target.closest('[data-menu]')) projectMenu(p);
  else if (e.target.closest('[data-open]')) openProject(p);
});

async function projectPages(p, copies) {
  const size = sizeById(p.sizeId, settings.customSizes);
  if (p.type === 'crop') return { size, pages: (p.pages || []).map((mono) => ({ mono, copies: copies ?? p.opts?.copies ?? 1 })) };
  return { size, pages: await designPages(p.design, copies ?? p.copies ?? 1) };
}

async function quickPrint(p) {
  try {
    const { size, pages } = await projectPages(p);
    const out = [];
    let slip = null;
    if (p.slipId) slip = await projects.get(p.slipId);
    const slipPages = slip ? (await projectPages(slip, 1)).pages : [];
    for (const pg of pages) { out.push(pg); out.push(...slipPages); }
    await sendPages(out, size);
  } catch (e) { toast(e.message || String(e), true); }
}

function openProject(p) {
  if (p.type === 'design') openDesigner(p);
  else openJobFromProject(p);
}

function projectMenu(p) {
  $('#menuTitle').textContent = p.name;
  const items = [
    ['open', p.type === 'design' ? 'Edit design' : 'Open & adjust'],
    ['preview', 'Preview & print'],
    ['rename', 'Rename'],
    ['dup', 'Duplicate'],
    ['pin', p.pinned ? 'Unpin' : 'Pin to top'],
    ['del', 'Delete'],
  ];
  $('#menuItems').innerHTML = items.map(([k, t]) => `<button class="btn ${k === 'del' ? 'ghost' : ''}" data-k="${k}">${t}</button>`).join('');
  $('#menuItems').onclick = async (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    closeModal('#menuModal');
    if (k === 'open') openProject(p);
    if (k === 'preview') { if (p.type === 'design') openJobFromDesign(p.design, p.name, p); else openJobFromProject(p); }
    if (k === 'rename') { const n = prompt('Project name', p.name); if (n && n.trim()) { p.name = n.trim(); await projects.put(p); renderProjects(); } }
    if (k === 'dup') { const c = { ...p, id: uid(), name: `${p.name} copy`, pinned: false }; if (c.design) c.design = structuredClone(c.design); await projects.put(c); renderProjects(); }
    if (k === 'pin') { p.pinned = !p.pinned; await projects.put(p); renderProjects(); }
    if (k === 'del') { if (confirm(`Delete “${p.name}”? This can’t be undone.`)) { await projects.remove(p.id); if (settings.slipProjectId === p.id) { settings.slipProjectId = ''; persist(); } renderProjects(); } }
  };
  openModal('#menuModal');
}

async function noteSaved() {
  settings.savesSinceBackup = (settings.savesSinceBackup || 0) + 1;
  persist();
  if (settings.savesSinceBackup >= 5) $('#backupBanner').hidden = false;
}

// ---------- print job (preview) ----------
function defaultJobOpts() {
  return { sizeId: settings.sizeId, crop: 'auto', manual: null, areaIndex: 0, rotate: 'auto', fit: 'fit', marginMm: 2, look: 'sharp', level: 160, copies: 1, pages: 'all', slipId: '' };
}

async function openJobFromFile(file) {
  const busy = $('#jobBusy');
  try {
    go('job');
    busy.hidden = false;
    const source = await openSource(file);
    job = { kind: 'crop', title: (file.name || 'Label').replace(/\.[a-z0-9]+$/i, ''), file, source, page: 0, opts: defaultJobOpts(), cache: new Map(), areas: new Map(), project: null };
    await setupJobUi();
  } catch (e) {
    toast(`Couldn’t open that file: ${e.message}`, true, 5000);
    back();
  } finally { busy.hidden = true; }
}

async function openJobFromProject(p) {
  go('job');
  const busy = $('#jobBusy');
  busy.hidden = false;
  try {
    let source = null;
    if (p.source instanceof Blob) source = await openSource(new File([p.source], p.sourceName || 'label', { type: p.source.type }));
    job = { kind: 'crop', title: p.name, file: p.source, source, page: 0, opts: { ...defaultJobOpts(), ...p.opts, slipId: p.slipId || '' }, cache: new Map(), areas: new Map(), project: p, savedPages: source ? null : p.pages };
    await setupJobUi();
  } catch (e) { toast(e.message, true); back(); } finally { busy.hidden = true; }
}

function openJobFromDesign(design, title, project) {
  go('job');
  job = { kind: 'design', title: title || 'Label', design, page: 0, opts: { ...defaultJobOpts(), sizeId: design.sizeId, copies: project?.copies || 1, slipId: project?.slipId || '' }, cache: new Map(), project: project || null };
  setupJobUi();
}

async function fillSlipSelect(selected) {
  const list = (await projects.all()).filter((p) => p.type === 'design' && (!job?.project || p.id !== job.project.id));
  $('#jobSlip').innerHTML = '<option value="">None</option>' + list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('#jobSlip').value = list.some((p) => p.id === selected) ? selected : '';
}

function jobPageCount() {
  if (!job) return 0;
  if (job.kind === 'design') return designRowCount(job.design, job.opts.copies);
  if (job.source) return job.source.count;
  return job.savedPages?.length || 1;
}

async function setupJobUi() {
  const o = job.opts;
  $('#jobTitle').textContent = job.title;
  fillSizeSelect($('#jobSize'), o.sizeId);
  const isCrop = job.kind === 'crop' && !!job.source;
  for (const id of ['#cropField', '#rotField', '#fitField', '#marginField']) $(id).hidden = !isCrop;
  $('#jobSize').closest('.field').hidden = job.kind === 'design';
  $('#lookSeg').closest('.field').hidden = job.kind === 'design' || !isCrop;
  $('#levelField').hidden = job.kind === 'design' || !isCrop || o.look === 'photo';
  setSeg($('#cropSeg'), o.crop); setSeg($('#rotSeg'), o.rotate); setSeg($('#fitSeg'), o.fit); setSeg($('#lookSeg'), o.look);
  $('#jobMargin').value = o.marginMm; $('#marginOut').textContent = `${o.marginMm} mm`;
  $('#jobLevel').value = o.level; $('#levelOut').textContent = o.level;
  $('#jobCopies').value = o.copies;
  $('#jobPages').value = o.pages;
  $('#nextArea').hidden = o.crop !== 'auto';
  $('#editCrop').hidden = o.crop === 'none';
  await fillSlipSelect(o.slipId);
  updatePager();
  await renderJobPage();
}

function updatePager() {
  const n = jobPageCount();
  $('#pager').hidden = n <= 1;
  $('#pagesField').hidden = n <= 1 || job.kind === 'design';
  job.page = Math.min(job.page, n - 1);
  $('#pgText').textContent = `${job.page + 1} / ${n}`;
}
$('#pgPrev').addEventListener('click', () => { if (job.page > 0) { job.page--; updatePager(); renderJobPage(); } });
$('#pgNext').addEventListener('click', () => { if (job.page < jobPageCount() - 1) { job.page++; updatePager(); renderJobPage(); } });

function jobKey() {
  const o = job.opts;
  return JSON.stringify([o.sizeId, o.crop, o.manual, o.areaIndex, o.rotate, o.fit, o.marginMm, o.look, o.level]);
}

async function cropPageMono(i) {
  const key = `${i}|${jobKey()}`;
  if (job.cache.has(key)) return job.cache.get(key);
  const o = job.opts;
  const size = sizeById(o.sizeId, settings.customSizes);
  const dots = labelDots(size);
  const src = await job.source.page(i);
  let crop = { x: 0, y: 0, w: src.width, h: src.height };
  if (o.crop === 'auto') {
    const aspect = dots.h / dots.w;
    const aKey = `${i}|${aspect.toFixed(3)}`;
    if (!job.areas.has(aKey)) job.areas.set(aKey, findCropAreas(src, aspect));
    const areas = job.areas.get(aKey);
    crop = areas[o.areaIndex % areas.length];
  } else if (o.crop === 'manual' && o.manual) {
    crop = { x: o.manual.x * src.width, y: o.manual.y * src.height, w: o.manual.w * src.width, h: o.manual.h * src.height };
  }
  const comp = composeLabel(src, crop, dots, { rotate: o.rotate, fit: o.fit, marginDots: mmToDots(o.marginMm) });
  const mono = toMono(comp, o.look, o.level);
  if (job.cache.size > 12) job.cache.delete(job.cache.keys().next().value);
  job.cache.set(key, mono);
  return mono;
}

let renderSeq = 0;
async function renderJobPage() {
  const seq = ++renderSeq;
  const cv = $('#jobCanvas');
  let mono;
  try {
    if (job.kind === 'design') {
      const pages = await designPages(job.design, job.opts.copies, job.page, 1);
      mono = pages[0]?.mono;
    } else if (job.source) mono = await cropPageMono(job.page);
    else mono = job.savedPages?.[job.page];
  } catch (e) { toast(e.message, true); return; }
  if (seq !== renderSeq || !mono) return;
  const pc = monoToCanvas(mono);
  cv.width = pc.width; cv.height = pc.height;
  cv.getContext('2d').drawImage(pc, 0, 0);
}

function jobChanged() { $('#nextArea').hidden = job.opts.crop !== 'auto'; $('#editCrop').hidden = job.opts.crop === 'none'; renderJobPage(); }
$('#jobSize').addEventListener('change', (e) => { job.opts.sizeId = e.target.value; job.opts.areaIndex = 0; jobChanged(); });
onSeg($('#cropSeg'), (v) => {
  job.opts.crop = v;
  if (v === 'manual' && !job.opts.manual) { openCropEditor(); return; }
  jobChanged();
});
onSeg($('#rotSeg'), (v) => { job.opts.rotate = v === 'auto' ? 'auto' : Number(v); jobChanged(); });
onSeg($('#fitSeg'), (v) => { job.opts.fit = v; jobChanged(); });
onSeg($('#lookSeg'), (v) => { job.opts.look = v; $('#levelField').hidden = v === 'photo'; jobChanged(); });
$('#jobMargin').addEventListener('input', (e) => { job.opts.marginMm = Number(e.target.value); $('#marginOut').textContent = `${job.opts.marginMm} mm`; jobChanged(); });
$('#jobLevel').addEventListener('input', (e) => { job.opts.level = Number(e.target.value); $('#levelOut').textContent = job.opts.level; jobChanged(); });
$('#nextArea').addEventListener('click', () => { job.opts.areaIndex++; jobChanged(); });
$('#editCrop').addEventListener('click', () => openCropEditor());
function setCopies(n) {
  job.opts.copies = Math.max(1, Math.min(999, Math.round(Number(n) || 1)));
  $('#jobCopies').value = job.opts.copies;
  if (job.kind === 'design') { updatePager(); renderJobPage(); }
}
$('#cMinus').addEventListener('click', () => setCopies(job.opts.copies - 1));
$('#cPlus').addEventListener('click', () => setCopies(job.opts.copies + 1));
$('#jobCopies').addEventListener('change', (e) => setCopies(e.target.value));
$('#jobPages').addEventListener('change', (e) => { job.opts.pages = e.target.value; });
$('#jobSlip').addEventListener('change', (e) => { job.opts.slipId = e.target.value; });

async function allJobPages() {
  const o = job.opts;
  if (job.kind === 'design') return designPages(job.design, o.copies);
  const n = jobPageCount();
  const idx = o.pages === 'current' ? [job.page] : [...Array(n).keys()];
  const out = [];
  const busy = $('#jobBusy');
  busy.hidden = false;
  try {
    for (const i of idx) {
      busy.textContent = n > 1 ? `Preparing label ${out.length + 1} of ${idx.length}…` : 'Preparing…';
      const mono = job.source ? await cropPageMono(i) : job.savedPages[i];
      out.push({ mono, copies: o.copies });
    }
  } finally { busy.hidden = true; busy.textContent = 'Working…'; }
  return out;
}

$('#jobPrint').addEventListener('click', async () => {
  try {
    const pages = await allJobPages();
    const size = sizeById(job.kind === 'design' ? job.design.sizeId : job.opts.sizeId, settings.customSizes);
    let out = pages;
    if (job.opts.slipId) {
      const slip = await projects.get(job.opts.slipId);
      if (slip) {
        const sp = (await projectPages(slip, 1)).pages;
        out = [];
        for (const p of pages) { out.push(p); out.push(...sp); }
      }
    }
    await sendPages(out, size);
  } catch (e) { toast(e.message || String(e), true); }
});

$('#jobSave').addEventListener('click', async () => {
  try {
    if (job.kind === 'design') {
      const p = job.project || { id: uid(), type: 'design', name: job.title, created: Date.now() };
      p.design = job.design; p.sizeId = job.design.sizeId; p.copies = job.opts.copies; p.slipId = job.opts.slipId;
      p.thumb = await thumbFromMono((await designPages(job.design, 1, 0, 1))[0].mono);
      await projects.put(p); job.project = p;
      toast('Saved'); noteSaved();
      return;
    }
    const name = prompt('Name this project', job.project?.name || job.title);
    if (!name) return;
    const pages = (await allJobPages()).map((p) => p.mono);
    const p = job.project || { id: uid(), type: 'crop', created: Date.now() };
    Object.assign(p, {
      name: name.trim(), sizeId: job.opts.sizeId, opts: { ...job.opts, pages: 'all' }, slipId: job.opts.slipId, pages,
      thumb: await thumbFromMono(pages[0]),
    });
    if (job.file instanceof Blob && job.file.size < 25e6) { p.source = job.file; p.sourceName = job.file.name || p.sourceName; }
    await projects.put(p); job.project = p; job.title = p.name; $('#jobTitle').textContent = p.name;
    toast('Saved to your projects'); noteSaved();
  } catch (e) { toast(`Couldn’t save: ${e.message}`, true); }
});

// ---------- crop editor ----------
let cropState = null;
async function openCropEditor() {
  if (!job?.source) return;
  const src = await job.source.page(job.page);
  const cv = $('#cropCanvas');
  const k = Math.min(1, 1000 / Math.max(src.width, src.height));
  cv.width = Math.round(src.width * k); cv.height = Math.round(src.height * k);
  let rect = job.opts.manual;
  if (!rect) {
    // start from the auto-detected area
    const dots = labelDots(sizeById(job.opts.sizeId, settings.customSizes));
    const areas = findCropAreas(src, dots.h / dots.w);
    const a = areas[job.opts.areaIndex % areas.length];
    rect = { x: a.x / src.width, y: a.y / src.height, w: a.w / src.width, h: a.h / src.height };
  }
  cropState = { src, rect: { ...rect }, drag: null };
  drawCrop();
  openModal('#cropModal');
}
function drawCrop() {
  const cv = $('#cropCanvas');
  const x = cv.getContext('2d');
  const { src, rect } = cropState;
  x.drawImage(src, 0, 0, cv.width, cv.height);
  const r = { x: rect.x * cv.width, y: rect.y * cv.height, w: rect.w * cv.width, h: rect.h * cv.height };
  x.fillStyle = 'rgba(0,0,0,.55)';
  x.fillRect(0, 0, cv.width, r.y); x.fillRect(0, r.y + r.h, cv.width, cv.height - r.y - r.h);
  x.fillRect(0, r.y, r.x, r.h); x.fillRect(r.x + r.w, r.y, cv.width - r.x - r.w, r.h);
  x.strokeStyle = '#ff2bd6'; x.lineWidth = 3; x.strokeRect(r.x, r.y, r.w, r.h);
  const hs = Math.max(10, cv.width * 0.025);
  x.fillStyle = '#22d3ee';
  for (const [hx, hy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) x.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
}
function cropPt(e) {
  const cv = $('#cropCanvas'); const b = cv.getBoundingClientRect();
  return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
}
$('#cropCanvas').addEventListener('pointerdown', (e) => {
  const p = cropPt(e); const r = cropState.rect; const tol = 0.05;
  const corners = { nw: [r.x, r.y], ne: [r.x + r.w, r.y], sw: [r.x, r.y + r.h], se: [r.x + r.w, r.y + r.h] };
  let mode = null;
  for (const [k, [cx, cy]] of Object.entries(corners)) if (Math.abs(p.x - cx) < tol && Math.abs(p.y - cy) < tol) mode = k;
  if (!mode && p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) mode = 'move';
  if (!mode) { cropState.rect = { x: p.x, y: p.y, w: 0.01, h: 0.01 }; mode = 'se'; }
  cropState.drag = { mode, p, r: { ...cropState.rect } };
  e.target.setPointerCapture(e.pointerId);
});
$('#cropCanvas').addEventListener('pointermove', (e) => {
  const d = cropState?.drag; if (!d) return;
  const p = cropPt(e); const dx = p.x - d.p.x, dy = p.y - d.p.y; const o = d.r;
  let { x, y, w, h } = o;
  const cl = (v) => Math.max(0, Math.min(1, v));
  if (d.mode === 'move') { x = cl(Math.min(1 - w, o.x + dx)); y = cl(Math.min(1 - h, o.y + dy)); }
  else {
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (d.mode.includes('w')) x1 = cl(o.x + dx); else x2 = cl(o.x + o.w + dx);
    if (d.mode.includes('n')) y1 = cl(o.y + dy); else y2 = cl(o.y + o.h + dy);
    x = Math.min(x1, x2); y = Math.min(y1, y2); w = Math.max(0.02, Math.abs(x2 - x1)); h = Math.max(0.02, Math.abs(y2 - y1));
  }
  cropState.rect = { x, y, w, h };
  drawCrop();
});
$('#cropCanvas').addEventListener('pointerup', () => { if (cropState) cropState.drag = null; });
$('#cropReset').addEventListener('click', () => { cropState.rect = { x: 0, y: 0, w: 1, h: 1 }; drawCrop(); });
$('#cropDone').addEventListener('click', () => {
  job.opts.manual = { ...cropState.rect };
  job.opts.crop = 'manual';
  setSeg($('#cropSeg'), 'manual');
  closeModal('#cropModal');
  jobChanged();
});

// ---------- designs: pages ----------
function usesSerial(design) {
  return design.elements.some((el) => /\{\{\s*n\s*\}\}/i.test(`${el.text || ''}${el.value || ''}`));
}
function designRowCount(design, copies) {
  const rows = design.data?.rows || [];
  if (rows.length) return rows.length;
  return usesSerial(design) ? Math.max(1, copies) : 1;
}
// Returns pages for a design. With data rows: one page per row (each printed `copies` times).
// With a {{n}} serial and no rows: `copies` pages numbered from serialStart.
async function designPages(design, copies = 1, from = 0, count = Infinity) {
  const rows = design.data?.rows || [];
  const start = Number(design.data?.serialStart) || 1;
  const out = [];
  if (rows.length) {
    for (let i = from; i < Math.min(rows.length, from + count); i++) {
      out.push({ mono: toMono(await renderDesign(design, { row: rows[i], n: start + i }), 'sharp', 160), copies });
    }
  } else if (usesSerial(design)) {
    for (let i = from; i < Math.min(copies, from + count); i++) out.push({ mono: toMono(await renderDesign(design, { n: start + i }), 'sharp', 160), copies: 1 });
  } else {
    out.push({ mono: toMono(await renderDesign(design, { n: start }), 'sharp', 160), copies });
  }
  return out;
}

// ---------- designer ----------
function blankDesign(sizeId) {
  const size = sizeById(sizeId, settings.customSizes);
  const d = labelDots(size);
  return { sizeId: size.id, w: d.w, h: d.h, elements: [], data: null };
}

function openDesigner(project) {
  go('design');
  editing = project
    ? { id: project.id, name: project.name, design: structuredClone(project.design), project }
    : { id: null, name: 'New label', design: blankDesign(settings.sizeId), project: null };
  if (!editor) editor = new Editor($('#dCanvas'), (why) => { if (why === 'select') renderProps(); });
  $('#dName').value = editing.name;
  fillSizeSelect($('#dSize'), editing.design.sizeId);
  editor.load(editing.design);
  renderProps();
}

$('#dName').addEventListener('input', (e) => { if (editing) editing.name = e.target.value; });
$('#dSize').addEventListener('change', (e) => {
  const d = editing.design;
  const size = sizeById(e.target.value, settings.customSizes);
  const nd = labelDots(size);
  const kx = nd.w / d.w, ky = nd.h / d.h;
  const k = Math.min(kx, ky);
  for (const el of d.elements) {
    el.x = Math.round(el.x * kx); el.y = Math.round(el.y * ky);
    el.w = Math.round(el.w * k); el.h = Math.round(el.h * k);
    if (el.size) el.size = Math.round(el.size * k);
  }
  d.w = nd.w; d.h = nd.h; d.sizeId = size.id;
  editor.draw();
});

$('#dTools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  const t = b.dataset.add;
  if (t === 'image') { $('#dImageInput').click(); return; }
  let el;
  if (t === 'logo') { el = newElement('image', editing.design); el.src = 'img/asbb-logo-mono.png'; el.dither = false; el.h = Math.round(el.w * 0.4); }
  else el = newElement(t, editing.design);
  placeFree(el);
  editing.design.elements.push(el);
  editor.select(el.id);
});
// Put a new item in the first free space below what's already on the label, so nothing gets hidden.
function placeFree(el) {
  const d = editing.design;
  if (!d.elements.length) { el.y = Math.round(d.h * 0.05); return; }
  const gap = Math.round(d.h * 0.02);
  const bottom = Math.max(...d.elements.map((e) => e.y + e.h));
  if (bottom + gap + el.h <= d.h * 0.97) el.y = Math.round(bottom + gap);
  else { el.x = Math.round(el.x + d.w * 0.04); el.y = Math.round(Math.min(d.h - el.h, el.y + d.h * 0.04)); }
}
$('#dImageInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const url = await shrinkImage(f, 1400);
  const el = newElement('image', editing.design);
  el.src = url;
  placeFree(el);
  editing.design.elements.push(el);
  editor.select(el.id);
});
async function shrinkImage(file, max) {
  const { loadImage } = await import('./image.js');
  const img = await loadImage(file);
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(img.naturalWidth * k, img.naturalHeight * k);
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}

$('#dData').addEventListener('click', () => { editor.select(null); renderDataPanel(); });
$('#dCsvInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const parsed = parseCsv(await f.text());
  if (!parsed.rows.length) { toast('No rows found in that file', true); return; }
  editing.design.data = { ...(editing.design.data || {}), columns: parsed.columns, rows: parsed.rows, serialStart: editing.design.data?.serialStart || 1, fileName: f.name };
  renderDataPanel();
  editor.draw();
  toast(`${parsed.rows.length} rows loaded`);
});

function renderDataPanel() {
  const d = editing.design.data || {};
  const cols = d.columns || [];
  $('#dProps').innerHTML = `
    <h3 style="margin:0;font-size:15px">Print from a spreadsheet</h3>
    <p class="hint">Load a CSV file (save your Excel or Google sheet as CSV). Put column names in curly brackets in any text, QR or barcode, like <b>{{Name}}</b>, and you'll get one label per row. Use <b>{{n}}</b> for a number that goes up on every label.</p>
    <div class="row-btns"><button class="btn small" id="csvLoad">${cols.length ? 'Load a different file' : 'Load CSV file'}</button>${cols.length ? '<button class="btn ghost small" id="csvClear">Remove data</button>' : ''}</div>
    ${cols.length ? `<p class="hint"><b>${esc(d.fileName || 'Data')}</b>: ${d.rows.length} rows. Columns: ${cols.map((c) => `<code>{{${esc(c)}}}</code>`).join(' ')}</p>` : ''}
    <label class="field"><span>Numbering starts at</span><input type="number" id="serialStart" value="${Number(d.serialStart) || 1}" min="0"></label>`;
  $('#csvLoad').onclick = () => $('#dCsvInput').click();
  if ($('#csvClear')) $('#csvClear').onclick = () => { editing.design.data = { serialStart: d.serialStart || 1 }; renderDataPanel(); editor.draw(); };
  $('#serialStart').onchange = (e) => { editing.design.data = { ...(editing.design.data || {}), serialStart: Number(e.target.value) || 1 }; editor.draw(); };
}

function renderProps() {
  const el = editor.sel();
  const P = $('#dProps');
  if (!el) { P.innerHTML = '<p class="hint">Tap something on the label to edit it, drag to move, and drag the pink dot to resize. Add things with the buttons above.</p>'; return; }
  const fontOpts = FONTS.map((f) => `<option value="${f.id}" ${el.font === f.id ? 'selected' : ''}>${f.name}</option>`).join('');
  let html = '';
  if (el.type === 'text') {
    html = `
      <label class="field"><span>Text</span><textarea data-p="text">${esc(el.text)}</textarea></label>
      <div class="field two">
        <label><span>Font</span><select data-p="font">${fontOpts}</select></label>
        <label><span>Size</span><input type="number" data-p="size" data-num value="${el.size}" min="6" max="600"></label>
      </div>
      <div class="field"><span>Align</span><div class="seg" data-seg="align"><button data-v="left">Left</button><button data-v="center">Centre</button><button data-v="right">Right</button></div></div>
      <div class="prop-row">
        <label class="check"><input type="checkbox" data-p="bold" ${el.bold ? 'checked' : ''}> Bold</label>
        <label class="check"><input type="checkbox" data-p="italic" ${el.italic ? 'checked' : ''}> Italic</label>
        <label class="check"><input type="checkbox" data-p="fit" ${el.fit ? 'checked' : ''}> Shrink to fit</label>
        <label class="check"><input type="checkbox" data-p="invert" ${el.invert ? 'checked' : ''}> White on black</label>
      </div>`;
  } else if (el.type === 'qr') {
    html = `<label class="field"><span>QR code link or text</span><input type="text" data-p="value" value="${esc(el.value)}"></label>`;
  } else if (el.type === 'barcode') {
    html = `
      <label class="field"><span>Barcode number</span><input type="text" data-p="value" value="${esc(el.value)}"></label>
      <div class="field two">
        <label><span>Type</span><select data-p="format">${['CODE128', 'EAN13', 'UPC', 'EAN8', 'CODE39', 'ITF14'].map((f) => `<option ${el.format === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
        <label class="check" style="align-self:end"><input type="checkbox" data-p="showText" ${el.showText ? 'checked' : ''}> Show number</label>
      </div>`;
  } else if (el.type === 'image') {
    html = `
      <div class="row-btns"><button class="btn small" id="replaceImg">Replace picture</button></div>
      <label class="check"><input type="checkbox" data-p="dither" ${el.dither ? 'checked' : ''}> Photo shading (for photos, off for logos)</label>`;
  } else if (el.type === 'rect') {
    html = `
      <label class="check"><input type="checkbox" data-p="fill" ${el.fill ? 'checked' : ''}> Filled solid black</label>
      <label class="field"><span>Line thickness</span><input type="range" data-p="thick" data-num min="2" max="30" value="${el.thick}"></label>`;
  } else if (el.type === 'line') {
    html = `<label class="field"><span>Thickness</span><input type="range" data-p="thick" data-num min="2" max="30" value="${el.thick}"></label>
      <div class="row-btns"><button class="btn small ghost" id="lineTurn">Make ${el.w >= el.h ? 'vertical' : 'horizontal'}</button></div>`;
  }
  html += `
    <div class="row-btns">
      <button class="btn small ghost" data-act="rotate">Rotate 90°</button>
      <button class="btn small ghost" data-act="center">Centre</button>
      <button class="btn small ghost" data-act="up">Bring forward</button>
      <button class="btn small ghost" data-act="dup">Duplicate</button>
      <button class="btn small ghost" data-act="del">Delete</button>
    </div>`;
  P.innerHTML = html;
  const segAlign = P.querySelector('[data-seg="align"]');
  if (segAlign) { setSeg(segAlign, el.align); onSeg(segAlign, (v) => { el.align = v; editor.draw(); }); }
  for (const inp of P.querySelectorAll('[data-p]')) {
    const ev = inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input';
    inp.addEventListener(ev, () => {
      const k = inp.dataset.p;
      el[k] = inp.type === 'checkbox' ? inp.checked : inp.hasAttribute('data-num') ? Number(inp.value) : inp.value;
      editor.draw();
    });
  }
  if ($('#replaceImg')) $('#replaceImg').onclick = () => {
    const input = $('#dImageInput');
    const handler = async (e) => {
      input.removeEventListener('change', handler, true);
      const f = e.target.files[0];
      if (!f) return;
      e.stopImmediatePropagation();
      el.src = await shrinkImage(f, 1400); e.target.value = ''; editor.draw();
    };
    input.addEventListener('change', handler, true);
    input.click();
  };
  if ($('#lineTurn')) $('#lineTurn').onclick = () => {
    const t = el.thick || 6;
    if (el.w >= el.h) { el.h = el.w; el.w = t; } else { el.w = el.h; el.h = t; }
    editor.draw(); renderProps();
  };
  P.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const els = editing.design.elements;
    const i = els.indexOf(el);
    const a = b.dataset.act;
    if (a === 'rotate') {
      el.rot = ((el.rot || 0) + 90) % 360;
      const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
      [el.w, el.h] = [el.h, el.w];
      el.x = Math.round(cx - el.w / 2); el.y = Math.round(cy - el.h / 2);
    }
    if (a === 'center') { el.x = Math.round((editing.design.w - el.w) / 2); }
    if (a === 'up' && i < els.length - 1) { els.splice(i, 1); els.splice(i + 1, 0, el); }
    if (a === 'dup') { const c = { ...structuredClone(el), id: elId(), x: el.x + 20, y: el.y + 20 }; els.push(c); editor.select(c.id); return; }
    if (a === 'del') { els.splice(i, 1); editor.select(null); return; }
    editor.draw();
  }));
}

async function saveDesign() {
  const p = editing.project || { id: uid(), type: 'design', created: Date.now(), copies: 1 };
  p.name = (editing.name || 'Label').trim() || 'Label';
  p.design = structuredClone(editing.design);
  p.sizeId = p.design.sizeId;
  p.thumb = await thumbFromMono((await designPages(p.design, 1, 0, 1))[0].mono);
  await projects.put(p);
  editing.project = p; editing.id = p.id;
  return p;
}
$('#dSave').addEventListener('click', async () => {
  try { await saveDesign(); toast('Saved to your projects'); noteSaved(); } catch (e) { toast(`Couldn’t save: ${e.message}`, true); }
});
$('#dPrint').addEventListener('click', () => {
  editor.select(null);
  openJobFromDesign(structuredClone(editing.design), editing.name, editing.project);
});

// ---------- home actions ----------
$('#actLabel').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) openJobFromFile(f);
});
$('#actDesign').addEventListener('click', () => openDesigner(null));
$('#actSlip').addEventListener('click', async () => {
  const p = await ensureSlipProject();
  openJobFromDesign(structuredClone(p.design), p.name, p);
});

async function ensureSlipProject() {
  let p = settings.slipProjectId ? await projects.get(settings.slipProjectId) : null;
  if (p) return p;
  const size = sizeById('4x6');
  const design = packingSlipDesign(labelDots(size), size.id);
  p = { id: uid(), type: 'design', name: 'Packing slip', pinned: true, design, sizeId: size.id, copies: 1, created: Date.now() };
  p.thumb = await thumbFromMono((await designPages(design, 1, 0, 1))[0].mono);
  await projects.put(p);
  settings.slipProjectId = p.id; persist();
  return p;
}

// drag & drop on desktop
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && (/pdf|image/.test(f.type))) openJobFromFile(f);
});

// ---------- start ----------
async function start() {
  $('#appVersion').textContent = VERSION;
  history.replaceState({ view: 'home' }, '');
  if (!support.serial && !support.ble && !support.usb) {
    const n = $('#notice');
    n.hidden = false;
    n.textContent = 'This browser can’t talk to printers. Open ASBB Print in Chrome on Android (or Chrome/Edge on a computer) to print. You can still design and save labels here.';
  }
  if (settings.savesSinceBackup >= 5) $('#backupBanner').hidden = false;
  try { await ensureSlipProject(); } catch (e) { console.warn(e); }
  renderProjects();
  updatePrinterUi();
  printer.restore(settings.transport).catch(() => {});

  // files shared to the app from other apps (Android share menu)
  if (new URLSearchParams(location.search).has('share')) {
    history.replaceState({ view: 'home' }, '', location.pathname);
    try {
      const cache = await caches.open('asbb-share');
      const res = await cache.match('shared-file');
      if (res) {
        const blob = await res.blob();
        const name = decodeURIComponent(res.headers.get('x-file-name') || 'shared');
        await cache.delete('shared-file');
        openJobFromFile(new File([blob], name, { type: blob.type }));
      }
    } catch (e) { toast('Couldn’t open the shared file', true); }
  }
  // launch shortcuts
  const act = new URLSearchParams(location.search).get('action');
  if (act === 'slip') $('#actSlip').click();
  if (act === 'design') openDesigner(null);
  if (act === 'label') setTimeout(() => toast('Tap “Shipping label” to pick your file'), 300);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();

// exported for checks
window.__asbb = { buildTspl, packBits, findCropAreas };
