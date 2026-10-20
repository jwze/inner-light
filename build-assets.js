'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
fs.mkdirSync(path.join(__dirname, 'vendor'), { recursive: true });
buildSync({ entryPoints: [require.resolve('qrcode/lib/browser.js')], bundle: true, minify: true, platform: 'browser', format: 'iife', globalName: 'QRCode', outfile: path.join(__dirname, 'vendor/qrcode.js') });
// Tiny deterministic PNG encoder for installable bitmap icons (no native image dependency).
const zlib = require('node:zlib');
function crc32(buffer) { let crc = -1; for (const byte of buffer) { crc ^= byte; for (let j=0;j<8;j++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } return (crc^-1)>>>0; }
function chunk(type,data) { const tag=Buffer.from(type), length=Buffer.alloc(4), sum=Buffer.alloc(4); length.writeUInt32BE(data.length); sum.writeUInt32BE(crc32(Buffer.concat([tag,data]))); return Buffer.concat([length,tag,data,sum]); }
for (const size of [192,512]) {
  const raw=Buffer.alloc((size*4+1)*size); for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const dx=x-size/2,dy=y-size/2,r=Math.hypot(dx,dy), line=Math.min(Math.abs(dx),Math.abs(dy),Math.abs(dx-dy)/Math.SQRT2,Math.abs(dx+dy)/Math.SQRT2);
    const star=r<size*.34&&line<size*.012,ring=Math.abs(r-size*.27)<size*.007,center=r<size*.055;
    const color=star||ring||center?[145,234,221]:[17,18,37];const i=y*(size*4+1)+1+x*4;raw[i]=color[0];raw[i+1]=color[1];raw[i+2]=color[2];raw[i+3]=255;
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  fs.writeFileSync(path.join(__dirname,`vendor/icon-${size}.png`),Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
}
const crypto = require('node:crypto');
const hash = crypto.createHash('sha256');
for (const file of fs.readdirSync(__dirname).filter((name) => /\.(js|css|html|webmanifest|svg)$/.test(name)).sort()) hash.update(file).update(fs.readFileSync(path.join(__dirname,file)));
fs.writeFileSync(path.join(__dirname,'vendor/version.js'), `self.INNER_LIGHT_ASSET_VERSION=${JSON.stringify(hash.digest('hex').slice(0,16))};`);
