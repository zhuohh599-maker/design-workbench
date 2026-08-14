import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 纯前端应用：所有图片处理在浏览器本地完成，不上传服务器。
// 后续若接入视频工具 / 需要跨源隔离（SharedArrayBuffer）时，
// 可在此打开 server.headers 的 COOP/COEP 配置（见注释）。
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // 如需为某些 WASM 多线程库开启跨源隔离，取消下一行注释：
    // headers: {
    //   'Cross-Origin-Opener-Policy': 'same-origin',
    //   'Cross-Origin-Embedder-Policy': 'require-corp',
    // },
  },
  // 给背景移除模型等较大静态资源留足上限
  assetsInclude: ['**/*.onnx', '**/*.wasm'],
})
