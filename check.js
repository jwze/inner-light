'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith('.js'))) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
JSON.parse(fs.readFileSync('manifest.webmanifest','utf8'));
console.log('All JavaScript syntax and manifest checks passed.');
