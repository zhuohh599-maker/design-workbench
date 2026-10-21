import puppeteer from 'puppeteer-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXT = resolve('/Users/zhuoying/WorkBuddy/2026-08-14-10-10-04/design-workbench/dist-ext')
const CHROME = '/Users/zhuoying/.workbuddy/binaries/browsers/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir: mkdtempSync(join(tmpdir(), 'dw-diag-')),
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--window-position=-32000,-32000'],
})
await new Promise(r => setTimeout(r, 3000))
// 从 target 获取 page，规避 newPage 主框架时序 bug
let page = null
for (let i = 0; i < 10 && !page; i++) {
  for (const t of browser.targets()) {
    if (t.type() === 'page') { try { page = await t.page() } catch {} }
  }
  if (!page) await new Promise(r => setTimeout(r, 1000))
}
if (!page) throw new Error('no page target')
await page.goto('chrome://extensions', { waitUntil: 'load', timeout: 30000 })
await new Promise(r => setTimeout(r, 2000))
const info = await page.evaluate(() => new Promise(res => {
  chrome.developerPrivate.getExtensionsInfo(list => res(list.map(x => ({ id: x.id, name: x.name, state: x.state, errors: (x.runtimeErrors||[]).concat(x.manifestErrors||[]).map(e => e.message) }))))
}))
console.log(JSON.stringify(info, null, 2))
await browser.close()
