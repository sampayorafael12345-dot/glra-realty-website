#!/usr/bin/env node
// Pre-upload safety check:  npm run check
//
// 1. Syntax-checks every server file (server.js, server/*.js, scripts/*.js)
//    and every browser script (public/**/*.js, vendor files skipped).
// 2. Parses every inline <script> in every public/**/*.html page, the way a
//    browser would. One syntax error in an inline script once took the
//    dashboard and both listing pages down for 20 hours; this catches it.
// 3. Checks every <script type="application/ld+json"> block is valid JSON
//    (Google ignores a page's structured data if it is not).
//
// It changes nothing. Exit code 0 = all good, 1 = something to fix.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const problems = [];
let checked = 0;

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'vendor' || e.name === 'uploads') continue;
      walk(p, ext, out);
    } else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');

// Line number inside the file for an error raised while parsing a snippet.
function errLine(err, offsetLine) {
  const m = /:(\d+)\s*$/m.exec(String(err.stack || '').split('\n')[0]);
  return m ? offsetLine + Number(m[1]) - 1 : offsetLine;
}

function checkJs(file) {
  checked++;
  const src = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
  try {
    // Wrapped like Node's CommonJS loader, so top-level `return` and
    // `require` are fine, exactly as `node --check` treats them.
    new vm.Script('(function (exports, require, module, __filename, __dirname) {' + src + '\n})', { filename: rel(file) });
  } catch (e) {
    problems.push(`${rel(file)}: ${e.message}`);
  }
}

function checkHtml(file) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const line = html.slice(0, m.index).split('\n').length;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '';
    if (/\bsrc\s*=/.test(attrs) && !body.trim()) continue;
    if (!body.trim()) continue;
    checked++;
    if (/ld\+json/i.test(type)) {
      try { JSON.parse(body); } catch (e) { problems.push(`${rel(file)}:${line} JSON-LD: ${e.message}`); }
      continue;
    }
    if (type && !/^(text|application)\/(javascript|ecmascript)$/i.test(type) && type !== 'module') continue; // templates etc.
    try {
      if (type === 'module') {
        if (typeof vm.SourceTextModule === 'function') new vm.SourceTextModule(body);
      } else {
        new vm.Script(body, { filename: `${rel(file)}:${line}` });
      }
    } catch (e) {
      problems.push(`${rel(file)}:${errLine(e, line)} inline script: ${e.message}`);
    }
  }
}

const serverFiles = [path.join(ROOT, 'server.js')]
  .concat(walk(path.join(ROOT, 'server'), '.js'))
  .concat(walk(path.join(ROOT, 'scripts'), '.js'));
serverFiles.forEach(checkJs);
walk(path.join(ROOT, 'public'), '.js').forEach(checkJs);
const pages = walk(path.join(ROOT, 'public'), '.html');
pages.forEach(checkHtml);

if (problems.length) {
  console.error(`\nCHECK FAILED - ${problems.length} problem(s). Do not upload until fixed:\n`);
  problems.forEach(p => console.error('  x ' + p));
  console.error('');
  process.exit(1);
}
console.log(`Check passed: ${checked} scripts in ${serverFiles.length} server files, ${pages.length} pages and the public JS are all valid.`);
