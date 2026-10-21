import { defineConfig, type Plugin } from 'vite'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 把打包后的抠图推理代码（含 @imgly 全部依赖）内联进 sandbox.html。
 * 原因：MV3 沙箱页是 null origin，<script type=module src=chrome-extension://...>
 * 会被 CORS 拦（module 强制 CORS 且扩展资源不带 ACAO）；经典外链脚本的 'self'
 * 也解析不到 chrome-extension。只有「内联脚本」能绕开跨源加载——沙箱 CSP 允许
 * 'unsafe-inline'。运行时零 fetch、零跨源，最稳。
 */
function inlineSandboxMatting(): Plugin {
  return {
    name: 'inline-sandbox-matting',
    apply: 'build',
    closeBundle() {
      const dir = resolve(__dirname, 'dist-ext/extension')
      const candidates = ['matting.js', 'matting.mjs']
      let code = ''
      for (const f of candidates) {
        const p = resolve(dir, f)
        if (existsSync(p)) {
          code = readFileSync(p, 'utf-8')
          break
        }
      }
      if (!code) throw new Error('未找到打包后的 matting 脚本，请检查 lib 构建是否执行')
      const tmpl = readFileSync(resolve(__dirname, 'extension/sandbox.html'), 'utf-8')
      // 防止代码里的 </script> 提前闭合内联脚本
      const escaped = code.replace(/<\/script>/gi, '<\\/script>')
      const html = tmpl.replace(
        '<!--__MATTING_CODE__-->',
        `<script type="module">\n${escaped}\n</script>`,
      )
      writeFileSync(resolve(dir, 'sandbox.html'), html)
      // 内联后原始 matting.js 已无用，避免产物冗余
      for (const f of candidates) {
        const p = resolve(dir, f)
        if (existsSync(p)) rmSync(p)
      }
    },
  }
}

/**
 * 抠图推理脚本：单文件 ESM（@imgly 全部内联），随后由 inlineSandboxMatting
 * 注入 sandbox.html。不进应用打包，避免被当成 module chunk 走跨源加载。
 *
 * 关键点：
 * 1) inlineDynamicImports —— imgly 运行时会 `import("onnxruntime-web")`，
 *    若打成独立 chunk，沙箱（null origin）跨源动态 import chrome-extension:// 会被
 *    CORS 拦截。全部内联成单文件即可绕开。
 * 2) onnxruntime-web 别名指向「无 wasm 内联」的 ort.min.mjs：imgly 实际通过
 *    ort.env.wasm.wasmPaths 从 CDN 拉 wasm，默认 bundle 版内联的 65MB base64 是死重。
 *    指向 ort.min.mjs 后产物从 ~65MB 降到几百 KB。
 * 3) 强制 device:'wasm'，避免引入 65MB 的 webgpu bundle 分支。
 */
export default defineConfig({
  root: __dirname,
  publicDir: false,
  build: {
    outDir: 'dist-ext/extension',
    emptyOutDir: false,
    target: 'es2020',
    lib: {
      entry: resolve(__dirname, 'extension/matting.ts'),
      formats: ['es'],
      fileName: () => 'matting.js',
    },
    rollupOptions: {
      // lib 模式默认会把 node_modules 依赖外置（保留 import 语句），但沙箱 null origin
      // 无法跨源加载模块，必须全部内联。external:[] 强制把 @imgly / onnxruntime-web 等
      // 全部打包进单文件。
      external: [],
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'matting.js',
        chunkFileNames: 'matting-[name].js',
        assetFileNames: 'matting-[name][extname]',
      },
    },
  },
  plugins: [inlineSandboxMatting()],
})
