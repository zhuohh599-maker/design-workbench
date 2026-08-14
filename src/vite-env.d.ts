/// <reference types="vite/client" />

declare module 'gifuct-js' {
  export interface GifFrame {
    dims: { top: number; left: number; width: number; height: number }
    patch: Uint8ClampedArray
    delay: number
    disposalType: number
    transparent: boolean
    transparentIndex: number
  }
  export interface Gif {
    lsd: { width: number; height: number }
    [key: string]: unknown
  }
  export function parseGIF(buffer: ArrayBuffer): Gif
  export function decompressFrames(gif: Gif, buildPatch: boolean): GifFrame[]
}
