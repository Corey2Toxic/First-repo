/**
 * Inline the Vite build into self-contained HTML files:
 *
 *   dist-single/fireweed.html         a complete page; open it straight from disk
 *   dist-single/fireweed-hosted.html  page content only (no doctype/head/body), for hosts
 *                                     that wrap a page in their own document skeleton and
 *                                     block script-started downloads
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const source = readFileSync(join(dist, 'index.html'), 'utf8');
const assets = readdirSync(join(dist, 'assets'));
const css: string[] = [];
const js: string[] = [];

let html = source.replace(/<link rel="stylesheet"[^>]*href="\.?\/?assets\/([^"]+)"[^>]*>/g, (_m, file: string) => {
  const text = readFileSync(join(dist, 'assets', file), 'utf8');
  css.push(text);
  return `<style>\n${text}\n</style>`;
});
html = html.replace(/<script type="module"[^>]*src="\.?\/?assets\/([^"]+)"[^>]*><\/script>/g, (_m, file: string) => {
  const text = readFileSync(join(dist, 'assets', file), 'utf8').replace(/<\/script/gi, '<\\/script');
  js.push(text);
  return `<script type="module">\n${text}\n</script>`;
});
// any modulepreload links are now redundant
html = html.replace(/<link rel="modulepreload"[^>]*>/g, '');

const body = /<body>([\s\S]*)<\/body>/.exec(source)?.[1].replace(/<script[\s\S]*?<\/script>/g, '').trim() ?? '';
// the hosted page carries its version in the title, so that it sits beside earlier releases
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
const title = `${/<title>([^<]*)<\/title>/.exec(source)?.[1] ?? 'Fireweed'} ${version}`;
const hosted = [
  `<title>${title}</title>`,
  `<style>\n${css.join('\n')}\n</style>`,
  body,
  '<script>window.FIREWEED_NO_DOWNLOADS = true;</script>',
  ...js.map((text) => `<script type="module">\n${text}\n</script>`),
  '',
].join('\n');

mkdirSync('dist-single', { recursive: true });
writeFileSync('dist-single/fireweed.html', html);
writeFileSync('dist-single/fireweed-hosted.html', hosted);
const kb = (s: string) => Math.round(Buffer.byteLength(s) / 1024);
console.log(`dist-single/fireweed.html written (${kb(html)} KB, ${assets.length} assets inlined)`);
console.log(`dist-single/fireweed-hosted.html written (${kb(hosted)} KB)`);
