/**
 * 网页版抠图（BiRefNet 高精度模式）端到端复现：
 *   真实 Chrome → 打开 http://localhost:4173 → 真实鼠标点击进 AI 抠图
 *   → 点「高精度 BiRefNet」→ 上传测试图 → 抓取 console / pageerror / requestfailed
 * 用法：node scripts/test-web-matting.mjs   （需先 npm run build && npm run preview）
 */
import puppeteer from 'puppeteer-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const URL_BASE = process.env.DW_URL || 'http://localhost:4173/'
const CHROME =
  '/Users/zhuoying/.workbuddy/binaries/browsers/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const IMG = process.env.DW_TEST_IMG || '/tmp/dw-test.png'
// 本机访问 huggingface 需走代理（与用户浏览器环境一致）
const PROXY = process.env.DW_PROXY || '127.0.0.1:7890'

/** 用真实鼠标点击指定文本的按钮（React 对 element.click() 有时不响应） */
async function clickButtonByText(page, text) {
  const pos = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.trim().includes(t),
    )
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, text)
  if (!pos) return false
  await page.mouse.click(pos.x, pos.y)
  return true
}

const run = async () => {
  // 固定 profile：模型下载走浏览器 HTTP 缓存，二次运行不重下
  const profile = '/tmp/dw-web-profile'
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: profile,
    protocolTimeout: 600000, // 模型下载/推理耗时较长，避免协议层误判超时
    dumpio: true, // 打印 Chrome 自身日志（含崩溃原因）
    args: [
      '--no-sandbox',
      '--disable-gpu',
      `--proxy-server=${PROXY}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
    ],
  })

  const logs = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    page.on('console', (m) => {
      const t = `[console:${m.type()}] ${m.text()}`
      logs.push(t)
      console.log(t)
    })
    page.on('pageerror', (e) => {
      const t = `[pageerror] ${e.message}`
      logs.push(t)
      console.log(t)
    })
    page.on('requestfailed', (r) => {
      const t = `[requestfailed] ${r.url()} → ${r.failure()?.errorText}`
      logs.push(t)
      console.log(t)
    })
    page.on('response', (r) => {
      const u = r.url()
      if (u.includes('huggingface') || u.includes('jsdelivr') || u.includes('ort-wasm') || u.includes('staticimgly'))
        console.log(`[response] ${r.status()} ${u.slice(0, 120)}`)
    })

    console.log('打开', URL_BASE)
    await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 })
    await new Promise((r) => setTimeout(r, 1000))

    // 真实鼠标点击进入 AI 抠图
    console.log('点击 AI 抠图:', await clickButtonByText(page, 'AI 抠图'))
    await new Promise((r) => setTimeout(r, 800))
    // 真实鼠标点击切到高精度
    console.log('点击 高精度 BiRefNet:', await clickButtonByText(page, '高精度 BiRefNet'))
    await new Promise((r) => setTimeout(r, 300))

    // 上传测试图
    const fileInput = await page.$('input[type=file]')
    if (!fileInput) throw new Error('找不到 input[type=file]')
    await fileInput.uploadFile(IMG)
    console.log('--- 文件已上传（高精度模式），等待 BiRefNet 流程（模型 210MB，首次较慢）---')

    // 每 5s 打印进度/状态
    const stopPoll = setInterval(async () => {
      try {
        const state = await page.evaluate(() => {
          const hint = [...document.querySelectorAll('.hint')]
            .map((e) => e.textContent?.trim())
            .filter(Boolean)
          return { hints: hint.slice(0, 3), hasCanvas: !!document.querySelector('canvas.matting-canvas') }
        })
        console.log('[poll]', JSON.stringify(state))
      } catch (e) {
        console.log('[poll err]', e.message)
      }
    }, 5000)

    try {
      const outcome = await page.waitForFunction(
        () => {
          const errEl = [...document.querySelectorAll('.hint')].find((e) =>
            e.textContent?.includes('抠图失败'),
          )
          if (errEl) return { type: 'error', text: errEl.textContent }
          const canvas = document.querySelector('canvas.matting-canvas')
          if (canvas) return { type: 'ok', text: `canvas ${canvas.width}x${canvas.height}` }
          return false
        },
        { timeout: 600000, polling: 1000 },
      )
      console.log('RESULT:', JSON.stringify(await outcome.jsonValue()))
    } catch (e) {
      console.log('WAIT_FAILED:', e.message)
    } finally {
      clearInterval(stopPoll)
    }
  } catch (e) {
    console.log('SCRIPT_ERROR:', e.message)
  } finally {
    console.log('--- 末尾日志 ---')
    for (const l of logs.slice(-40)) console.log(l)
    await browser.close()
  }
}

run()
