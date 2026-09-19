/**
 * 站位引导 + 姿势确认：把 Pose 的 33 个点翻译成两件事 —— 人有没有站进
 * #frame-guide 那个人形框，有没有摆出目标姿势（双手插腰、肘部外张、正面站定）。
 *
 * 所有阈值都用「身体自己的尺度」做分母（躯干长 / 肩宽 / 髋宽），不写死像素值。
 * 高矮胖瘦、站远站近只影响分母，结论只看形状 —— 否则换个人站过来就得重调一遍。
 *
 * 四个状态：
 *   idle    没有人 / 没站到位
 *   framed  站位对了，姿势还没摆好
 *   holding 姿势命中，正在计时
 *   ready   保持够了，定格完成
 *
 * ready 之后不会被正常抖动打回：人站着不动时 MediaPipe 会偶发丢帧，已经定格
 * 的状态得撑住 —— 和 main.ts 里「举掌换装」那套滞回是同一个理由。
 */
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

export type StandState = 'idle' | 'framed' | 'holding' | 'ready'
/** 远近：far 站太远、near 站太近 */
export type StandDistance = 'none' | 'far' | 'near' | 'ok'
/** 左右：相对「画面」而不是相对人自己的左右手 */
export type StandOffset = 'none' | 'left' | 'right' | 'ok'

/** #frame-guide 容器在舞台坐标里的框，单位 px，和 stage.content 同一套 */
export interface GuideBox {
  x: number
  y: number
  w: number
  h: number
}

export interface StandFrame {
  box: GuideBox
  /** 舞台（= 视频矩形）尺寸：归一化坐标 × 这个 = 屏幕像素 */
  stageW: number
  stageH: number
  /** 关键点置信度下限，和工具栏那个滑杆共用一份 */
  minVisibility: number
  /** 画面镜像时，归一化坐标的左右和观众看到的左右是反的 */
  mirrored: boolean
}

export interface StandMetrics {
  /** 肩中点→踝中点的 y 跨度 ÷ 人形框高，1 = 站位刚好 */
  span: number
  /** 脚相对人形脚底的位置 ÷ 人形框高，正 = 太靠前（离摄像头近） */
  foot: number
  /** 髋中点离人形中线的偏移 ÷ 人形框宽，正 = 画面右侧 */
  offsetX: number
  /** 姿势分 0~1 */
  pose: number
  /** 正面度 0~1 */
  facing: number
  /** 肩中点到髋中点，像素。调试用：能看出人站得多远 */
  torso: number
}

export interface StandReport {
  state: StandState
  distance: StandDistance
  offset: StandOffset
  /** 姿势保持进度 0~1，配合进度环用 */
  hold: number
  /** 画面里有完整的人（肩髋膝踝都够置信度）—— 用来决定描不描真人轮廓 */
  hasBody: boolean
  /** 髋部（23/24 号点）够置信度——虚线人形弹走用这个，比 hasBody 早触发 */
  hipsVisible: boolean
  metrics: StandMetrics
}

/* ── 目标人形的位置，相对 #frame-guide 容器 ─────────────────────
 *
 * 这几个数字是拿 index.html 里那条人形路径（资源 4.svg，523.18×1008.68）
 * 在离屏 canvas 里描实心轮廓、逐行扫左右边界量出来的：肩线大约在领口往下
 * 张开的 y=296，脚底（路径最低点）在 y=1006，踝线按老比例（脚底往上 4.4%
 * 那条线）估在 y=962，左右对称所以 centerX 就是路径包围盒的中点。
 * 这条手绘轮廓下摆很宽、没有明显的脚，「脚底/踝线」这两个名字只是沿用旧的
 * 叫法，实际就是「路径最低点」和「往上一截」两个参考线——容差本来就留得松
 * （SPAN_OK ±16%、FOOT_UP/DOWN -0.18~0.12），差个几像素不影响判定。
 * 改那条路径就得回来改这里，否则「站位刚好」会被判成偏近或偏远。
 */
const FIG = {
  centerX: 261.59 / 523.18,
  shoulderY: 296 / 1008.68,
  footY: 1006 / 1008.68,
  ankleY: 961.6 / 1008.68,
} as const
/** 站着不动时肩到踝该占人形框高的多少 —— 也就是「人和画出的人形一样高」 */
const SPAN_TARGET = FIG.ankleY - FIG.shoulderY

/* ── 站位容差 ───────────────────────────────────────────────── */

/** 身高跨度允许的误差，±16% 之内都算站到位了。太紧会一直提示人前后挪 */
const SPAN_OK = 0.16
/**
 * 脚踩在人形脚底这条线上下多少之内算 ok。
 *
 * 比身高那条松：摄像头是架高还是齐胸、往不往下压，都会让同一个人在这条线上
 * 平移不少，所以脚下位置只做「明显不对」的兜底，主要判据还是身高跨度。
 */
const FOOT_UP = -0.18
const FOOT_DOWN = 0.12
/**
 * 髋中点离人形中线多远之内算站正了，单位是人形框宽。
 * 人形框本身只有屏幕宽的 3/8 左右，这里 0.16 换算到画面约 ±6% ——「站得挺正」
 * 但对得没那么死，人不用为了几厘米来回挪。
 */
const OFFSET_OK = 0.16

/* ── 姿势判定 ───────────────────────────────────────────────── */

/** 手离髋多近算「插在腰上」，单位是躯干长。垂手时约 0.5，所以肘角那条才是主力 */
const HAND_NEAR = 0.55
/** 肘角区间。插腰约 100°，垂手约 175°，两个一测就分开了 */
const ELBOW_MIN = 65
const ELBOW_MAX = 150
/** 肘要比肩外多少（躯干长为单位），防止双手抱在胸前被误判成插腰 */
const ELBOW_OUT = 0.05
/** 手要落在髋上下的这段里，别举到胸口也别掉到大腿 */
const HAND_Y_MIN = -0.55
const HAND_Y_MAX = 0.35
/** 肩宽 ÷ 髋宽 的允许区间，正面站大约 1.6，侧身会塌到 1 以下 */
const FACING_WIDTH: [number, number] = [1.15, 2.6]
/** 正面度低于这个就整个不算命中 */
const FACING_MIN = 0.35
/** 两侧取最差的那一侧，再和这个比 */
const POSE_OK = 0.72

/* ── 时间 ───────────────────────────────────────────────────── */

/** 姿势保持多久算定格完成 */
const HOLD_MS = 900
/** 姿势破了之后进度往回掉的速度。掉得比攒得快，半吊子姿势磨不上去 */
const HOLD_DECAY = 2
/** 已经定格之后，人整个丢失多久才作废 */
const READY_GRACE_MS = 1200

const EMPTY_METRICS: StandMetrics = { span: 0, foot: 0, offsetX: 0, pose: 0, facing: 0, torso: 0 }

/* ── 小工具 ─────────────────────────────────────────────────── */

interface V {
  x: number
  y: number
}

const mid = (a: V, b: V): V => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const len = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y)
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** b 点处的夹角（a-b-c），0~180 度 */
function angle(a: V, b: V, c: V): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y }
  const v2 = { x: c.x - b.x, y: c.y - b.y }
  const denom = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1
  const cos = (v1.x * v2.x + v1.y * v2.y) / denom
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI
}

/** v ≤ lo 得 1，v ≥ hi 得 0 */
const rampDown = (v: number, lo: number, hi: number): number => clamp01((hi - v) / (hi - lo || 1))
/** v ≤ lo 得 0，v ≥ hi 得 1 */
const rampUp = (v: number, lo: number, hi: number): number => clamp01((v - lo) / (hi - lo || 1))
/** 区间内得 1，出去 fade 那么远之内线性掉到 0 */
const band = (v: number, lo: number, hi: number, fade: number): number =>
  Math.min(rampUp(v, lo - fade, lo), rampDown(v, hi, hi + fade))

/**
 * 一侧手臂的插腰分：手贴髋、肘弯着、肘比肩外、手在腰的高度，四条都满足才算 1。
 * 用 min 而不是平均 —— 有一条完全不像就不是这个姿势。
 */
function armScore(shoulder: V, elbow: V, wrist: V, hip: V, centerX: number, torso: number): number {
  const near = rampDown(len(wrist, hip) / torso, HAND_NEAR, HAND_NEAR * 1.8)
  const bend = band(angle(shoulder, elbow, wrist), ELBOW_MIN, ELBOW_MAX, 25)
  const out = rampUp(
    (Math.abs(elbow.x - centerX) - Math.abs(shoulder.x - centerX)) / torso,
    0,
    ELBOW_OUT,
  )
  const height = band((wrist.y - hip.y) / torso, HAND_Y_MIN, HAND_Y_MAX, 0.35)
  return Math.min(near, bend, out, height)
}

export class StandGuide {
  private state: StandState = 'idle'
  private holdMs = 0
  private lostMs = 0

  reset(): void {
    this.state = 'idle'
    this.holdMs = 0
    this.lostMs = 0
  }

  update(lms: NormalizedLandmark[] | null, dtMs: number, f: StandFrame): StandReport {
    // 卡一帧回来 dt 可能是几百毫秒，别让进度一次跳到底
    const dt = Math.min(120, Math.max(0, dtMs))
    const vis = (i: number): number => lms?.[i]?.visibility ?? 0
    const at = (i: number): V => ({
      x: (lms?.[i]?.x ?? 0) * f.stageW,
      y: (lms?.[i]?.y ?? 0) * f.stageH,
    })

    // 站位要求肩髋膝踝都在：少一个就量不出远近和脚下位置。
    // 姿势另要肘和腕（手插在腰头里时腕的置信度会偏低，所以下限和滑杆共用一份）。
    const bodyOk = !!lms && [11, 12, 23, 24, 25, 26, 27, 28].every((i) => vis(i) >= f.minVisibility)
    const poseVisible = [13, 14, 15, 16].every((i) => vis(i) >= f.minVisibility)
    // 虚线人形弹走单独看髋部（23/24）——不等膝盖、脚踝也进画面，人一半身子
    // 站进来就该让位，比 bodyOk 早触发
    const hipsVisible = !!lms && [23, 24].every((i) => vis(i) >= f.minVisibility)

    let distance: StandDistance = 'none'
    let offset: StandOffset = 'none'
    let pose = 0
    let facing = 0
    let metrics: StandMetrics = EMPTY_METRICS

    if (bodyOk) {
      const shoulderMid = mid(at(11), at(12))
      const hipMid = mid(at(23), at(24))
      const ankleMid = mid(at(27), at(28))
      const torso = len(shoulderMid, hipMid)

      // ① 远近。两个信号：身高跨度，和脚踩在哪儿。同一个骨架算出来的，
      //    正常情况两者一致，一起判只是想在人只露半个身子时也能给个方向。
      const span = (ankleMid.y - shoulderMid.y) / f.box.h
      const foot = (ankleMid.y - (f.box.y + FIG.footY * f.box.h)) / f.box.h
      distance =
        span < SPAN_TARGET - SPAN_OK || foot < FOOT_UP
          ? 'far'
          : span > SPAN_TARGET + SPAN_OK || foot > FOOT_DOWN
            ? 'near'
            : 'ok'

      // ② 左右。归一化坐标是「画面（源图）」的左右，镜像开着的时候和观众
      //    看到的左右是反的 —— 提示语说的是画面，所以要翻一下。
      let dx = (hipMid.x - (f.box.x + FIG.centerX * f.box.w)) / f.box.w
      if (f.mirrored) dx = -dx
      offset = dx < -OFFSET_OK ? 'left' : dx > OFFSET_OK ? 'right' : 'ok'

      // ③ 姿势。两侧取最差的 —— 一只手垂着就不算插腰。
      if (torso > 1 && poseVisible) {
        const shoulderW = len(at(11), at(12))
        const hipW = len(at(23), at(24))
        pose = Math.min(
          armScore(at(11), at(13), at(15), at(23), shoulderMid.x, torso),
          armScore(at(12), at(14), at(16), at(24), shoulderMid.x, torso),
        )
        // 正面度：肩宽／髋宽，加左右肩的水平度。侧身时两个都会塌，
        // 那时候手腕多半还被身体挡住，不该放行。
        facing = Math.min(
          band(shoulderW / (hipW || 1), FACING_WIDTH[0], FACING_WIDTH[1], 0.4),
          rampDown(Math.abs(at(11).y - at(12).y) / (shoulderW || 1), 0.12, 0.3),
        )
      }

      metrics = { span, foot, offsetX: dx, pose, facing, torso }
    }

    const framed = bodyOk && distance === 'ok' && offset === 'ok'
    const poseOk = framed && pose >= POSE_OK && facing >= FACING_MIN

    // 已经定格的：只看人还在不在画面里，不看姿势 —— 接下来他要抬手去点
    // 文件夹，抬手姿势必然破，但站位还在，定格不该跟着作废。
    //
    // 这里必须当场 return：往下走就是「按姿势重算状态」那条路，姿势一破
    // 就会把 ready 降级成 framed，定格等于白做。
    if (this.state === 'ready') {
      if (framed) {
        this.lostMs = 0
        return this.report(distance, offset, true, hipsVisible, metrics)
      }
      this.lostMs += dt
      if (this.lostMs < READY_GRACE_MS) return this.report(distance, offset, true, hipsVisible, metrics)
      this.reset()
    }

    if (!framed) {
      this.state = 'idle'
      this.holdMs = 0
    } else if (poseOk) {
      this.holdMs += dt
      if (this.holdMs >= HOLD_MS) {
        this.holdMs = HOLD_MS
        this.state = 'ready'
      } else {
        this.state = 'holding'
      }
    } else {
      // 没命中时进度往回落，但不清零：手抖一下不至于从零重来
      this.holdMs = Math.max(0, this.holdMs - dt * HOLD_DECAY)
      this.state = this.holdMs > 0 ? 'holding' : 'framed'
    }

    return this.report(distance, offset, bodyOk, hipsVisible, metrics)
  }

  private report(
    distance: StandDistance,
    offset: StandOffset,
    hasBody: boolean,
    hipsVisible: boolean,
    metrics: StandMetrics,
  ): StandReport {
    return {
      state: this.state,
      distance,
      offset,
      hold: this.holdMs / HOLD_MS,
      hasBody,
      hipsVisible,
      metrics,
    }
  }
}
