// The page around GenerateSTL's engine: a form for each part type, a 3D
// preview and the download. worker.js runs the engine; this file only reads
// the inputs, shows what comes back and saves the file.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PARTS } from './parts.js';

const SAVED = 'generatestl-inputs';
const $ = (id) => document.getElementById(id);

// ─── inputs ───

let saved = { part: PARTS[0].id, values: {} };
try {
  saved = { ...saved, ...JSON.parse(localStorage.getItem(SAVED) ?? '{}') };
} catch {
  /* storage is optional */
}
function store() {
  try {
    localStorage.setItem(SAVED, JSON.stringify(saved));
  } catch {
    /* storage is optional */
  }
}

let part = PARTS.find((p) => p.id === saved.part) ?? PARTS[0];
const rows = new Map();

function defaults(p) {
  return Object.fromEntries(p.fields.map((f) => [f.key, f.value]));
}
function values() {
  return { ...defaults(part), ...(saved.values[part.id] ?? {}) };
}

function control(f, value) {
  const id = `f-${f.key}`;
  if (f.type === 'select') {
    const select = Object.assign(document.createElement('select'), { id });
    for (const [option, text] of f.options) select.append(new Option(text, String(option)));
    select.selectedIndex = Math.max(0, f.options.findIndex(([option]) => option === value));
    return [select, () => f.options[select.selectedIndex][0]];
  }
  if (f.type === 'check') {
    const box = Object.assign(document.createElement('input'), { id, type: 'checkbox', checked: Boolean(value) });
    return [box, () => box.checked];
  }
  const input = Object.assign(document.createElement('input'), { id, type: 'number', inputMode: 'decimal', step: String(f.step), value: String(value) });
  const wrap = document.createElement('span');
  wrap.className = 'unit';
  wrap.dataset.unit = f.unit;
  wrap.append(input);
  return [wrap, () => input.valueAsNumber, input];
}

function render() {
  const current = values();
  rows.clear();
  const basic = [];
  const advanced = [];
  for (const f of part.fields) {
    const row = document.createElement('div');
    row.className = 'field';
    const label = Object.assign(document.createElement('label'), { htmlFor: `f-${f.key}`, textContent: f.label });
    const [element, read, input = element] = control(f, current[f.key]);
    const note = Object.assign(document.createElement('small'), { textContent: f.hint ?? '' });
    row.append(label, element, note);
    rows.set(f.key, { f, row, read, input, note });
    (f.advanced ? advanced : basic).push(row);
  }
  $('basic').replaceChildren(...basic);
  $('advanced').replaceChildren(...advanced);
  $('more').hidden = advanced.length === 0;
  showFields();
}

function read() {
  const out = {};
  for (const [key, { read: get }] of rows) out[key] = get();
  return out;
}

function showFields() {
  const v = read();
  for (const { f, row } of rows.values()) row.hidden = Boolean(f.when && !f.when(v));
}

// What the engine is asked for: the part type and every shown field.
function request() {
  const v = read();
  const payload = { gear_type: part.id };
  const bad = [];
  for (const [key, { f, row }] of rows) {
    if (row.hidden) continue;
    if (typeof v[key] === 'number' && !Number.isFinite(v[key])) bad.push(key);
    else payload[key] = v[key];
  }
  return { payload, bad, values: v };
}

// ─── problems ───

const LABELS = new Map(PARTS.flatMap((p) => p.fields.map((f) => [f.key, f.label.toLowerCase()])));
function words(message) {
  return message
    .replace(/\bradiopoligono\b/g, 'the space inside the teeth')
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (word) => (/_|[a-z][A-Z]/.test(word) || ['d', 'z', 'z2', 'ap', 'ah', 'x'].includes(word) ? (LABELS.get(word) ?? word) : word));
}

function showProblems(errors) {
  const general = [];
  for (const { input, note, f } of rows.values()) {
    input.setAttribute('aria-invalid', 'false');
    note.textContent = f.hint ?? '';
    note.classList.remove('error');
  }
  for (const { fields, message } of errors) {
    const shown = fields.map((key) => rows.get(key)).filter((r) => r && !r.row.hidden);
    if (!shown.length) {
      general.push(words(message));
      continue;
    }
    for (const r of shown) {
      r.input.setAttribute('aria-invalid', 'true');
      r.note.textContent = words(message.charAt(0).toUpperCase() + message.slice(1));
      r.note.classList.add('error');
      if (r.f.advanced) $('more').open = true;
    }
  }
  $('problem').hidden = errors.length === 0;
  $('problem').textContent = errors.length ? (general.length ? general.join(' ') : 'Fix the highlighted values to make this part.') : '';
}

// ─── preview ───

const canvas = $('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.1, 10000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.6));
const light = new THREE.DirectionalLight(0xffffff, 1.8);
camera.add(light);
light.position.set(1, 1, 2);
scene.add(camera);
const material = new THREE.MeshStandardMaterial({ color: 0x8aa4c8, metalness: 0.05, roughness: 0.55, flatShading: false });
const model = new THREE.Group();
scene.add(model);
const loader = new STLLoader();

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
renderer.setAnimationLoop(() => {
  resize();
  controls.update();
  renderer.render(scene, camera);
});

let framedPart = '';
function show(parts) {
  for (const child of [...model.children]) child.geometry.dispose();
  model.clear();
  // Several files (a screw set, a box and lid) sit side by side.
  let x = 0;
  for (const { data } of parts) {
    const geometry = loader.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    geometry.translate(x - box.min.x, -(box.min.y + box.max.y) / 2, -box.min.z);
    x += box.max.x - box.min.x + Math.max(4, (box.max.x - box.min.x) * 0.15);
    model.add(new THREE.Mesh(geometry, material));
  }
  const bounds = new THREE.Box3().setFromObject(model);
  const centre = bounds.getCenter(new THREE.Vector3());
  model.position.x -= centre.x;
  model.position.y -= centre.y;
  const size = bounds.getSize(new THREE.Vector3());
  // Keep the view while the same part changes size a little; frame anew otherwise.
  if (framedPart !== part.id || !controls.userMoved) {
    const radius = Math.max(size.x, size.y, size.z) * 0.75 || 10;
    controls.target.set(0, 0, size.z / 2);
    camera.position.set(radius * 1.3, -radius * 2, radius * 1.6 + size.z / 2);
    framedPart = part.id;
    controls.userMoved = false;
  }
  return size;
}
controls.addEventListener('start', () => {
  controls.userMoved = true;
});

// ─── generating ───

const worker = new Worker('worker.js');
let ready = false;
let busy = false;
let wanted = null;
let next = 0;
let latest = 0;
let result = null;

function status(text) {
  $('status').textContent = text;
}

function send() {
  if (!ready || busy || !wanted) return;
  busy = true;
  latest = ++next;
  worker.postMessage({ id: latest, payload: wanted });
  wanted = null;
  status('Making the part…');
}

worker.onmessage = ({ data }) => {
  if (data.ready) {
    ready = true;
    status('Ready.');
    send();
    return;
  }
  if (data.failed) {
    status('');
    showProblems([{ fields: [], message: `The generator could not start: ${data.failed}` }]);
    return;
  }
  busy = false;
  if (wanted) {
    send(); // the inputs changed while this one was being made
    return;
  }
  if (data.errors) {
    result = null;
    $('download').disabled = true;
    showProblems(data.errors);
    status('');
    document.body.dataset.state = 'problem';
    return;
  }
  showProblems([]);
  result = data;
  const size = show(data.parts);
  const triangles = data.parts.reduce((n, p) => n + new DataView(p.data.buffer, p.data.byteOffset).getUint32(80, true), 0);
  const rowsOut = [
    ['File', data.name],
    ['Contains', data.parts.length > 1 ? data.parts.map((p) => p.name).join(', ') : 'One STL'],
    ['Size', `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm${data.parts.length > 1 ? ' (all parts, side by side)' : ''}`],
    ['Triangles', triangles.toLocaleString()],
  ];
  $('stats').replaceChildren(...rowsOut.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]));
  $('download').disabled = false;
  $('download').textContent = data.name.endsWith('.zip') ? 'Download ZIP' : 'Download STL';
  status('');
  document.body.dataset.state = 'done';
};

let timer = 0;
function update() {
  showFields();
  const { payload, bad, values: v } = request();
  saved.values[part.id] = v;
  store();
  $('download').disabled = true;
  document.body.dataset.state = 'working';
  if (bad.length) {
    showProblems(bad.map((key) => ({ fields: [key], message: 'Enter a number.' })));
    document.body.dataset.state = 'problem';
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    wanted = payload;
    send();
  }, 350);
}

function download() {
  if (!result) return;
  const blob = new Blob([result.data], { type: result.name.endsWith('.zip') ? 'application/zip' : 'model/stl' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: result.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const select = $('part');
for (const group of [...new Set(PARTS.map((p) => p.group))]) {
  const optgroup = Object.assign(document.createElement('optgroup'), { label: group });
  for (const p of PARTS.filter((q) => q.group === group)) optgroup.append(new Option(p.name, p.id));
  select.append(optgroup);
}
select.value = part.id;
select.addEventListener('change', () => {
  part = PARTS.find((p) => p.id === select.value);
  saved.part = part.id;
  render();
  update();
});
$('form').addEventListener('input', (event) => {
  if (event.target !== select) update();
});
$('form').addEventListener('submit', (e) => e.preventDefault());
$('reset').addEventListener('click', () => {
  delete saved.values[part.id];
  render();
  update();
});
$('download').addEventListener('click', download);
render();
update();
