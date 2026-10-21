// onnxruntime-web 的 package.json exports 映射未暴露类型声明给默认/子路径导入，
// tsc 解析失败。这里声明为 any 模块（运行时由 Vite 正常打包，类型上按需用 any 处理）。
declare module 'onnxruntime-web'
