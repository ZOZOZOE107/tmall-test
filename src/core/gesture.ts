/**
 * 指向手势（point up）。
 *
 * 直接用 HandLandmarker 那 21 个点自己判，不再多载一个 GestureRecognizer 模型 ——
 * 园区版要整包离线跑，能少一个 .task 就少一个，而且这个手势的判据很简单。
 *
 * 距离一律在舞台像素下算：归一化坐标是按图片长宽各自归一化的，画面不是正方形时
 * 直接拿归一化值比长度会被拉扁。
 */
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

const WRIST = 0
const THUMB_TIP = 4
const IDX_MCP = 5
const IDX_PIP = 6
const IDX_TIP = 8
const MID_MCP = 9
/** 中指、无名指、小指的 [第二关节, 指尖] */
const OTHERS: Array<[number, number]> = [
  [10, 12],
  [14, 16],
  [18, 20],
]

export interface V2 {
  x: number
  y: number
}

export interface OpenPalmPose {
  /** 手掌中轴相对竖直方向的角度；负数是画面向左倾，正数是向右倾 */
  angle: number
  /** 手腕点，已经按镜像换算过 —— 举稳进度环直接拿这个点定位，不用再自己翻一次 */
  at: V2
}

const dist = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * 找到第一只在比「1」的手，返回它食指指尖（8 号点）在舞台里的位置。
 * 没有就返回 null。
 */
export function pointUp(hands: NormalizedLandmark[][], w: number, h: number): V2 | null {
  for (const lms of hands) {
    if (!lms || lms.length < 21) continue
    const P = (i: number): V2 => ({ x: lms[i].x * w, y: lms[i].y * h })
    const wrist = P(WRIST)
    const tip = P(IDX_TIP)
    const pip = P(IDX_PIP)
    const mcp = P(IDX_MCP)

    // 食指伸直：指尖比第二关节离手腕更远
    if (dist(wrist, tip) < dist(wrist, pip) * 1.15) continue
    // 而且指尖在第二关节上方（y 轴朝下）
    if (tip.y >= pip.y) continue
    // 朝上要多于朝旁边，不然「指着侧面」也会算数
    if (mcp.y - tip.y < Math.abs(tip.x - mcp.x)) continue

    // 其余三指蜷着：指尖没有明显越过自己的第二关节
    let folded = true
    for (const [p, t] of OTHERS) {
      if (dist(wrist, P(t)) > dist(wrist, P(p)) * 1.15) {
        folded = false
        break
      }
    }
    if (!folded) continue

    return tip
  }
  return null
}

/**
 * 捏合（拇指尖 4 碰食指尖 8）。返回捏合点 —— 两个指尖的中点。
 *
 * 阈值按**手掌长度**归一化（手腕到中指根），所以人站远站近都是同一个判据；
 * 直接比像素距离的话，退后一步就捏不动了。
 */
export function pinch(hands: NormalizedLandmark[][], w: number, h: number): V2 | null {
  for (const lms of hands) {
    if (!lms || lms.length < 21) continue
    const P = (i: number): V2 => ({ x: lms[i].x * w, y: lms[i].y * h })
    const palm = dist(P(WRIST), P(MID_MCP))
    if (palm < 1) continue
    const t = P(THUMB_TIP)
    const i8 = P(IDX_TIP)
    if (dist(t, i8) / palm > PINCH_RATIO) continue
    return { x: (t.x + i8.x) / 2, y: (t.y + i8.y) / 2 }
  }
  return null
}

/** 指尖距离 ÷ 手掌长度，小于这个数算捏上了。真人手上可能要调 */
export const PINCH_RATIO = 0.38

/**
 * 找一只正面张开的手掌，并返回手掌中轴的视觉倾角。
 * 用腕点 → 中指根作为轴，比腕点 → 指尖稳定，不容易被手指轻微弯曲干扰。
 */
export function openPalmTilt(
  hands: NormalizedLandmark[][],
  w: number,
  h: number,
  mirrored = false,
): OpenPalmPose | null {
  const fingers: Array<[number, number]> = [[6, 8], [10, 12], [14, 16], [18, 20]]
  for (const lms of hands) {
    if (!lms || lms.length < 21) continue
    const P = (i: number): V2 => ({ x: (mirrored ? 1 - lms[i].x : lms[i].x) * w, y: lms[i].y * h })
    const wrist = P(WRIST)
    const middle = P(MID_MCP)
    const palm = dist(wrist, middle)
    if (palm < 5) continue

    // 真人面对镜头时，小指很容易因透视或轻微弯曲判短。食指、中指必须伸直，
    // 无名指和小指允许丢一根；这样仍明显是张掌，又不会一帧小指抖动就整段失败。
    const extended = fingers.map(([pip, tip]) => dist(wrist, P(tip)) > dist(wrist, P(pip)) * 1.04)
    if (!extended[0] || !extended[1] || extended.filter(Boolean).length < 3) continue
    // 拇指不要求完全横向打开，只排除明显收进掌心的握拳状态。
    if (dist(P(THUMB_TIP), P(IDX_MCP)) < palm * 0.3) continue

    const dx = middle.x - wrist.x
    const dy = wrist.y - middle.y
    return { angle: Math.atan2(dx, dy) * 180 / Math.PI, at: wrist }
  }
  return null
}
