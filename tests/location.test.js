import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMove, copyLibrary, finishMove, moveTarget, PORTABLE_FOLDER, pointerPath, portableBase, resolveLocation, writePointer } from '../src/main/location.js';
import { Library, rebasePaths } from '../src/lib/library.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'genlib-loc-'));
const library = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), '{}');
};

test('portable builds are recognised from their launch markers', () => {
  assert.equal(portableBase({ PORTABLE_EXECUTABLE_DIR: 'E:/GL' }), 'E:/GL');
  assert.equal(portableBase({ APPIMAGE: '/media/usb/Generator.AppImage' }), '/media/usb');
  assert.equal(portableBase({}), '');
});

test('the installed build keeps the app-data layout; a portable one keeps data beside the app', () => {
  const root = tmp();
  const appData = path.join(root, 'appdata');
  const installed = resolveLocation({ appData, env: {} });
  assert.equal(installed.mode, 'default');
  assert.equal(installed.libraryDir, path.join(appData, 'library'));
  assert.equal(installed.profileDir, appData);

  const usb = path.join(root, 'usb');
  const portable = resolveLocation({ appData, env: { PORTABLE_EXECUTABLE_DIR: usb } });
  assert.equal(portable.mode, 'portable');
  assert.equal(portable.libraryDir, path.join(usb, PORTABLE_FOLDER));
  assert.equal(portable.profileDir, path.join(usb, PORTABLE_FOLDER, 'browser'));

  library(path.join(appData, 'library'));
  const upgraded = resolveLocation({ appData, env: { PORTABLE_EXECUTABLE_DIR: usb } });
  assert.equal(upgraded.mode, 'legacy', 'an earlier library in app-data is kept until moved');
  assert.equal(upgraded.suggested, path.join(usb, PORTABLE_FOLDER));
});

test('a pointer names the folder, relative to itself so a drive letter can change', () => {
  const root = tmp();
  const usb = path.join(root, 'usb');
  writePointer(usb, { dataDir: pointerPath(usb, path.join(usb, 'Library')) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(usb, 'data-location.json'), 'utf8')).dataDir, 'Library');
  const loc = resolveLocation({ appData: path.join(root, 'appdata'), env: { PORTABLE_EXECUTABLE_DIR: usb } });
  assert.equal(loc.mode, 'custom');
  assert.equal(loc.libraryDir, path.join(usb, 'Library'));
});

test('a move copies the library now and the browser profile at the next launch', async () => {
  const root = tmp();
  const appData = path.join(root, 'appdata');
  const old = path.join(appData, 'library');
  library(old);
  fs.mkdirSync(path.join(old, 'apps', 'a', 'bundle@v1'), { recursive: true });
  fs.writeFileSync(path.join(old, 'apps', 'a', 'bundle@v1', 'index.html'), 'hi');
  fs.mkdirSync(path.join(old, 'downloads'));
  fs.writeFileSync(path.join(old, 'downloads', 'part.zip'), 'x');
  fs.mkdirSync(path.join(old, 'apps', 'a', 'bundle@v2.staging'));
  fs.mkdirSync(path.join(appData, 'Local Storage'));
  fs.writeFileSync(path.join(appData, 'Local Storage', 'data'), 'saved');
  fs.mkdirSync(path.join(appData, 'Cache'));

  const chosen = path.join(root, 'drive');
  fs.mkdirSync(chosen);
  fs.writeFileSync(path.join(chosen, 'photo.jpg'), '');
  const target = checkMove(old, chosen);
  assert.equal(target, path.join(chosen, PORTABLE_FOLDER), 'a busy folder gets a subfolder');
  assert.throws(() => checkMove(old, old), /already/);
  assert.throws(() => checkMove(old, path.join(old, 'apps')), /outside/);

  const files = await copyLibrary(old, target);
  assert.equal(files, 2);
  assert.ok(!fs.existsSync(path.join(target, 'downloads')));
  assert.ok(!fs.existsSync(path.join(target, 'apps', 'a', 'bundle@v2.staging')));

  writePointer(appData, { dataDir: target, moveProfileFrom: pointerPath(appData, appData), removeAfterMove: pointerPath(appData, old) });
  const loc = resolveLocation({ appData, env: {} });
  const copied = finishMove(loc);
  assert.deepEqual(copied, ['Local Storage']);
  assert.equal(fs.readFileSync(path.join(target, 'browser', 'Local Storage', 'data'), 'utf8'), 'saved');
  assert.ok(!fs.existsSync(old), 'old library removed');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(appData, 'data-location.json'), 'utf8'))), ['dataDir']);
  assert.equal(finishMove(resolveLocation({ appData, env: {} })), null, 'nothing left to do');
});

test('moveTarget uses an empty folder or an existing library as is', () => {
  const root = tmp();
  assert.equal(moveTarget(path.join(root, 'new')), path.join(root, 'new'));
  library(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'other'), '');
  assert.equal(moveTarget(path.join(root, 'lib')), path.join(root, 'lib'));
});

test('the library rewrites its paths when its folder has moved', async () => {
  const p = (...parts) => path.join(path.sep, ...parts);
  assert.deepEqual(rebasePaths({ a: [p('old', 'apps', 'x'), p('elsewhere', 'y')], b: 2 }, p('old'), p('new')), { a: [p('new', 'apps', 'x'), p('elsewhere', 'y')], b: 2 });
  const root = tmp();
  const before = path.join(root, 'E');
  const lib = new Library(before);
  await lib.load();
  await lib.setInstalled({ id: 'a', distKey: 'bundle', version: 'v1', dir: path.join(before, 'apps', 'a', 'bundle@v1') });
  fs.renameSync(before, path.join(root, 'F'));
  const after = new Library(path.join(root, 'F'));
  await after.load();
  assert.equal(after.getInstalled('a', 'bundle').dir, path.join(root, 'F', 'apps', 'a', 'bundle@v1'));
  assert.equal(after.state.root, path.join(root, 'F'));
});
