/**
 * 推理降采样。
 *
 * 显示用原始画面，推理用缩小后的画面 —— 两件事没必要用同一个分辨率。
 * MediaPipe 内部本来就会把输入缩到固定尺寸，但纹理上传的开销跟着源尺寸走，
 * 1920×1080 比 640×360 多 9 倍像素。降采样之后关键点是归一化坐标，
 * 贴合精度不受影响。
 */
const canvas = document.createElement('canvas')
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })

/** 实际喂给模型的尺寸，给状态栏显示用 */
export let inferSize = { w: 0, h: 0 }

/**
 * @param maxEdge 长边上限，0 表示不降采样
 */
export function forInference(
  el: HTMLVideoElement,
  maxEdge: number,
): HTMLVideoElement | HTMLCanvasElement {
  const sw = el.videoWidth
  const sh = el.videoHeight
  if (!maxEdge || !sw || !sh) {
    inferSize = { w: sw, h: sh }
    return el
  }

  const scale = Math.min(1, maxEdge / Math.max(sw, sh))
  if (scale >= 1 || !ctx) {
    inferSize = { w: sw, h: sh }
    return el
  }

  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  ctx.drawImage(el, 0, 0, w, h)
  inferSize = { w, h }
  return canvas
}
