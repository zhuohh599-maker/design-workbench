import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 构建结束后把 MV3 manifest 拷到产物根目录 */
function copyManifest(): Plugin {
  return {
    name: 'copy-extension-manifest',
    apply: 'build',
    closeBundle() {
      copyFileSync(
        resolve(__dirname, 'extension/manifest.json'),
        resolve(__dirname, 'dist-ext/manifest.json'),
      )
    },
  }
}

// 扩展构建：复用同一套 React 工具代码，额外产出
//   - sidepanel.html + assets   （侧边栏工作台，compact 模式）
//   - background.js             （service worker：跨域抓图 / 右键菜单 / 拉起侧边栏）
//   - content.js                （常驻浮球）
// 网页版（Netlify）仍用 vite.config.ts 的 `npm run build`，互不影响。
export default defineConfig({
  plugins: [react(), copyManifest()],
  root: __dirname,
  publicDir: 'public',
  build: {
    outDir: 'dist-ext',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        background: resolve(__dirname, 'extension/background.ts'),
        content: resolve(__dirname, 'extension/content.ts'),
      },
      output: {
        // background / content 必须是稳定文件名，供 manifest 引用
        entryFileNames: (chunk) =>
          chunk.name === 'background' || chunk.name === 'content'
            ? '[name].js'
            : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
