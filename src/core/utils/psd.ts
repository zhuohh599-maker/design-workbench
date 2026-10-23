/**
 * PSD「真·压缩」封装（基于 ag-psd）——保留图层结构，重新写回更小的 .psd。
 *
 * 缩小体积的手段：
 * 1. compress: true       —— 图层数据用 ZIP 压缩（原文件多为 raw 或 RLE）
 * 2. trimImageData: true  —— 裁掉图层位图四周的透明像素（Photoshop 打开时自动还原）
 * 3. generateThumbnail:false —— 不再写入缩略图
 * 4. 丢弃合成预览图（读取时 skipCompositeImageData）—— 体积大头之一；
 *    Photoshop 打开时会自动重新生成预览，但 macOS 预览/部分软件可能显示空白
 *
 * 限制（写入端）：仅支持 8-bit RGB；不支持 PSB 大文档之外的老版本兼容问题；
 * 文字层会被标记失效，Photoshop 打开时自动重绘（仍可编辑）。
 */

/** 内存类错误（Array buffer allocation failed / RangeError）转成可读提示 */
function friendlyMemError(e: unknown, stage: string): Error {
  const msg = e instanceof Error ? e.message : String(e)
  const isMem =
    /array buffer|allocation failed|out of memory/i.test(msg) ||
    (e instanceof RangeError && /length|allocation/i.test(msg))
  if (isMem) {
    return new Error(
      `浏览器内存不足（${stage}阶段）：文件过大，解码后的图层数据超出了标签页可用内存。` +
        `可尝试：1) 关闭其他标签页后重试；2) 改用「合并图层导出 WebP/AVIF」；3) 拆分/缩小 PSD 后再压缩。`,
    )
  }
  return new Error(`${stage}失败：${msg}`)
}

export async function compressPsd(file: File): Promise<Blob> {
  const { readPsd, writePsd } = await import('ag-psd')

  let psd
  try {
    // 不保留 file.arrayBuffer() 的引用：readPsd 返回后原始文件字节即可被 GC 回收。
    // 否则「原文件 + 解码图层 + 输出」三份数据同时驻留，大 PSD 会触发
    // 「Array buffer allocation failed」。
    psd = readPsd(new Uint8Array(await file.arrayBuffer()), {
      skipThumbnail: true,
      skipCompositeImageData: true,
      // 用 imageData 而非 canvas，避免 canvas 预乘 alpha 损坏像素
      useImageData: true,
      throwForMissingFeatures: false,
      logMissingFeatures: false,
    })
  } catch (e) {
    throw friendlyMemError(e, '读取 PSD')
  }

  let out: Uint8Array
  try {
    out = writePsd(psd, {
      generateThumbnail: false,
      trimImageData: true,
      invalidateTextLayers: true,
      compress: true,
      // PSB（大文档）原样保留格式，避免强转 PSD 损坏
      psb: (psd as { psb?: boolean }).psb === true,
    })
  } catch (e) {
    throw friendlyMemError(e, '重写 PSD')
  }

  return new Blob([out], { type: 'image/vnd.adobe.photoshop' })
}
