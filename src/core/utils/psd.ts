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

export async function compressPsd(file: File): Promise<Blob> {
  const { readPsd, writePsd } = await import('ag-psd')
  const buf = await file.arrayBuffer()

  const psd = readPsd(new Uint8Array(buf), {
    skipThumbnail: true,
    skipCompositeImageData: true,
    // 用 imageData 而非 canvas，避免 canvas 预乘 alpha 损坏像素
    useImageData: true,
    throwForMissingFeatures: false,
    logMissingFeatures: false,
  })

  const out = writePsd(psd, {
    generateThumbnail: false,
    trimImageData: true,
    invalidateTextLayers: true,
    compress: true,
    // PSB（大文档）原样保留格式，避免强转 PSD 损坏
    psb: (psd as { psb?: boolean }).psb === true,
  })

  return new Blob([out], { type: 'image/vnd.adobe.photoshop' })
}
