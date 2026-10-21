'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const ROOT_DIR = path.resolve(__dirname, '..');
for (const directory of ['public', 'src/server', 'scripts']) {
  for (const file of fs.readdirSync(path.join(ROOT_DIR, directory)).filter((name) => name.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', path.join(ROOT_DIR, directory, file)], { stdio: 'inherit' });
  }
}
JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'public/manifest.webmanifest'),'utf8'));
console.log('All JavaScript syntax and manifest checks passed.');
