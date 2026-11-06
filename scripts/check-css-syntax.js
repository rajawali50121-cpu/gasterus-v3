import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

const cssDirectories = ['frontend/css', 'admin/public'];
const htmlDirectories = ['frontend', 'admin/public'];
const cssFiles = [];
const htmlFiles = [];

function collectFiles(dir, predicate, files) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) collectFiles(fullPath, predicate, files);
    else if (predicate(entry)) files.push(fullPath);
  }
}

for (const directory of cssDirectories) collectFiles(directory, name => name.endsWith('.css'), cssFiles);
for (const directory of htmlDirectories) collectFiles(directory, name => name.endsWith('.html'), htmlFiles);

let hasErrors = false;
let inlineBlocks = 0;
let inlineAttributes = 0;
function checkCss(css, file, lineOffset = 0, sourceKind = 'file') {
  try {
    postcss.parse(css, { from: file });
  } catch (error) {
    console.error(`❌ CSS syntax error in ${file}:${lineOffset + error.line}:${error.column} (${sourceKind}): ${error.reason}`);
    hasErrors = true;
  }
}

for (const file of cssFiles) checkCss(readFileSync(file, 'utf8'), file);

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const contentOffset = match.index + match[0].indexOf(match[1]);
    const lineOffset = html.slice(0, contentOffset).split('\n').length - 1;
    inlineBlocks++;
    checkCss(match[1], file, lineOffset, 'inline <style>');
  }

  const markup = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
    block => block.replace(/[^\r\n]/g, ' '));
  for (const tag of markup.matchAll(/<[a-z][^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const css = attribute[1] ?? attribute[2] ?? attribute[3] ?? '';
      const contentOffset = tag.index + attribute.index + attribute[0].indexOf(css);
      const lineOffset = html.slice(0, contentOffset).split('\n').length - 1;
      inlineAttributes++;
      checkCss(css, file, lineOffset, 'inline style attribute');
    }
  }
}

if (hasErrors) {
  console.error(`\nCSS syntax check failed (${cssFiles.length} files, ${inlineBlocks} inline blocks, and ${inlineAttributes} inline attributes checked).`);
  process.exit(1);
}

console.log(`✅ CSS syntax check passed (${cssFiles.length} files, ${inlineBlocks} inline <style> blocks, ${inlineAttributes} inline style attributes).`);
