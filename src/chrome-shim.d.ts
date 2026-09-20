// 极简 chrome 全局类型垫片：扩展环境才有 chrome 对象，网页构建里不存在。
// 这里只声明为 any，足够本项目的扩展通信使用；如需完整类型可装 @types/chrome。
declare const chrome: any
