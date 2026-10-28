// The engine's part types and the inputs each one takes, named for people.
// Keys are the engine's request fields (app/schemas.py); a field is sent only
// while it is shown, so hidden ones fall back to the engine's own defaults.

const num = (key, label, value, extra = {}) => ({ key, label, value, type: 'number', unit: 'mm', step: 0.1, ...extra });
const int = (key, label, value, extra = {}) => ({ key, label, value, type: 'number', unit: '', step: 1, ...extra });
const pick = (key, label, value, options, extra = {}) => ({ key, label, value, type: 'select', options, ...extra });
const check = (key, label, value, extra = {}) => ({ key, label, value, type: 'check', ...extra });

const HOLES = [
  ['None', 'None (solid)'],
  ['Hollow', 'Rim only (open just inside the teeth)'],
  ['SQR', 'Square'],
  ['HEX', 'Hexagon'],
  ['CIR', 'Round'],
  ['KW', 'Round with keyway'],
];

function hole(prefix, label, initial) {
  const type = `${prefix}hole_type`;
  const is = (kind) => (v) => v[type] === kind;
  return [
    pick(type, label, initial, HOLES),
    num(`${prefix}SqrCR`, 'Square size, centre to corner', 4, { when: is('SQR') }),
    num(`${prefix}HexCR`, 'Hexagon size, centre to corner', 4, { when: is('HEX') }),
    num(`${prefix}CirCR`, 'Hole radius', 4, { when: is('CIR') }),
    num(`${prefix}KwF_Bore`, 'Bore diameter', 8, { when: is('KW') }),
    num(`${prefix}KwF_Width`, 'Keyway width', 2, { when: is('KW') }),
    num(`${prefix}KwF_B_plus_kwD`, 'Bore plus keyway depth', 9.3, { when: is('KW'), hint: 'From the far side of the bore to the bottom of the keyway.' }),
  ];
}

const MODULE = num('modulo', 'Module', 2, { hint: 'Tooth size: the pitch diameter is module × teeth. Gears that mesh share module and pressure angle.' });
const TEETH = int('z', 'Teeth', 24);
const PRESSURE = num('ap', 'Pressure angle', 20, { unit: '°', step: 0.5, advanced: true });
const THICKNESS = num('height', 'Thickness', 10);
const SHIFT = num('x', 'Profile shift', 0, { unit: '× m', step: 0.05, advanced: true, hint: 'Moves the teeth outward (positive) or inward. 0 suits most gears.' });
const helix = (angle) => [
  num('ah', 'Helix angle', angle, { unit: '°', step: 0.5 }),
  check('CBClockWise', 'Teeth twist clockwise', true, { hint: 'Two helical gears that mesh twist opposite ways.' }),
  pick('HelicalSystem', 'Module measured', 'Radial', [['Radial', 'In the plane of the gear (transverse)'], ['Normal', 'Square to the teeth (normal)']], { advanced: true }),
];
const OUTSIDE = num('outDiam', 'Outside diameter', 80, { hint: 'Of the ring that holds the teeth.' });
const external = (...extra) => [MODULE, TEETH, THICKNESS, ...extra, ...hole('', 'Centre hole', 'None'), PRESSURE, SHIFT];
const internal = (...extra) => [MODULE, TEETH, THICKNESS, OUTSIDE, ...extra, PRESSURE, SHIFT];

const RESOLUTION = pick('resolution', 'Smoothness', 3, [[1, 'Draft'], [2, 'Medium'], [3, 'Fine'], [4, 'Very fine']], { advanced: true });
const MAKE = (options, value = 'all') => pick('display', 'Make', value, options);

const ROD = (v) => v.display === 'rod' || v.display === 'all';
const NUT = (v) => v.display === 'nut' || v.display === 'all';
const WASHER = (v) => v.display === 'washer' || v.display === 'all';
const HEADED = (v) => ROD(v) && v.head !== 'none';
const DRIVEN = (v) => HEADED(v) && v.drive !== 'none';
const SIDES = [['none', 'Neither'], ['top', 'Top'], ['bottom', 'Bottom'], ['both', 'Both']];

const SLATS = (v) => v.pattern === 'slats';
const HOLED = (v) => v.pattern === 'hex' || v.pattern === 'circles';
const RECT = (v) => v.shape === 'rect';

export const PARTS = [
  { group: 'Gears', id: 'Spur', name: 'Spur gear', fields: external() },
  { group: 'Gears', id: 'Helical', name: 'Helical gear', fields: external(...helix(20)) },
  { group: 'Gears', id: 'DblHelical', name: 'Herringbone gear', fields: external(...helix(30)) },
  { group: 'Gears', id: 'IntSpur', name: 'Internal (ring) gear', fields: internal() },
  { group: 'Gears', id: 'IntHelical', name: 'Internal helical gear', fields: internal(...helix(20)) },
  { group: 'Gears', id: 'IntDblHelical', name: 'Internal herringbone gear', fields: internal(...helix(30)) },
  {
    group: 'Gears',
    id: 'Rack',
    name: 'Gear rack',
    fields: [
      MODULE,
      pick('rack_length', 'Length set by', 'TEETH', [['TEETH', 'Number of teeth'], ['DIST', 'Length']]),
      int('z', 'Teeth', 20, { when: (v) => v.rack_length === 'TEETH' }),
      num('RackL', 'Length', 100, { when: (v) => v.rack_length === 'DIST' }),
      num('height', 'Body height', 8, { hint: 'The solid strip below the teeth.' }),
      num('width', 'Thickness', 10),
      PRESSURE,
    ],
  },
  {
    group: 'Gears',
    id: 'Bevel',
    name: 'Bevel gear pair (90°)',
    fields: [MODULE, int('z', 'Wheel teeth', 30), int('z2', 'Pinion teeth', 15), ...hole('wheel_', 'Wheel hole', 'Hollow'), ...hole('pinion_', 'Pinion hole', 'Hollow'), PRESSURE],
  },
  {
    group: 'Fasteners',
    id: 'Screw',
    name: 'Screw, nut and washer',
    fields: [
      MAKE([['all', 'Screw, nut and washer'], ['rod', 'Screw or threaded rod'], ['nut', 'Nut'], ['washer', 'Washer']]),
      num('d', 'Thread diameter', 8),
      num('pitch', 'Thread pitch', 1.25, { step: 0.05 }),
      pick('profile', 'Thread profile', 'triangular', [['triangular', 'Metric (60°)'], ['trapezoidal', 'Trapezoidal'], ['acme', 'Acme'], ['buttress', 'Buttress'], ['square', 'Square']]),
      num('length', 'Screw length', 30, { when: ROD }),
      pick('head', 'Head', 'hex', [['none', 'None (threaded rod)'], ['hex', 'Hex'], ['socket', 'Socket cap'], ['button', 'Button'], ['pan', 'Pan'], ['cheese', 'Cheese'], ['flat', 'Flat (countersunk)']], { when: ROD }),
      num('head_diameter', 'Head diameter', 13, { when: HEADED }),
      num('head_height', 'Head height', 5.3, { when: (v) => HEADED(v) && v.head !== 'flat' }),
      pick('drive', 'Drive', 'none', [['none', 'None'], ['hex', 'Hex socket'], ['torx', 'Torx']], { when: HEADED }),
      num('drive_size', 'Drive size', 4, { when: DRIVEN, hint: 'Across the flats for a hex key.' }),
      num('drive_depth', 'Drive depth', 3, { when: DRIVEN }),
      pick('nut_shape', 'Nut shape', 'hex', [['hex', 'Hex'], ['square', 'Square'], ['round', 'Round']], { when: NUT }),
      num('nut_width', 'Nut width', 13, { when: NUT, hint: 'Across the flats; the diameter for a round nut.' }),
      num('nut_thickness', 'Nut thickness', 6.5, { when: NUT }),
      num('washer_id', 'Washer hole', 8.4, { when: WASHER }),
      num('washer_od', 'Washer outside diameter', 16, { when: WASHER }),
      num('washer_height', 'Washer thickness', 1.6, { when: WASHER }),
      int('starts', 'Thread starts', 1, { advanced: true }),
      check('left_handed', 'Left-handed thread', false, { advanced: true }),
      pick('blunt_start', 'Blunt thread start', 'both', SIDES, { advanced: true, when: ROD }),
      num('end_length', 'Plain shank at the tip', 0, { advanced: true, when: ROD }),
      pick('rod_bevel', 'Bevelled rod ends', 'none', SIDES, { advanced: true, when: ROD }),
      num('undersize', 'Print undersize', 0, { step: 0.05, advanced: true, hint: 'Shrinks the screw thread to make up for over-extrusion.' }),
      num('nut_clearance', 'Nut clearance', 0.12, { step: 0.01, advanced: true, when: NUT }),
      pick('nut_bevel', 'Nut bevels', 'auto', [['auto', 'Automatic'], ['none', 'None'], ['inside', 'Inside'], ['outside', 'Outside'], ['both', 'Both']], { advanced: true, when: NUT }),
      num('nut_chamfer', 'Nut chamfer', 0.2, { unit: '', step: 0.05, advanced: true, when: NUT }),
      check('nut_flush', 'Flat nut bottom (no bevels underneath)', false, { advanced: true, when: NUT }),
      num('washer_chamfer', 'Washer chamfer', 0, { unit: '', step: 0.05, advanced: true, when: WASHER }),
      RESOLUTION,
    ],
  },
  {
    group: 'Other parts',
    id: 'Bearing',
    name: 'Print-in-place bearing',
    fields: [
      pick('rings', 'Rings', 2, [[2, 'Two'], [3, 'Three']]),
      num('outer_diameter', 'Outside diameter', 40),
      num('bore_diameter', 'Bore diameter', 10),
      num('width', 'Width', 10),
      num('clearance', 'Clearance', 0.3, { step: 0.05, advanced: true }),
    ],
  },
  {
    group: 'Other parts',
    id: 'Box',
    name: 'Box with lid',
    fields: [
      MAKE([['all', 'Box and lid'], ['box', 'Box'], ['lid', 'Lid']]),
      num('box_width', 'Width', 100),
      num('box_depth', 'Depth', 60),
      num('box_height', 'Height', 40),
      num('wall', 'Wall thickness', 1.6),
      num('bottom', 'Bottom thickness', 1.6, { advanced: true }),
      num('lid_thickness', 'Lid thickness', 1.6, { advanced: true }),
      num('lip_height', 'Lid lip height', 6, { advanced: true }),
      num('lid_clearance', 'Lid clearance', 0.2, { step: 0.05, advanced: true }),
    ],
  },
  {
    group: 'Other parts',
    id: 'Grille',
    name: 'Vent grille',
    fields: [
      pick('shape', 'Shape', 'rect', [['rect', 'Rectangle'], ['round', 'Round']]),
      num('grille_width', 'Width', 120, { when: RECT }),
      num('grille_depth', 'Depth', 120, { when: RECT }),
      num('diameter', 'Diameter', 120, { when: (v) => v.shape === 'round' }),
      num('frame_width', 'Frame width', 8),
      num('thickness', 'Thickness', 3),
      pick('pattern', 'Pattern', 'slats', [['slats', 'Slats'], ['hex', 'Hexagons'], ['circles', 'Circles'], ['solid', 'Solid (blank cover)']]),
      num('slat_width', 'Slat width', 3, { when: SLATS }),
      num('slat_gap', 'Gap between slats', 6, { when: SLATS }),
      num('slot_length', 'Slot length', 40, { when: SLATS }),
      pick('slat_direction', 'Slats run', 'vertical', [['vertical', 'Vertically'], ['horizontal', 'Horizontally']], { when: SLATS }),
      num('hole_size', 'Hole size', 8, { when: HOLED }),
      num('hole_spacing', 'Hole spacing', 11, { when: HOLED }),
      pick('mount_holes', 'Mounting holes', 0, [[0, 'None'], [4, 'Four, countersunk']], { when: RECT }),
      num('mount_hole_d', 'Mounting hole diameter', 4.5, { when: (v) => RECT(v) && v.mount_holes === 4 }),
    ],
  },
  {
    group: 'Other parts',
    id: 'Pegboard',
    name: 'Pegboard and screws',
    fields: [
      MAKE([['all', 'Board and screw'], ['board', 'Board'], ['screw', 'Screw']]),
      int('columns', 'Columns', 4, { hint: 'Holes on a 24 mm grid.' }),
      int('rows', 'Rows', 4),
      num('thickness', 'Board thickness', 8),
      check('threaded', 'Threaded holes', true),
      pick('screw_style', 'Screw', 'standard', [['standard', 'Standard'], ['lowprofile', 'Low profile']]),
      RESOLUTION,
    ],
  },
];
