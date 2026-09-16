/**
 * 骨架定义。上衣和下装用同一套蒙皮代码，区别只在这里的 rig 配置。
 *
 * Ref 可以是一个关节名，也可以是 ['mid', a, b] 表示两个关节的中点 ——
 * 躯干骨的起点是「肩中点」，骨盆骨的起点是「髋中点」，都不是单个骨骼点。
 */
export type V2 = { x: number; y: number }
export type Ref = string | ['mid', string, string]

export interface Rig {
  /** 关节名 → MediaPipe 骨骼点编号 */
  landmarks: Record<string, number>
  /** 这些关节必须可见，否则整件不画 */
  required: string[]
  /** 骨头列表。第 0 根是主干，手臂/腿缺失时退回它 */
  bones: Array<[Ref, Ref]>
  /** 朝向判定：宽度对 / 长度对 / 有效区间 */
  facingWidth: [Ref, Ref]
  facingLength: [Ref, Ref]
  facingRange: [number, number]
}

export const resolveRef = (ref: Ref, get: (k: string) => V2): V2 => {
  if (typeof ref === 'string') return get(ref)
  const a = get(ref[1])
  const b = get(ref[2])
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export const refJoints = (ref: Ref): string[] => (typeof ref === 'string' ? [ref] : [ref[1], ref[2]])

/* ── 上衣：躯干 + 左右上臂 + 左右前臂 ─────────────────────────── */
export const TOP_RIG: Rig = {
  landmarks: {
    rShoulder: 12, lShoulder: 11,
    rElbow: 14, lElbow: 13,
    rWrist: 16, lWrist: 15,
    rHip: 24, lHip: 23,
  },
  required: ['rShoulder', 'lShoulder', 'rHip', 'lHip'],
  bones: [
    [['mid', 'rShoulder', 'lShoulder'], ['mid', 'rHip', 'lHip']],
    ['rShoulder', 'rElbow'],
    ['rElbow', 'rWrist'],
    ['lShoulder', 'lElbow'],
    ['lElbow', 'lWrist'],
  ],
  facingWidth: ['rShoulder', 'lShoulder'],
  facingLength: [['mid', 'rShoulder', 'lShoulder'], ['mid', 'rHip', 'lHip']],
  facingRange: [0.35, 0.6],
}

/* ── 下装：骨盆 + 左右大腿 + 左右小腿 ─────────────────────────── */
export const BOTTOM_RIG: Rig = {
  landmarks: {
    rHip: 24, lHip: 23,
    rKnee: 26, lKnee: 25,
    rAnkle: 28, lAnkle: 27,
  },
  required: ['rHip', 'lHip', 'rKnee', 'lKnee'],
  bones: [
    [['mid', 'rHip', 'lHip'], ['mid', 'rKnee', 'lKnee']],
    ['rHip', 'rKnee'],
    ['rKnee', 'rAnkle'],
    ['lHip', 'lKnee'],
    ['lKnee', 'lAnkle'],
  ],
  facingWidth: ['rHip', 'lHip'],
  facingLength: [['mid', 'rHip', 'lHip'], ['mid', 'rKnee', 'lKnee']],
  // 髋宽 / 大腿长：正面站立大约 0.45，侧身会塌到 0.2 以下
  facingRange: [0.18, 0.35],
}

export const RIGS = { top: TOP_RIG, bottom: BOTTOM_RIG } as const
export type RigName = keyof typeof RIGS
