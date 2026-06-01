// Generate public/favicon.ico from the HWPL logo.
// Uses macOS's built-in `sips` to resize, then wraps the PNG in a minimal
// ICO container (PNG-in-ICO is supported by all modern browsers).
//
//   node tools/create-favicon.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT    = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGO    = join(ROOT, 'public', 'brand', 'HW PickleBall Logo.png');
const OUT_ICO = join(ROOT, 'public', 'favicon.ico');
const TMP_PNG = join(tmpdir(), 'hwpl-favicon-32.png');

// Resize to 32×32, keeping aspect ratio with transparent padding if needed.
execSync(`sips -s format png -Z 32 "${LOGO}" --out "${TMP_PNG}"`, { stdio: 'pipe' });

const png = readFileSync(TMP_PNG);

// Minimal ICO container: 6-byte file header + 16-byte directory entry + PNG data.
// The PNG is embedded as-is (PNG-in-ICO). Chrome, Firefox, Safari, Edge all support this.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);  // reserved
header.writeUInt16LE(1, 2);  // type: 1 = ICO
header.writeUInt16LE(1, 4);  // image count: 1

const dir = Buffer.alloc(16);
dir.writeUInt8(32, 0);                    // width  (32px)
dir.writeUInt8(32, 1);                    // height (32px)
dir.writeUInt8(0, 2);                     // palette size: 0 (true-colour)
dir.writeUInt8(0, 3);                     // reserved
dir.writeUInt16LE(1, 4);                  // colour planes
dir.writeUInt16LE(32, 6);                 // bits per pixel
dir.writeUInt32LE(png.length, 8);         // size of embedded PNG
dir.writeUInt32LE(6 + 16, 12);           // byte offset to PNG (right after header + dir)

writeFileSync(OUT_ICO, Buffer.concat([header, dir, png]));
console.log(`Created public/favicon.ico (${png.length + 22} bytes, 32×32 PNG-in-ICO)`);
