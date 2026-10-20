#!/usr/bin/env node
// Pack gleaner-mcp/ into a Claude Desktop extension (MCP Bundle): a zip with manifest.json and server.mjs at its
// root. Double-click the file, or drag it into Claude → Settings → Extensions, to install it.
//   node scripts/pack-mcpb.mjs [out-dir]   (default: gleaner-mcp/dist)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'gleaner-mcp');
const FILES = ['manifest.json', 'server.mjs', 'README.md'];

export function packMcpb(outDir = path.join(SRC, 'dist')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const zip = new AdmZip();
  for (const f of FILES) zip.addLocalFile(path.join(SRC, f));
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `gleaner-${manifest.version}.mcpb`);
  zip.writeZip(out);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(packMcpb(process.argv[2]));
