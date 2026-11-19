/**
 * Screenshot helper: node scripts/shot.ts <url> <out.png> [width] [height] [waitMs]
 */
import { chromium } from 'playwright';
const [url, out, w = '1400', h = '900', wait = '1500'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const logs: string[] = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => (window as any).ready === true, null, { timeout: 60000 }).catch(() => logs.push('timeout waiting for ready'));
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
console.log(logs.join('\n'));
await browser.close();
