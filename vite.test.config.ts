import { defineConfig } from 'vite'

// 绿幕保护区功能的独立单文件测试构建：产物 dist-test/test-chromakey.html，
// 再由 scripts/inline-test.mjs 把 JS/CSS 内联成可直接双击打开的单文件 HTML。
// onnxruntime-web 走 CDN shim（运行时从 jsDelivr 加载），避免 wasm/mjs 变成外部资源。
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      'onnxruntime-web': '/src/ort-cdn-shim.ts',
    },
  },
  build: {
    target: 'es2022', // 支持顶层 await（CDN shim）
    outDir: 'dist-test',
    emptyOutDir: true,
    rollupOptions: {
      input: 'test-chromakey.html',
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
})
