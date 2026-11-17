// 把 dist-test/test-chromakey.html 的 JS/CSS 全部内联成单个自包含 HTML，
// 产物输出到工作区根目录，可脱离服务器直接双击打开（file:// 也可用）。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist-test')
const htmlPath = resolve(dist, 'test-chromakey.html')
let html = readFileSync(htmlPath, 'utf8')

// 内联 CSS
html = html.replace(
  /<link rel="stylesheet"[^>]*href="\.?\/?(assets\/[^"]+\.css)"[^>]*>/g,
  (_, href) => `<style>\n${readFileSync(resolve(dist, href), 'utf8')}\n</style>`,
)

// 内联 JS（module 脚本整体内联，注意转义 </script>）
html = html.replace(
  /<script type="module"[^>]*src="\.?\/?(assets\/[^"]+\.js)"[^>]*><\/script>/g,
  (_, src) => {
    const code = readFileSync(resolve(dist, src), 'utf8').replace(/<\/script/gi, '<\\/script')
    return `<script type="module">\n${code}\n</script>`
  },
)

const out = resolve(root, '绿幕抠像-保护区测试.html')
writeFileSync(out, html)
const assetsLeft = readdirSync(resolve(dist, 'assets'))
console.log('inlined ->', out, `(${(html.length / 1024).toFixed(0)} KB)`)
console.log('remaining assets (应为空或仅字体等):', assetsLeft)
