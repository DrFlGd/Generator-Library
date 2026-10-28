// Register gridfinity-rebuilt as one of the playground's bundled libraries. Run in the
// openscad-playground checkout. Fails loudly if the upstream files change shape.
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('libs-config.json', 'utf8'));
config.libraries.push({
  name: 'gridfinity-rebuilt',
  repo: 'https://github.com/kennetek/gridfinity-rebuilt-openscad.git',
  branch: 'main',
  zipIncludes: ['*.scad', 'src/**/*.scad', 'LICENSE'],
});
fs.writeFileSync('libs-config.json', JSON.stringify(config, null, 4));

const archivesPath = 'src/fs/zip-archives.ts';
const archives = fs.readFileSync(archivesPath, 'utf8');
const marker = '\n};\n\nexport const deployedArchiveNames';
if (!archives.includes(marker)) throw new Error(`${archivesPath} changed; update add-library.mjs`);
const entry = `
  'gridfinity-rebuilt': {
    description: 'Gridfinity Rebuilt in OpenSCAD',
    gitOrigin: {
      branch: 'main',
      repoUrl: 'https://github.com/kennetek/gridfinity-rebuilt-openscad',
      include: [{glob: ['*.scad', 'src/**/*.scad', 'LICENSE']}],
    },
    // The generators open from "/", and include "src/core/...".
    symlinks: {'src': 'src'},
  },`;
fs.writeFileSync(archivesPath, archives.replace(marker, entry + marker));
