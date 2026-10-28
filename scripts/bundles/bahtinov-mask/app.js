// The page around MartynAllen/bahtinov-mask-generator's engine. The engine does
// all the geometry and the STL; this file reads the inputs, draws the mask from
// above and saves the file. bahtinov-mask.sh copies it into the engine's
// checkout, so the imports below are the repository's own sources.
import { computeBahtinovGeometry, DEFAULT_ADVANCED, validateBahtinovInputs } from './src/geometry.ts';
import { buildMaskMesh, serializeStlAscii, suggestedFilename } from './src/stl.ts';

const BASIC = [
  { key: 'focalLengthMm', label: 'Focal length', unit: 'mm', value: 900, step: 1 },
  { key: 'apertureMm', label: 'Aperture', unit: 'mm', value: 102, step: 0.5, hint: 'The clear opening of the objective or front lens.' },
  { key: 'tubeOuterDiameterMm', label: 'Tube outer diameter', unit: 'mm', value: 108, step: 0.5, hint: 'Measured where the mask slides on, including any dew shield.' },
  { key: 'rimWidthMm', label: 'Rim width', unit: 'mm', value: 6, step: 0.5, hint: 'Thickness of the collar wall around the tube.' },
];
const ADVANCED = [
  { key: 'maskThicknessMm', label: 'Mask thickness', unit: 'mm', step: 0.5 },
  { key: 'slitsPerGroup', label: 'Slits per group', unit: '', step: 1 },
  { key: 'strutWidthPercent', label: 'Strut width', unit: '%', step: 1, hint: 'Share of each slit pitch that is solid.' },
  { key: 'offsetAngleDeg', label: 'Offset angle', unit: '°', step: 0.5, hint: 'Angle of the two side gratings.' },
  { key: 'fitClearanceMm', label: 'Fit clearance', unit: 'mm', step: 0.1, hint: 'Gap between collar and tube; raise it if the print is tight.' },
  { key: 'skirtDepthMm', label: 'Collar depth', unit: 'mm', step: 1 },
  { key: 'spineWidthMm', label: 'Spine width', unit: 'mm', step: 0.5 },
  { key: 'dividerWidthMm', label: 'Divider width', unit: 'mm', step: 0.5 },
].map((f) => ({ ...f, value: DEFAULT_ADVANCED[f.key] }));
const FIELDS = [...BASIC, ...ADVANCED];
const SAVED = 'bahtinov-mask-inputs';

const $ = (id) => document.getElementById(id);
const inputs = new Map();

function field(f) {
  const id = `f-${f.key}`;
  const row = document.createElement('div');
  row.className = 'field';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = f.label;
  const wrap = document.createElement('span');
  wrap.className = 'unit';
  wrap.dataset.unit = f.unit;
  const input = document.createElement('input');
  Object.assign(input, { id, type: 'number', inputMode: 'decimal', step: String(f.step), value: String(f.value) });
  wrap.append(input);
  const note = document.createElement('small');
  note.textContent = f.hint ?? '';
  note.dataset.hint = f.hint ?? '';
  row.append(label, wrap, note);
  inputs.set(f.key, { input, note });
  return row;
}

function read() {
  return Object.fromEntries(FIELDS.map((f) => [f.key, inputs.get(f.key).input.valueAsNumber]));
}

function save(values) {
  try {
    localStorage.setItem(SAVED, JSON.stringify(values));
  } catch {
    /* storage is optional */
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) ?? '{}');
    for (const [key, value] of Object.entries(saved)) if (inputs.has(key) && Number.isFinite(value)) inputs.get(key).input.value = String(value);
  } catch {
    /* storage is optional */
  }
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}
const circle = (r) => `M ${r} 0 A ${r} ${r} 0 1 0 ${-r} 0 A ${r} ${r} 0 1 0 ${r} 0 Z`;
const poly = (corners) => `M ${corners.map(([x, y]) => `${x} ${-y}`).join(' L ')} Z`;

function draw(geometry) {
  const view = $('preview');
  const r = geometry.wallOuterRadiusMm * 1.04;
  view.setAttribute('viewBox', `${-r} ${-r} ${2 * r} ${2 * r}`);
  // The wall ring is one path with its hole; the slats, spine and divider sit on top.
  const parts = [svg('path', { class: 'plate', d: `${circle(geometry.wallOuterRadiusMm)} ${circle(geometry.wallFillInnerRadiusMm)}` })];
  for (const s of [geometry.spine, geometry.divider, ...geometry.struts]) parts.push(svg('path', { class: 'plate', d: poly(s.corners) }));
  parts.push(svg('circle', { class: 'tube', r: geometry.wallInnerRadiusMm, 'vector-effect': 'non-scaling-stroke' }));
  view.replaceChildren(...parts);
}

function stats(values, geometry) {
  const rows = [
    ['Focal ratio', `f/${geometry.focalRatio.toFixed(1)}`],
    ['Mask outside diameter', `${(geometry.wallOuterRadiusMm * 2).toFixed(1)} mm`],
    ['Collar inside diameter', `${(geometry.wallInnerRadiusMm * 2).toFixed(1)} mm`],
    ['Height', `${(values.maskThicknessMm + values.skirtDepthMm).toFixed(1)} mm`],
    ['Slats', String(geometry.struts.length)],
  ];
  $('stats').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
}

let current = null;
function update() {
  const values = read();
  const errors = validateBahtinovInputs(values);
  for (const [key, { input, note }] of inputs) {
    const error = errors[key];
    input.setAttribute('aria-invalid', error ? 'true' : 'false');
    note.textContent = error ?? note.dataset.hint;
    note.classList.toggle('error', Boolean(error));
  }
  const bad = Object.keys(errors).length > 0;
  $('download').disabled = bad;
  $('problem').hidden = !bad;
  $('problem').textContent = bad ? 'Fix the highlighted values to see the mask.' : '';
  current = null;
  if (bad) return;
  try {
    const geometry = computeBahtinovGeometry(values);
    current = { values, geometry };
    draw(geometry);
    stats(values, geometry);
    save(values);
  } catch (error) {
    $('download').disabled = true;
    $('problem').hidden = false;
    $('problem').textContent = `These sizes do not make a mask: ${error.message}`;
  }
}

function download() {
  if (!current) return;
  const { values, geometry } = current;
  const mesh = buildMaskMesh(geometry, values.maskThicknessMm, values.skirtDepthMm);
  const blob = new Blob([serializeStlAscii(mesh, 'bahtinov-mask')], { type: 'model/stl' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: suggestedFilename(values) });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$('basic').append(...BASIC.map(field));
$('advanced').append(...ADVANCED.map(field));
restore();
$('form').addEventListener('input', update);
$('form').addEventListener('submit', (e) => e.preventDefault());
$('reset').addEventListener('click', () => {
  for (const f of ADVANCED) inputs.get(f.key).input.value = String(f.value);
  update();
});
$('download').addEventListener('click', download);
update();
