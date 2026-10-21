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

/**
 * 扩展应用构建：侧边栏工作台 / service worker / content script。
 * 沙箱推理脚本由 vite.ext.sandbox.config.ts 单独构建并内联进 sandbox.html。
 */
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
