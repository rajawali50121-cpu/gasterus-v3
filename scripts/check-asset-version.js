#!/usr/bin/env node
/**
 * check-asset-version.js — gagal kalau ada referensi aset JS/CSS lokal tanpa
 * query versi (?v=...) atau menunjuk file yang tidak ada.
 *
 * Query versi membuat perubahan aset mendapatkan URL baru, sedangkan pemeriksaan
 * ini memastikan semua referensi lokal punya versi dan menunjuk file yang ada.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const admin = resolve(root, 'admin/public');
const pages = [
  ...readdirSync(frontend).filter(name => name.endsWith('.html')).map(name => resolve(frontend, name)),
  ...readdirSync(admin).filter(name => name.endsWith('.html')).map(name => resolve(admin, name))
];
const problems = [];
let checkedJs = 0;
let checkedCss = 0;
const jsVersions = new Map();
const cssVersions = new Map();

for (const pagePath of pages) {
  const html = readFileSync(pagePath, 'utf8');
  const page = pagePath.startsWith(`${frontend}/`) ? 'frontend' : 'admin/public';
  const base = pagePath.startsWith(`${frontend}/`) ? frontend : admin;
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = match[0].match(/\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["']/i)?.[1];
    if (!src || /^(?:https?:)?\/\//i.test(src) || /^(?:data:|blob:)/i.test(src)) continue;

    checkedJs += 1;
    const [pathname, ...queryParts] = src.split('?');
    const query = queryParts.length ? `?${queryParts.join('?')}` : '';
    const version = query.match(/[?&]v=([^&]+)/)?.[1];
    if (!version) problems.push(`${page}/${pagePath.split('/').at(-1)}: ${src} tanpa ?v=`);
    else {
      const versions = jsVersions.get(pathname) || new Set();
      versions.add(version);
      jsVersions.set(pathname, versions);
    }
    const assetRoot = pathname.startsWith('/') ? frontend : base;
    if (!existsSync(resolve(assetRoot, pathname.replace(/^\//, '')))) problems.push(`${page}/${pagePath.split('/').at(-1)}: ${src} tidak ada`);
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel=["']stylesheet["']/i.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+\.css(?:\?[^"']*)?)["']/i)?.[1];
    if (!href || /^(?:https?:)?\/\//i.test(href) || /^(?:data:|blob:)/i.test(href)) continue;

    checkedCss += 1;
    const [pathname, ...queryParts] = href.split('?');
    const query = queryParts.length ? `?${queryParts.join('?')}` : '';
    const version = query.match(/[?&]v=([^&]+)/)?.[1];
    if (!version) problems.push(`${page}/${pagePath.split('/').at(-1)}: ${href} tanpa ?v=`);
    else {
      const versions = cssVersions.get(pathname) || new Set();
      versions.add(version);
      cssVersions.set(pathname, versions);
    }
    const assetPath = resolve(base, pathname.replace(/^\//, ''));
    if (!existsSync(assetPath)) problems.push(`${page}/${pagePath.split('/').at(-1)}: ${href} tidak ada`);
  }
}

for (const [asset, versions] of jsVersions) {
  if (versions.size > 1) problems.push(`${asset} memakai versi cache berbeda: ${[...versions].join(', ')}`);
}

for (const [asset, versions] of cssVersions) {
  if (versions.size > 1) problems.push(`${asset} memakai versi cache berbeda: ${[...versions].join(', ')}`);
}

if (problems.length) {
  console.error('❌ Cache-busting asset bermasalah:');
  for (const p of problems) console.error(`   - ${p}`);
  process.exit(1);
}
console.log(`✅ Cache-busting OK (${checkedJs} referensi JS, ${checkedCss} stylesheet lokal; semua punya ?v= dan file tersedia)`);
