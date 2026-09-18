import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

export interface Point { x: number; y: number }

interface Drop {
  x: number
  y: number
  vx: number
  vy: number
  len: number
  life: number
}

interface Splash {
  x: number
  y: number
  age: number
  life: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const mix = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * 人物跟随的云雨装置。不创建第二个渲染器：只在传入的 2D canvas 上绘制。
 * 坐标始终使用源画面坐标，镜像/旋转由 Stage 整体的 CSS transform 统一处理。
 */
export class CloudRainEffect {
  /** 用户想不想让它开着 —— 桌面图标/点云关闭都改这个，动画状态机跟着它走 */
  enabled = false
  raining = false

  /**
   * 开关动画状态机。closed/open 是稳定态，opening/closing 是过渡态：
   * 两朵云在过渡态里从屏幕外滑进来 / 滑出去，绳子、拉手、雨滴只在 open 时出现。
   */
  private phase: 'closed' | 'opening' | 'open' | 'closing' = 'closed'
  private phaseT = 0
  /** 这一段过渡是什么时候开始的（performance.now()）。进度直接从墙钟时间算，
   *  不靠每帧累加 dt —— dt 给雨滴物理用的钳制（最多按 50ms 一步）如果拿来算
   *  滑动进度，帧率一卡顿，滑动进度就会被同样按 50ms 封顶，等于走慢了，
   *  下一帧又一次性补上，看着一顿一顿的。直接拿当前时间减开始时间就没有这个问题，
   *  掉帧只是少画几帧，不会让动画本身变慢或抽搐。 */
  private phaseStartAt = 0
  private readonly SLIDE_MS = 550
  /** 最近一次算出来的布局，hitCloud() 要用它做命中判定 */
  private lastLayout: ReturnType<CloudRainEffect['layout']> | null = null

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null
  private cloudA = new Image()
  private cloudB = new Image()
  private handleImg = new Image()
  private drops: Drop[] = []
  private splashes: Splash[] = []
  private centerX = 0
  private personTop = 0
  private personWidth = 0
  private personHeight = 0
  private initialized = false
  private lastAt = 0
  private spawnCarry = 0

  private handle = { x: 0, restY: 0, y: 0, radius: 18 }
  private grabbedByHand = false
  private grabbedByPointer = false
  private pinchWasOn = false
  private triggeredThisPull = false

  private mask: Float32Array | null = null
  private maskW = 0
  private maskH = 0
  /** 高度是舞台高度比例，负数向上；大小是云层整体倍率。 */
  private heightOffset = -0.08
  private sizeScale = 1

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.cloudA.src = '/assets/cloud.png'
    this.cloudB.src = '/assets/cloud2.png'
    this.handleImg.src = '/assets/rope-handle-sheep.png'
  }

  /**
   * 开：closed → opening（从头滑入）；如果正好在往外滑，倒转过来接着滑回去，
   * 不会跳一下。关同理。已经在目标稳定态或者已经在朝目标过渡就什么都不做。
   */
  setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    const now = performance.now()
    // 正在过渡中被打断：先按墙钟算出此刻真实进度，再倒着接上，不会跳一下
    const cur = this.phase === 'opening' || this.phase === 'closing'
      ? clamp((now - this.phaseStartAt) / this.SLIDE_MS, 0, 1)
      : this.phaseT
    if (on) {
      // 云一打开就自己下雨，不用再靠拉绳子起步——绳子还在，开着之后拉一下
      // 照样能停/再开，走的是 pullTo() 里那条切换逻辑，这里只管「开了就下」
      this.raining = true
      if (this.phase === 'closed') {
        this.phase = 'opening'
        this.phaseStartAt = now
      } else if (this.phase === 'closing') {
        this.phase = 'opening'
        this.phaseStartAt = now - (1 - cur) * this.SLIDE_MS
      }
    } else {
      this.raining = false
      this.drops.length = 0
      this.splashes.length = 0
      this.release()
      if (this.phase === 'open') {
        this.phase = 'closing'
        this.phaseStartAt = now
      } else if (this.phase === 'opening') {
        this.phase = 'closing'
        this.phaseStartAt = now - (1 - cur) * this.SLIDE_MS
      }
    }
  }

  /** 手柄此刻在屏幕上的位置和半径（源画面坐标），没展开就是 null —— 给悬浮提示定位用 */
  getHandlePoint(): (Point & { radius: number }) | null {
    if (this.phase !== 'open') return null
    return { x: this.handle.x, y: this.handle.y, radius: this.handle.radius }
  }

  /** 「拉一下下雨」提示该不该显示：只在手/鼠标已经抓住手柄时才出现，确认「抓对了」 */
  get handleHintVisible(): boolean {
    return this.phase === 'open' && (this.grabbedByHand || this.grabbedByPointer)
  }

  /** 命中两朵云谁一朵都算，只在完全展开时才让点/捏关闭它 */
  hitCloud(p: Point): boolean {
    if (this.phase !== 'open' || !this.lastLayout) return false
    const l = this.lastLayout
    const inA = p.x >= l.leftX && p.x <= l.leftX + l.leftW && p.y >= l.top && p.y <= l.top + l.cloudH
    const inB = p.x >= l.rightX && p.x <= l.rightX + l.rightW && p.y >= l.top && p.y <= l.top + l.cloudH
    return inA || inB
  }

  setTuning(heightOffset: number, sizeScale: number) {
    this.heightOffset = clamp(heightOffset, -0.16, 0.1)
    this.sizeScale = clamp(sizeScale, 0.7, 1.5)
  }

  setMask(values: Float32Array | null, w = 0, h = 0) {
    this.mask = values
    this.maskW = w
    this.maskH = h
  }

  /** 鼠标测试：按住绳头、下拉、松开。开关动画没走完之前绳子够不着，不接。 */
  pointerDown(p: Point) {
    if (this.phase !== 'open' || Math.hypot(p.x - this.handle.x, p.y - this.handle.y) > this.handle.radius * 2.2) return
    this.grabbedByPointer = true
    this.triggeredThisPull = false
  }

  pointerMove(p: Point) {
    if (this.grabbedByPointer) this.pullTo(p.y)
  }

  pointerUp() {
    this.grabbedByPointer = false
  }

  /** 手部使用现有的捶合点；抓住后只跟随 y，横向不会把绳拉歪。 */
  updateHand(pinch: Point | null) {
    const on = !!pinch
    if (this.phase !== 'open') {
      this.pinchWasOn = on
      return
    }
    if (on && !this.pinchWasOn && pinch) {
      const hit = Math.hypot(pinch.x - this.handle.x, pinch.y - this.handle.y) <= this.handle.radius * 2.35
      if (hit) {
        this.grabbedByHand = true
        this.triggeredThisPull = false
      }
    }
    if (this.grabbedByHand && pinch) this.pullTo(pinch.y)
    if (!on && this.grabbedByHand) this.grabbedByHand = false
    this.pinchWasOn = on
  }

  update(now: number, w: number, h: number, lms?: NormalizedLandmark[]) {
    if (this.phase === 'closed' || !this.ctx || w <= 0 || h <= 0) {
      this.clear()
      return
    }
    this.resize(w, h)
    const dt = clamp(this.lastAt ? (now - this.lastAt) / 1000 : 1 / 60, 1 / 240, 0.05)
    this.lastAt = now

    if (this.phase === 'opening' || this.phase === 'closing') {
      // 按墙钟算，不按每帧的 dt 累加 —— 见 phaseStartAt 的注释
      this.phaseT = clamp((now - this.phaseStartAt) / this.SLIDE_MS, 0, 1)
      if (this.phaseT >= 1) {
        if (this.phase === 'opening') this.phase = 'open'
        else {
          this.phase = 'closed'
          this.clear()
          return
        }
      }
    }

    const box = this.personBounds(lms, w, h)
    const targetX = box ? (box.minX + box.maxX) / 2 : w * 0.5
    const targetTop = box?.minY ?? h * 0.2
    const targetWidth = box ? box.maxX - box.minX : w * 0.3
    const targetHeight = box ? box.maxY - box.minY : h * 0.62
    const follow = this.initialized ? 0.12 : 1
    this.centerX = mix(this.centerX, targetX, follow)
    this.personTop = mix(this.personTop, targetTop, follow)
    this.personWidth = mix(this.personWidth, targetWidth, follow)
    this.personHeight = mix(this.personHeight, targetHeight, follow)
    this.initialized = true

    const cloud = this.layout(w, h)
    this.lastLayout = cloud
    this.handle.x = cloud.cordX
    this.handle.restY = cloud.cordRestY
    if (!this.grabbedByHand && !this.grabbedByPointer) {
      this.handle.y = mix(this.handle.y || this.handle.restY, this.handle.restY, 0.18)
      if (Math.abs(this.handle.y - this.handle.restY) < 0.4) this.triggeredThisPull = false
    }
    this.handle.radius = clamp(cloud.personW * 0.055, 13, 23)

    // 绳子、雨滴只在完全展开时才有意义；开关过渡里只有两朵云在动
    if (this.phase === 'open') this.stepRain(dt, w, h, cloud)
    this.draw(w, h, cloud)
  }

  dispose() {
    this.clear()
    this.drops.length = 0
    this.splashes.length = 0
  }

  private release() {
    this.grabbedByHand = false
    this.grabbedByPointer = false
    this.pinchWasOn = false
    this.triggeredThisPull = false
  }

  private pullTo(y: number) {
    const maxPull = clamp(this.personHeight * 0.2, 95, 190)
    this.handle.y = clamp(y, this.handle.restY, this.handle.restY + maxPull)
    const trigger = maxPull * 0.52
    if (!this.triggeredThisPull && this.handle.y - this.handle.restY >= trigger) {
      this.raining = !this.raining
      this.triggeredThisPull = true
    }
  }

  private layout(w: number, h: number) {
    const personW = clamp(this.personWidth, w * 0.18, w * 0.48)
    const personH = clamp(this.personHeight, h * 0.35, h * 0.9)
    const totalW = clamp(personW * 1.75 * this.sizeScale, w * 0.27, w * 0.86)
    const cloudH = totalW * 0.235
    // 云的纵向位置固定贴近舞台顶部，只受 heightOffset 调节，不随人物上下移动而改变；
    // 横向仍通过 centerX 跟随人物。
    const top = clamp(h * (0.02 + this.heightOffset), h * 0.008, h * 0.28)
    const leftW = totalW * 0.53
    const rightW = totalW * 0.57
    const leftX = this.centerX - totalW * 0.52
    const rightX = this.centerX - totalW * 0.03
    const cordX = this.centerX - personW * 0.52
    const cordStartY = top + cloudH * 0.58
    const cordRestY = clamp(this.personTop + personH * 0.42, cordStartY + h * 0.2, h * 0.74)
    return {
      personW,
      totalW,
      cloudH,
      top,
      leftW,
      rightW,
      leftX,
      rightX,
      cordX,
      cordStartY,
      cordRestY,
      rainLeft: this.centerX - personW * 0.78,
      rainRight: this.centerX + personW * 0.78,
      rainY: top + cloudH * 0.7,
    }
  }

  private stepRain(dt: number, w: number, h: number, layout: ReturnType<CloudRainEffect['layout']>) {
    if (this.raining) {
      const rate = clamp(layout.totalW * 0.12, 42, 95)
      this.spawnCarry += rate * dt
      while (this.spawnCarry >= 1) {
        this.spawnCarry -= 1
        const speed = h * (0.78 + Math.random() * 0.42)
        this.drops.push({
          x: mix(layout.rainLeft, layout.rainRight, Math.random()),
          y: layout.rainY + Math.random() * layout.cloudH * 0.12,
          vx: -w * (0.012 + Math.random() * 0.018),
          vy: speed,
          len: clamp(h * (0.018 + Math.random() * 0.02), 11, 34),
          life: 2.5,
        })
      }
    }

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i]
      d.life -= dt
      const nextX = d.x + d.vx * dt
      const nextY = d.y + d.vy * dt
      if (this.hitPerson(nextX, nextY, w, h)) {
        if (this.splashes.length < 80) this.splashes.push({ x: nextX, y: nextY, age: 0, life: 0.28 })
        this.drops.splice(i, 1)
        continue
      }
      d.x = nextX
      d.y = nextY
      if (d.y > h + d.len || d.life <= 0) this.drops.splice(i, 1)
    }
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      this.splashes[i].age += dt
      if (this.splashes[i].age >= this.splashes[i].life) this.splashes.splice(i, 1)
    }
  }

  private hitPerson(x: number, y: number, w: number, h: number) {
    if (!this.mask || !this.maskW || !this.maskH) return false
    const mx = clamp(Math.round((x / w) * (this.maskW - 1)), 0, this.maskW - 1)
    const my = clamp(Math.round((y / h) * (this.maskH - 1)), 0, this.maskH - 1)
    return (this.mask[my * this.maskW + mx] ?? 0) > 0.54
  }

  /** smoothstep：两端速度是 0，滑进滑出不会有速度突变的顿挫感 */
  private static ease(t: number): number {
    return t * t * (3 - 2 * t)
  }

  private draw(w: number, h: number, l: ReturnType<CloudRainEffect['layout']>) {
    const ctx = this.ctx!
    ctx.clearRect(0, 0, w, h)

    const steady = this.phase === 'open'
    // presence：0 = 完全在屏幕外，1 = 完全到位。opening 从 0 到 1，closing 从 1 到 0
    const presence =
      this.phase === 'opening'
        ? CloudRainEffect.ease(this.phaseT)
        : this.phase === 'closing'
          ? 1 - CloudRainEffect.ease(this.phaseT)
          : 1
    // 滑出屏幕要留够距离，按舞台宽度走，跟人物大小没关系
    const slide = w * 0.55

    if (steady) {
      ctx.save()
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(225, 236, 245, 0.76)'
      ctx.lineWidth = clamp(w * 0.0015, 1.2, 2.5)
      for (const d of this.drops) {
        ctx.globalAlpha = clamp(d.life, 0, 1) * 0.9
        ctx.beginPath()
        ctx.moveTo(d.x, d.y)
        ctx.lineTo(d.x - d.vx / d.vy * d.len, d.y - d.len)
        ctx.stroke()
      }
      for (const s of this.splashes) {
        const p = s.age / s.life
        ctx.globalAlpha = 1 - p
        ctx.lineWidth = 1.3
        for (const dir of [-1, 1]) {
          ctx.beginPath()
          ctx.moveTo(s.x, s.y)
          ctx.lineTo(s.x + dir * (4 + p * 10), s.y - p * 7)
          ctx.stroke()
        }
      }
      ctx.restore()

      // 绳压在云后面，出发点被 PNG 的绒毛边盖住。
      ctx.save()
      ctx.strokeStyle = 'rgba(70, 68, 61, 0.78)'
      ctx.lineWidth = clamp(l.personW * 0.006, 1.2, 2.4)
      ctx.beginPath()
      ctx.moveTo(l.cordX, l.cordStartY)
      ctx.lineTo(this.handle.x, this.handle.y)
      ctx.stroke()
      ctx.restore()
    }

    // 左边那朵从左边滑进/滑出，右边那朵从右边 —— 两朵各走各的方向，不会交叉
    const cloudAx = l.leftX - (1 - presence) * slide
    const cloudBx = l.rightX + (1 - presence) * slide
    ctx.save()
    ctx.globalAlpha = presence
    if (this.cloudA.complete && this.cloudA.naturalWidth) {
      ctx.drawImage(this.cloudA, cloudAx, l.top, l.leftW, l.cloudH)
    }
    if (this.cloudB.complete && this.cloudB.naturalWidth) {
      ctx.drawImage(this.cloudB, cloudBx, l.top + l.cloudH * 0.08, l.rightW, l.cloudH * 0.76)
    }
    ctx.restore()

    if (!steady) return

    const pulling = this.grabbedByHand || this.grabbedByPointer
    ctx.save()
    ctx.shadowColor = pulling ? 'rgba(135, 192, 226, 0.72)' : 'rgba(0, 0, 0, 0.16)'
    ctx.shadowBlur = pulling ? 15 : 8
    if (this.raining) {
      // 图片本身不换色，下雨状态原来靠圆变蓝表示，这里改成图下面一圈淡蓝光晕
      ctx.beginPath()
      ctx.fillStyle = 'rgba(131, 201, 238, 0.35)'
      ctx.arc(this.handle.x, this.handle.y, this.handle.radius * 1.3, 0, Math.PI * 2)
      ctx.fill()
    }
    if (this.handleImg.complete && this.handleImg.naturalWidth) {
      // 比原来的圆大 2 倍：长边按原直径的 2 倍算，短边跟着图片原比例走，不拉伸变形
      const target = this.handle.radius * 4
      const iw = this.handleImg.naturalWidth
      const ih = this.handleImg.naturalHeight
      const scale = target / Math.max(iw, ih)
      const dw = iw * scale
      const dh = ih * scale
      ctx.drawImage(this.handleImg, this.handle.x - dw / 2, this.handle.y - dh / 2, dw, dh)
    } else {
      // 图片还没加载完时的兜底，不然绳头会凭空消失
      ctx.beginPath()
      ctx.fillStyle = this.raining ? '#83c9ee' : '#d8d8d4'
      ctx.arc(this.handle.x, this.handle.y, this.handle.radius, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  private personBounds(lms: NormalizedLandmark[] | undefined, w: number, h: number) {
    if (!lms?.length) return null
    const ids = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
    const pts = ids.map((i) => lms[i]).filter((p) => p && (p.visibility ?? 1) > 0.36)
    if (pts.length < 5) return null
    const xs = pts.map((p) => p.x * w)
    const ys = pts.map((p) => p.y * h)
    let minX = Math.min(...xs)
    let maxX = Math.max(...xs)
    let minY = Math.min(...ys)
    let maxY = Math.max(...ys)
    const shoulder = lms[11] && lms[12] ? Math.abs(lms[11].x - lms[12].x) * w : maxX - minX
    const padX = Math.max(shoulder * 0.42, (maxX - minX) * 0.08)
    minX = clamp(minX - padX, 0, w)
    maxX = clamp(maxX + padX, 0, w)
    minY = clamp(minY, 0, h)
    maxY = clamp(maxY, minY + 1, h)
    return { minX, maxX, minY, maxY }
  }

  private resize(w: number, h: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const pw = Math.max(1, Math.round(w * dpr))
    const ph = Math.max(1, Math.round(h * dpr))
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw
      this.canvas.height = ph
    }
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private clear() {
    if (!this.ctx) return
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }
}
