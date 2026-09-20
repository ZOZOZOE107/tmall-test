/**
 * 桌面上的衣橱文件夹。
 *
 * 一条流程，鼠标和手势走同一套：
 *   1. 光标停在文件夹上 → 四件衣服扇出来（收起态和展开态的数值都抄自 Figma）
 *   2. 光标碰到某一件 → 那件稍微放大抬起，红环开始转
 *   3. 停满 4 秒 → 直接换到身上
 *
 * 「光标」是鼠标指针，或者比「1」时食指的 8 号点，两者取其一喂进同一个状态机。
 * 手势优先 —— 有人在比手势的时候，鼠标停在哪儿不该抢。
 */
import { gsap } from 'gsap'
import type { MeshGarmentConfig } from '../core/garment-mesh'

/**
 * 指尖光标全局只有一个 —— 桌面上挂着四个文件夹，每个都造一个的话会在同一个位置
 * 叠四个红点。它们收到的是同一个指尖坐标，共用一个就够。
 */
/**
 * 鼠标位置也全局收一次。四个文件夹各挂一个 pointermove、各做一次
 * getBoundingClientRect，鼠标一动就是四次强制布局 —— 这里只存原始屏幕坐标，
 * 换算推迟到每帧的 tick 里做。
 */
let mouseClient: { x: number; y: number } | null = null
/** 最近被操作的文件夹永远排在其他文件夹之上。 */
let folderStack = 10

/**
 * 桌面上所有文件夹。感应区重叠时要比一比谁离光标近，所以得互相看得见。
 */
const instances: WardrobeFolder[] = []
/**
 * 同一时刻只有一个文件夹响应光标。
 *
 * 展开之后扇出来的卡片会盖到隔壁文件夹的感应区上 —— 不独占的话，指着这张卡的同时
 * 隔壁也在弹开、也在数它自己的进度环，停满了还会替你穿一件。占用一直保持到光标
 * 真的离开这个文件夹（含它的扇形）为止。
 */
let holder: WardrobeFolder | null = null
window.addEventListener('pointermove', (ev) => {
  mouseClient = { x: ev.clientX, y: ev.clientY }
})

/* ── 图标的实心形状 ─────────────────────────────────────────────
 * macOS 那几张图标 PNG 四周都留着透明边，<img> 却是整块方的在接事件 ——
 * 点在文件夹左上那块空气上照样能把它拖走，这块空气还会盖住压在底下的图标。
 * 所以按下时查一次真实 alpha，透明的地方当作没点到。
 */

/** alpha 采样密度。图标画出来也就几十个 px，64×64 够细了，一张图 4KB */
const ALPHA_GRID = 64
/** 低于这个 alpha 算透明。留一点余量，图标边缘的反锯齿不至于变成一圈点不着的壳 */
const ALPHA_MIN = 24
/** .folder-icon 的边长占 --folder 的比例，必须和 folder.css 里那行一致 */
const ICON_DRAW = 0.8

/** renderDesktopIcon() 画标签文字用的字体/颜色，抄自 tokens.css 的 --font-family / --color-cut-white / --color-cut-shadow——canvas 认不得 CSS 变量，只能抄一份字面量 */
const DESKTOP_LABEL_FONT = "'TikTok Sans', -apple-system, system-ui, sans-serif"
const DESKTOP_LABEL_COLOR = '#ffffff'
const DESKTOP_LABEL_SHADOW = 'rgba(0, 0, 0, 0.18)'
/**
 * 碰图标时往外放宽多少（图标边长的倍数）。手会抖，不留一点余量很难碰准；
 * 但必须小于图标自己那圈透明边，否则等于又把空气算回来了。
 */
const ART_PAD = 0.04
/** 碰到图标时缩到多大。8% 够看出「被按下去了」，又不至于让图标跳一下 */
const TOUCH_SCALE = 0.92

/**
 * --folder 的像素上下限。size 是「占舞台宽度的比例」，但舞台宽度本身会被
 * Fit Best 的letterbox/pillarbox 挤压——同样判成 portrait，长宽比稍微一变，
 * 舞台内容宽度就可能腰斩或翻倍，图标跟着忽大忽小。夹一个绝对像素范围兜底，
 * 中间正常尺寸不受影响，只在极端比例下托底/封顶。
 */
const FOLDER_MIN_PX = 56
const FOLDER_MAX_PX = 70

interface IconMask {
  /** ALPHA_GRID² 个 alpha 采样，按行存 */
  a: Uint8ClampedArray
  /** 实心像素的外接矩形，归一化到 0..1 */
  box: { x0: number; y0: number; x1: number; y1: number }
}
/** 按 src 缓存。四个文件夹共用同一张 folder-macos.png，只解一次 */
const masks = new Map<string, IconMask | null>()

function loadMask(src: string) {
  if (masks.has(src)) return
  masks.set(src, null) // 先占位，同一张图别排队解好几遍
  const img = new Image()
  img.decoding = 'async'
  img.onload = () => {
    try {
      const cv = document.createElement('canvas')
      cv.width = ALPHA_GRID
      cv.height = ALPHA_GRID
      const cx = cv.getContext('2d')
      if (!cx) return
      cx.drawImage(img, 0, 0, ALPHA_GRID, ALPHA_GRID)
      const px = cx.getImageData(0, 0, ALPHA_GRID, ALPHA_GRID).data
      const a = new Uint8ClampedArray(ALPHA_GRID * ALPHA_GRID)
      let x0 = ALPHA_GRID
      let y0 = ALPHA_GRID
      let x1 = -1
      let y1 = -1
      for (let i = 0; i < a.length; i++) {
        const v = px[i * 4 + 3]
        a[i] = v
        if (v < ALPHA_MIN) continue
        const x = i % ALPHA_GRID
        const y = (i / ALPHA_GRID) | 0
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
      if (x1 < 0) return // 整张全透明，当没有蒙版处理，退回整块方的
      masks.set(src, {
        a,
        box: {
          x0: x0 / ALPHA_GRID,
          y0: y0 / ALPHA_GRID,
          x1: (x1 + 1) / ALPHA_GRID,
          y1: (y1 + 1) / ALPHA_GRID,
        },
      })
    } catch {
      // 读不出像素（跨域之类）就退回整块方的，至少还点得动
    }
  }
  img.src = src
}

/**
 * 归一化坐标 (u, v) 处是不是图标的实心部分。
 * 蒙版还没解出来就当实心 —— 宁可多接一下，也不能出现「图标在那儿却点不动」。
 *
 * @param slack 容差，单位是采样格。指针落在边缘的反锯齿上也算点中
 */
function opaqueAt(src: string, u: number, v: number, slack = 1): boolean {
  if (u < 0 || u > 1 || v < 0 || v > 1) return false
  const m = masks.get(src)
  if (!m) return true
  const cx = Math.floor(u * ALPHA_GRID)
  const cy = Math.floor(v * ALPHA_GRID)
  for (let y = cy - slack; y <= cy + slack; y++) {
    if (y < 0 || y >= ALPHA_GRID) continue
    for (let x = cx - slack; x <= cx + slack; x++) {
      if (x < 0 || x >= ALPHA_GRID) continue
      if (m.a[y * ALPHA_GRID + x] >= ALPHA_MIN) return true
    }
  }
  return false
}

/**
 * 拖过的位置存在本地，刷新不丢 —— 四个文件夹一个个摆好，一刷新全回原位就没法排版了。
 * 定好之后把 __folderPos() 打出来的坐标抄回 main.ts 的 FOLDER_AT，再 __folderReset() 清掉。
 */
const AT_KEY = (id: string) => `aoe.folder.at.${id}`
function loadAt(id: string): V2 | null {
  try {
    const raw = localStorage.getItem(AT_KEY(id))
    if (!raw) return null
    const v = JSON.parse(raw)
    return typeof v?.x === 'number' && typeof v?.y === 'number' ? v : null
  } catch {
    return null
  }
}
function saveAt(id: string, at: V2) {
  try {
    localStorage.setItem(AT_KEY(id), JSON.stringify({ x: +at.x.toFixed(4), y: +at.y.toFixed(4) }))
  } catch {
    // 无痕模式之类写不进去，拖动照样生效，只是刷新会丢
  }
}

let sharedCursor: HTMLElement | null = null
function getCursor(host: HTMLElement): HTMLElement {
  if (!sharedCursor?.isConnected) {
    sharedCursor = document.createElement('div')
    sharedCursor.className = 'folder-cursor'
    host.append(sharedCursor)
  }
  return sharedCursor
}

interface V2 {
  x: number
  y: number
}

export type PieceSlot = 'top' | 'bottom'

export interface FolderPiece {
  id: string
  /** 平铺 PNG，和主页面穿的是同一张图；照片就是抓拍下来的那张 */
  src: string
  /** 衣服才有。照片没有，所以是可选的 */
  slot?: PieceSlot
  cfg?: MeshGarmentConfig
  /** 整套透明图通过 look 选择，不走单件网格。 */
  look?: { theme: string; id: string }
}

/** 扇形里每张卡的位置，单位是「文件夹图标边长」的倍数，原点在图标中心 */
interface FanSlot {
  /** 展开态 */
  x: number
  y: number
  rot: number
  w: number
  h: number
  /** 收起态（缩在文件夹里） */
  restX: number
  restY: number
  restS: number
}

/** 抄自 Figma：121:562 是收起态，112:1620 是展开态，除以图标边长归一化 */
const FAN: FanSlot[] = [
  { x: -0.762, y: -0.653, rot: -23.66, w: 1.048, h: 1.048, restX: -0.237, restY: 0.029, restS: 0.561 },
  { x: -0.358, y: -1.139, rot: -5.03, w: 0.896, h: 0.89, restX: -0.05, restY: 0.092, restS: 0.561 },
  { x: 0.146, y: -0.777, rot: 14.18, w: 0.868, h: 0.949, restX: 0.075, restY: 0.154, restS: 0.436 },
  { x: 0.743, y: -0.704, rot: 18.62, w: 1.012, h: 1.007, restX: 0.199, restY: 0.06, restS: 0.623 },
]

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * 按件数生成扇形。
 *
 * Figma 只画了四件的版本，但「长期主义生活家」只有三件上下装。把那四个位置当成
 * 一条连续扇形曲线上 u = 0 / ⅓ / ⅔ / 1 处的采样，要几件就在 u 上等分几份重新采 ——
 * 三件时中间那张落在原来第 2、3 张中间，左右两端不动，扇形轮廓还是原来那条。
 */
function fanFor(n: number): FanSlot[] {
  if (n <= 0) return [] // 空文件夹：只有图标和名字，没有扇形
  if (n >= FAN.length) return FAN.slice(0, FAN.length)
  if (n === 1) return [FAN[1]] // 只有一件就摆在最高那个位置
  const last = FAN.length - 1
  return Array.from({ length: n }, (_, i) => {
    const u = (i / (n - 1)) * last
    const lo = Math.floor(u)
    const hi = Math.min(last, Math.ceil(u))
    const t = u - lo
    const a = FAN[lo]
    const b = FAN[hi]
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      rot: lerp(a.rot, b.rot, t),
      w: lerp(a.w, b.w, t),
      h: lerp(a.h, b.h, t),
      restX: lerp(a.restX, b.restX, t),
      restY: lerp(a.restY, b.restY, t),
      restS: lerp(a.restS, b.restS, t),
    }
  })
}

/**
 * 把整套扇形绕图标中心转一个角度，让它整体偏向 `side` 那一侧 —— 不拆散重排
 * 哪张卡在哪，还是原来那套 Figma 扇形的相对形状，只是当一个整体转了个方向，
 * 转过去之后自然就没有卡牌伸向贴边那一侧了。
 *
 * x/y 是位置，转一下就好；rot 是卡牌自己的朝向，得跟着加同样的角度，不然卡牌
 * 位置转了但卡面朝向没变，看着就是「歪了」而不是「转了」。restX/restY 同理转一下，
 * 收起态里那一小撮堆叠也跟着扇形一起偏，不会显得和展开态对不上。
 */
function rotateFanInward(fan: FanSlot[], side: 'left' | 'right', deg: number): FanSlot[] {
  const signed = side === 'right' ? deg : -deg
  const a = (signed * Math.PI) / 180
  const co = Math.cos(a)
  const si = Math.sin(a)
  const turn = (x: number, y: number) => ({ x: x * co - y * si, y: x * si + y * co })
  return fan.map((f) => {
    const p = turn(f.x, f.y)
    const r = turn(f.restX, f.restY)
    return { ...f, x: p.x, y: p.y, rot: f.rot + signed, restX: r.x, restY: r.y }
  })
}
/** 转多少度。太小看不出效果，太大扇形会歪得不像原来的样子 */
const FAN_TILT_DEG = 26

/** 碰到的那件抬起多少、放大多少。单位同样是图标边长的倍数 */
const AIM_LIFT = 0.14
const AIM_SCALE = 1.12

/**
 * 停留多久算「就它了」。三种文件夹三个时长 ——
 * 穿衣服是主动作给得久一点，脱衣服和删照片都是撤销类操作，短一些更顺手。
 */
const DWELL_BY_MODE = { wear: 2000, photo: 3000, trash: 2000 } as const
type FolderMode = keyof typeof DWELL_BY_MODE

/** 手势丢了多久才算手真的收回去 —— 手部识别会闪，丢一两帧不能就把进度清零 */
const GESTURE_GRACE_MS = 600
/** 光标抖出目标多久才算移开 */
const AIM_GRACE_MS = 260

export interface FolderOptions {
  /** 挂载点，必须在 #stage 里 —— 舞台就是视频矩形，人体坐标零偏移 */
  host: HTMLElement
  /** 主题 id，拖动后的位置按这个存 localStorage */
  id: string
  label: string
  /** 名字下面那一行小字，没有就不显示——摆设图标（废纸篓、截屏）不传 */
  brand?: string
  pieces: FolderPiece[]
  /**
   * 文件夹装的是什么，决定停满之后干嘛：
   *   wear   = 衣柜里的衣服，停满飞到身上（默认）
   *   photo  = 拍下来的照片，停满删掉
   *   trash  = 身上正穿着的，停满脱下来扔进去
   */
  mode?: FolderMode
  /** 图标图片。默认是那个蓝文件夹；桌面上的其他 macOS 图标换这个就行 */
  icon?: string
  /** 图标配色。grey = 白灰，蓝色那张 PNG 走 CSS 滤镜转过去 */
  tone?: 'blue' | 'grey'
  /** 标签前那个小圆点的颜色，用主题色区分四个文件夹 */
  dot?: string
  /** 进度环的颜色。同色相的高饱和版本 —— 压在实拍画面上要跳得出来 */
  ring?: string
  /** 图标未展开、指向/悬停图标时的极简提示；不传就用通用的「按住拖动」 */
  iconHint?: string
  /** 展开后指向/停留某张卡片时的极简提示；不传就不显示 */
  cardHint?: string
  /** 文件夹图标中心在舞台里的归一化位置 */
  at: { x: number; y: number }
  /** 文件夹图标边长，占舞台宽度的比例 */
  size: number
  /** 舞台内容尺寸（px） */
  stageSize: () => { w: number; h: number }
  /** 屏幕坐标 → 舞台本地坐标 */
  toLocal: (clientX: number, clientY: number) => V2
  /** @param from 衣服从哪儿飘出来（文件夹图标的矩形，舞台坐标） */
  onWear: (piece: FolderPiece, from: { x: number; y: number; w: number; h: number }) => void
  /** photo / trash 模式下停满时调。photo 给的是照片下标，trash 给的是身上那件 */
  onDelete?: (piece: FolderPiece, index: number) => void
  /**
   * 手指/光标压在图标本身（不是扇形卡片）上满 3 秒才触发，和 mode 的停留删除是两套独立计时。
   * `ready()` 每帧都会问——只有它返回 true 才开始计时、才会显示进度环；返回 false 时
   * （比如照片没攒够 4 张）摸多久都没反应，不单独提示「还差几张」。
   */
  onIconDwell?: {
    ready: () => boolean
    fire: () => void
    /** 不传时沿用打印/截屏的 3 秒；衣服同款隔空操作可传 2 秒。 */
    durationMs?: number
  }
  /** 图标自身的一次轻点；组件内部会排除拖动，避免页面外围猜命中区域。 */
  onIconClick?: () => void
}

/** 长按图标触发 onIconDwell 要多久 */
const ICON_DWELL_MS = 3000
/** 指针移动不超过这个距离才算点击；超过后只拖动，不触发 onIconClick。 */
const ICON_CLICK_SLOP = 7

export class WardrobeFolder {
  private root: HTMLElement
  private cardBox: HTMLElement
  /** 这个文件夹的扇形位置表，按实际件数生成，已经按当前位置转好方向 */
  private fan: FanSlot[] = []
  /** 转方向之前的原始扇形，靠边判定要重算时从这份重新转，不能拿转过的再转一次 */
  private fanFlat: FanSlot[] = []
  private cards: HTMLElement[] = []
  /** 当前装着的东西。照片模式下会随时增删 */
  private pieces: FolderPiece[] = []
  /**
   * 正在飞向身体的那些卡。扇形的收放不许碰它们。
   * 用集合而不是单个下标 —— 手指/鼠标停在同一个展开的扇形里连续选中两件
   * （比如上装选完接着选下装）时，两张卡会同时处于「已经飞出去，等光标
   * 离开才解除隐藏」的状态，单个下标会被第二次覆盖，第一张就永远卡在隐藏里。
   */
  private flying = new Set<number>()
  private fly: gsap.core.Timeline | null = null
  /** 正在跑的那次扇形收放动画。卡片一重建就得先掐掉它 */
  private fanTl: gsap.core.Tween | null = null
  private ring: HTMLElement
  private iconHintEl: HTMLElement
  private cardHintEl: HTMLElement | null
  private icon!: HTMLElement
  /** 图标图片的地址，alpha 蒙版按它取 */
  private iconSrc = ''
  /** 标签前那个小圆点，截屏合成桌面图标时要读它算出来的实际颜色（opts.dot 可能是 var(...)，canvas 认不得） */
  private dotEl!: HTMLElement
  private cursor: HTMLElement
  private opts: FolderOptions

  private open = false
  /** 光标此刻压在图标上。图标缩一下的动画按这个翻转 */
  private touched = false
  /** 上一次布局用的图标边长，变了才重新摆卡片 */
  private lastSize = -1

  /**
   * 图标中心在舞台里的归一化位置。是 opts.at 的副本 —— 拖动会改写它，
   * 不能直接动 main.ts 里那个常量对象。
   */
  private at: V2
  /** 正在被鼠标拖着挪位置 */
  private moving = false

  /** 手势指尖 */
  private tip: V2 | null = null
  private tipAt = 0

  private aimIndex = -1
  private aimFrom = 0
  private aimLostAt = 0
  /** 刚穿上的那件。光标离开它之前不再重新计时，否则会连着穿好几次 */
  private lockIndex = -1

  /** 长按图标（onIconDwell）计时。0 = 没在数 */
  private iconDwellFrom = 0
  /** 这一次按住已经触发过了，按住不放也不再重复发 */
  private iconDwellFired = false

  constructor(opts: FolderOptions) {
    this.opts = opts
    this.at = loadAt(opts.id) ?? { ...opts.at }

    const root = document.createElement('div')
    root.className = 'folder'
    if (opts.tone) root.dataset.tone = opts.tone
    root.innerHTML = `
      <div class="folder-cards"></div>
      <img class="folder-icon" src="${opts.icon ?? '/assets/folder-macos.png'}" alt="" draggable="false" />
      <span class="folder-label"><i></i><span class="folder-label-text"><span class="folder-label-name"></span><span class="folder-label-brand"></span></span></span>
      <span class="hint-tag folder-icon-hint"></span>
    `
    root.querySelector('.folder-label-name')!.textContent = opts.label
    const brandEl = root.querySelector('.folder-label-brand') as HTMLElement
    // 摆设图标（废纸篓、截屏那些）没有品牌，这一行就不显示
    if (opts.brand) brandEl.textContent = opts.brand
    else brandEl.remove()
    this.dotEl = root.querySelector('.folder-label > i') as HTMLElement
    // 没给颜色就不显示那个小圆点 —— 废纸篓、截屏这类系统图标本来也没有
    if (opts.dot) this.dotEl.style.background = opts.dot
    else this.dotEl.style.display = 'none'

    this.cardBox = root.querySelector('.folder-cards') as HTMLElement
    this.pieces = opts.pieces

    this.iconHintEl = root.querySelector('.folder-icon-hint') as HTMLElement
    this.iconHintEl.textContent = opts.iconHint ?? '按住拖动'

    this.ring = document.createElement('div')
    this.ring.className = 'folder-dwell'
    this.ring.innerHTML = '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" /><circle cx="20" cy="20" r="18" class="bar" /></svg>'
    this.ring.style.setProperty('--dwell', `${DWELL_BY_MODE[opts.mode ?? 'wear']}ms`)
    if (opts.ring) this.ring.style.setProperty('--dwell-color', opts.ring)

    // 展开后停在某张卡片上的极简提示，只有传了 cardHint 才造这个元素
    this.cardHintEl = opts.cardHint
      ? (() => {
          const el = document.createElement('div')
          el.className = 'hint-tag folder-card-hint'
          el.textContent = opts.cardHint!
          return el
        })()
      : null

    this.root = root
    this.icon = root.querySelector('.folder-icon') as HTMLElement
    // 居中交给 GSAP —— bump() 要写 transform，和 CSS 的 translate(-50%) 会打架
    gsap.set(this.icon, { xPercent: -50, yPercent: -50 })
    // 图标本身接鼠标：按住它就能把整个文件夹拖到画面里任意位置。
    // 只认画出来的那块实心像素，四周的透明边不接
    this.iconSrc = opts.icon ?? '/assets/folder-macos.png'
    loadMask(this.iconSrc)
    this.icon.addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent
      if (!this.hitsArt(ev.clientX, ev.clientY)) {
        this.passThrough(ev)
        return
      }
      this.bringToFront()
      this.startMove(ev)
    })
    opts.host.append(root, this.ring)
    if (this.cardHintEl) opts.host.append(this.cardHintEl)
    // 指尖光标：让人看见系统认为他的手指在哪，不然对不准只能瞎猜
    this.cursor = getCursor(opts.host)

    // 必须排在 ring / cursor 之后 —— buildCards 会调 hideRing 和 layout，
    // 它俩都要用到 this.ring
    this.buildCards()
    this.layout()
    instances.push(this)
  }

  /**
   * 按当前 pieces 重建卡片。照片是拍一张加一张的，不能只在构造时建一次。
   */
  private buildCards() {
    this.fanTl?.kill()
    this.fanTl = null
    gsap.killTweensOf(this.cards)
    this.cardBox.innerHTML = ''
    this.cards = []
    this.fanFlat = fanFor(Math.min(this.pieces.length, FAN.length))
    this.refreshFan()
    this.pieces.slice(0, this.fan.length).forEach((p, i) => {
      const card = document.createElement('div')
      card.className = 'folder-card'
      card.dataset.piece = p.id
      card.style.setProperty('--w', String(this.fan[i].w))
      card.style.setProperty('--h', String(this.fan[i].h))
      card.innerHTML = `<img src="${p.src}" alt="" draggable="false" />`
      this.cardBox.append(card)
      this.cards.push(card)
    })
    // 位移全部交给 GSAP，居中用 xPercent/yPercent —— 和 CSS 各写各的 transform 会打架
    gsap.set(this.cards, { xPercent: -50, yPercent: -50 })
    this.aimIndex = -1
    this.lockIndex = -1
    this.flying.clear()
    this.hideRing()
    this.lastSize = -1 // 逼 layout() 重新摆一遍
    this.layout()
  }

  /** 离哪边够近算「贴边」——两边各占屏幕这么宽的一条带，中间照常打开 */
  private static readonly EDGE_ZONE = 0.3

  /**
   * 自己知道现在是不是贴着边：贴左边就该往右转，贴右边就该往左转，
   * 中间（没贴任何一边）就是 null，用原始 Figma 扇形，不转。
   */
  private fanSideAuto(): 'left' | 'right' | null {
    if (this.at.x < WardrobeFolder.EDGE_ZONE) return 'right'
    if (this.at.x > 1 - WardrobeFolder.EDGE_ZONE) return 'left'
    return null
  }

  /**
   * 按此刻的位置重新决定扇形转不转、往哪转。文件夹是先拖动关闭扇形、放开手才
   * 重新展开的（见 startMove 里的 setOpen(false)），所以只要在「真正要打开」
   * 之前调用这个，就总能拿到跟当前位置匹配的方向，不用每帧都重算。
   */
  private refreshFan() {
    const side = this.fanSideAuto()
    this.fan = side ? rotateFanInward(this.fanFlat, side, FAN_TILT_DEG) : this.fanFlat
  }

  /** 换一批内容（照片加一张、删一张都走这里） */
  setPieces(pieces: FolderPiece[]) {
    this.pieces = pieces
    this.buildCards()
    if (this.open) this.placeCards()
  }

  /**
   * --folder 的实际像素值，夹了上下限（见 FOLDER_MIN_PX/MAX_PX）。所有跟
   * 图标尺寸相关的计算（热区、判定半径……）都要走这个，不能各自现算
   * this.opts.size * w，否则视觉尺寸和交互判定会对不上。
   */
  private folderSize(w: number): number {
    return Math.min(FOLDER_MAX_PX, Math.max(FOLDER_MIN_PX, this.opts.size * w))
  }

  /** 舞台尺寸变了要重新摆位，每帧调一次也不贵 */
  layout() {
    const { w, h } = this.opts.stageSize()
    if (!w || !h) return
    const size = this.folderSize(w)
    this.root.style.setProperty('--folder', `${size}px`)
    this.root.style.left = `${this.at.x * w}px`
    this.root.style.top = `${this.at.y * h}px`
    this.ring.style.setProperty('--dwell-size', `${this.ringSize(w)}px`)
    if (size !== this.lastSize) {
      this.lastSize = size
      this.placeCards(true)
    }
  }

  /* ── 扇形 ─────────────────────────────────────────────────── */

  /** 整个文件夹连同弹出内容一起升到所有其他 icon 之上。 */
  private bringToFront() {
    this.root.style.zIndex = String(++folderStack)
  }

  /** 某张卡此刻该在哪儿：收起 / 展开 / 展开且被指着，三种状态 */
  private target(i: number) {
    const s = this.lastSize
    const f = this.fan[i]
    // 这张卡已经不在扇形里了（件数刚变过，或者元素已被换掉，indexOf 给的是 -1）。
    // 给个「收在文件夹里且透明」的安全值就行 —— 让它抛出去会把 GSAP 这一帧的
    // 整条渲染链打断，同一帧其他动画全部停摆，看起来就是卡住
    if (!f) return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0 }
    if (!this.open) {
      return { x: f.restX * s, y: f.restY * s, scale: f.restS, rotation: 0, opacity: 0 }
    }
    const aimed = i === this.aimIndex
    return {
      x: f.x * s,
      y: (f.y - (aimed ? AIM_LIFT : 0)) * s,
      scale: aimed ? AIM_SCALE : 1,
      rotation: f.rot,
      opacity: 1,
    }
  }

  /**
   * 展开用 back.out 带一点回弹、四张错开起跑，像被一张张抽出来；
   * 收回去要干脆，所以用 power2.in 且时间短一半。
   */
  private placeCards(immediate = false) {
    if (this.lastSize < 0) return
    const targets = this.cards.filter((_, i) => !this.flying.has(i))
    if (!targets.length) return
    // 值按「这个元素是第几张卡」来取，不能用 tween 里的下标 —— 飞行中的那张被排除了，
    // 两套下标会错位
    const of = (el: Element) => this.target(this.cards.indexOf(el as HTMLElement))
    const vars = {
      x: (_: number, el: Element) => of(el).x,
      y: (_: number, el: Element) => of(el).y,
      scale: (_: number, el: Element) => of(el).scale,
      rotation: (_: number, el: Element) => of(el).rotation,
      opacity: (_: number, el: Element) => of(el).opacity,
    }
    if (immediate) {
      gsap.set(targets, vars)
      return
    }
    // 存下这次动画：件数一变就得先掐掉它。stagger 生成的是一条内部时间线，
    // killTweensOf 够不到里面还没初始化的子 tween —— 它们要等到自己起跑那一刻
    // 才去问「这张卡是第几张」，那时卡片已经换了一批，问出来是 -1
    this.fanTl?.kill()
    this.fanTl = gsap.to(targets, {
      ...vars,
      duration: this.open ? 0.42 : 0.2,
      ease: this.open ? 'back.out(1.5)' : 'power2.in',
      stagger: this.open ? 0.045 : { each: 0.03, from: 'end' },
      overwrite: 'auto',
    })
  }

  /** 只动被指着的那张和上一张，别把整排都重新弹一遍 */
  private refreshAim(prev: number) {
    // 小图被指到时，整个卡片层越过文件夹 icon；当前小图再越过同组其他小图。
    this.cardBox.style.zIndex = this.aimIndex >= 0 ? '3' : '1'
    this.cards.forEach((card, i) => {
      card.style.zIndex = i === this.aimIndex ? '10' : '1'
    })
    for (const i of [prev, this.aimIndex]) {
      if (i < 0 || this.flying.has(i) || !this.cards[i]) continue
      gsap.to(this.cards[i], {
        ...this.target(i),
        duration: 0.26,
        ease: 'back.out(2)',
        overwrite: 'auto',
      })
    }
  }

  private setOpen(v: boolean) {
    if (this.open === v) return
    // 每次真正展开前才重新判一次贴边方向——文件夹可能刚被拖到别的位置
    if (v) this.refreshFan()
    if (v) this.bringToFront()
    this.open = v
    if (!v) this.clearAim()
    this.placeCards()
  }

  /* ── 命中判定 ───────────────────────────────────────────────── */

  /** 这一点是不是落在图标画出来的实心像素上（屏幕坐标，按下时用） */
  private hitsArt(clientX: number, clientY: number): boolean {
    const r = this.icon.getBoundingClientRect()
    if (!r.width || !r.height) return false
    return opaqueAt(this.iconSrc, (clientX - r.left) / r.width, (clientY - r.top) / r.height)
  }

  /** 这个文件夹压在多高的层上。数字大的盖住数字小的，一样高就看谁后建（DOM 在后的在上） */
  private depth(): number {
    return +(this.root.style.zIndex || 0)
  }

  /**
   * 按在透明边上：把这一下让给压在底下的图标。
   *
   * 图标的方框互相叠着，不转交的话，后面那个图标明明画在这儿却按不动。
   * 直接在实例里按层级从高到低找第一个「点在实心像素上」的。
   */
  private passThrough(ev: PointerEvent) {
    let target: WardrobeFolder | null = null
    for (const f of instances) {
      if (f === this || !f.hitsArt(ev.clientX, ev.clientY)) continue
      // 同层的话后建的在上面，instances 就是建的顺序，所以 >= 一路取到最后一个
      if (!target || f.depth() >= target.depth()) target = f
    }
    if (!target) return
    target.bringToFront()
    target.startMove(ev)
  }

  /**
   * 图标实心部分的外接矩形，舞台坐标。
   * 透明边不算进来 —— 这块矩形就是「图标本身」。
   */
  private artBox(w: number, h: number) {
    const d = this.folderSize(w) * ICON_DRAW
    const x0 = this.at.x * w - d / 2
    const y0 = this.at.y * h - d / 2
    const b = masks.get(this.iconSrc)?.box
    if (!b) return { x0, y0, x1: x0 + d, y1: y0 + d }
    return { x0: x0 + b.x0 * d, y0: y0 + b.y0 * d, x1: x0 + b.x1 * d, y1: y0 + b.y1 * d }
  }

  /**
   * 手指/光标是不是碰到图标画出来的那块（舞台坐标，带一点抖动宽容）。
   * @param slack 宽容量的倍数。碰上之后判离开时给得松一点，边界上抖动才不会反复触发
   */
  private onArt(p: V2, w: number, h: number, slack = 1): boolean {
    const pad = this.folderSize(w) * ART_PAD * slack
    const b = this.artBox(w, h)
    return p.x > b.x0 - pad && p.x < b.x1 + pad && p.y > b.y0 - pad && p.y < b.y1 + pad
  }

  /**
   * 碰到图标，图标按下去一点。
   *
   * 只在状态翻转时起一次动画 —— 每帧重设的话 GSAP 会不停重启，动画永远走不完。
   */
  private setTouched(v: boolean) {
    // 提示标签每帧都可能重设同一个值，不能卡在「只在翻转时」那条 return 后面
    this.iconHintEl.classList.toggle('is-on', v)
    if (this.touched === v) return
    this.touched = v
    gsap.to(this.icon, {
      scale: v ? TOUCH_SCALE : 1,
      duration: v ? 0.16 : 0.22,
      // 按下去干脆，弹回来带一点回弹，像 macOS 图标被点一下
      ease: v ? 'power2.out' : 'back.out(2.2)',
      overwrite: 'auto',
    })
  }

  /** 展开之后整片扇形都算「在文件夹身上」，不然光标往上够卡片的路上就收了 */
  private inFanZone(p: V2, w: number, h: number): boolean {
    if (!this.fan.length) return false
    const s = this.folderSize(w)
    const cx = this.at.x * w
    const cy = this.at.y * h
    return Math.abs(p.x - cx) < s * 1.45 && p.y > cy - s * 2.05 && p.y < cy + s * 1.05
  }

  /**
   * 这一帧光标算不算「在这个文件夹身上」。
   *
   * 关键是两套范围：**碰到图标本身**才展开，展开之后**整片扇形**都算数。
   * 只有后面这套的话，图标周围一大圈空气都能把衣服弹出来，手从旁边路过就触发；
   * 只有前面这套的话，手一往上够卡片，扇形当场就收回去了。
   */
  private engaged(p: V2, w: number, h: number): boolean {
    if (this.onArt(p, w, h)) return true
    if (!this.open) return false
    return this.inFanZone(p, w, h) || this.aimAt(p, w, h) >= 0
  }

  /**
   * 光标对这个文件夹的「争夺力」：0 是正压在图标中心，越大越远，够不着就是 Infinity。
   * 两个文件夹的感应区叠在一起时，离得近的那个先拿。
   */
  private claimAt(p: V2): number {
    if (this.moving) return Infinity
    const { w, h } = this.opts.stageSize()
    if (!w || !h) return Infinity
    if (!this.engaged(p, w, h)) return Infinity
    return Math.hypot(p.x - this.at.x * w, p.y - this.at.y * h) / (this.folderSize(w))
  }

  private cardCenter(i: number, w: number, h: number): V2 {
    const s = this.folderSize(w)
    return { x: this.at.x * w + this.fan[i].x * s, y: this.at.y * h + this.fan[i].y * s }
  }

  private ringSize(w: number) {
    return Math.max(27, w * 0.06)
  }

  /* ── 拖着挪位置 ─────────────────────────────────────────────
   * 排版用的：四个文件夹摆哪儿靠肉眼，比我在代码里猜坐标快得多。
   * 只认鼠标，手势不参与 —— 比着「1」的手不该把文件夹带跑。
   */

  /**
   * 扇形整体占地，单位是图标边长的倍数。夹紧边界用这个，保证怎么拖都不出画面。
   *
   * 卡是斜着的，不能直接拿 w/h 当半宽半高 —— 旋转之后的外接矩形要宽不少
   * （w·|cos| + h·|sin|）。再算上被指着时放大 1.12 倍、整体抬起 AIM_LIFT。
   * 进度环没算进来：它只在停留时出现，贴边时稍微露出去一点无所谓，
   * 真把它算进去的话顶部会空掉一大片，反而没法把文件夹放到画面上方。
   */
  private extent() {
    // 空文件夹没有扇形，占地就是图标本身加下面那行字
    if (!this.fan.length) return { up: 0.55, down: 0.75, left: 0.55, right: 0.55 }
    const half = (f: FanSlot) => {
      const a = (f.rot * Math.PI) / 180
      const c = Math.abs(Math.cos(a))
      const s = Math.abs(Math.sin(a))
      return {
        w: ((f.w * c + f.h * s) / 2) * AIM_SCALE,
        h: ((f.w * s + f.h * c) / 2) * AIM_SCALE,
      }
    }
    const up = Math.max(...this.fan.map((f) => -f.y + AIM_LIFT + half(f).h))
    const down = Math.max(0.7, ...this.fan.map((f) => f.y + half(f).h))
    // 左右分开算，不再对称收紧——转过方向的扇形（fanSide）两边伸出量不一样，
    // 拖动边界得各自贴着卡牌真实的伸展量，不能被没用到的那一侧拖累
    const left = Math.max(0.3, ...this.fan.map((f) => Math.max(0, half(f).w - f.x)))
    const right = Math.max(0.3, ...this.fan.map((f) => Math.max(0, f.x + half(f).w)))
    return { up, down, left, right }
  }

  private startMove(ev: PointerEvent) {
    const { w, h } = this.opts.stageSize()
    if (!w || !h) return
    ev.preventDefault()
    this.moving = true
    // 拖动期间 tick 直接 return，占用留在手里别人就都动不了了，这里先放掉
    if (holder === this) holder = null
    this.clearAim()
    this.setOpen(false)

    // 用 this.icon 而不是 ev.currentTarget —— 按在透明边上的那一下是隔壁转交过来的，
    // currentTarget 指的是转交方，捕获会挂到错的元素上
    const icon = this.icon
    icon.setPointerCapture(ev.pointerId)
    // 按下点和图标中心的偏移，拖的时候保持住，图标才不会跳到指针下面
    const start = this.opts.toLocal(ev.clientX, ev.clientY)
    const startClient = { x: ev.clientX, y: ev.clientY }
    let maxClientMove = 0
    const grab = { x: this.at.x * w - start.x, y: this.at.y * h - start.y }

    const move = (e: PointerEvent) => {
      maxClientMove = Math.max(maxClientMove, Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y))
      const { w: sw, h: sh } = this.opts.stageSize()
      const p = this.opts.toLocal(e.clientX, e.clientY)
      const s = this.folderSize(sw)
      const { up, down, left, right } = this.extent()
      const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
      this.at = {
        x: cl((p.x + grab.x) / sw, (left * s) / sw, 1 - (right * s) / sw),
        y: cl((p.y + grab.y) / sh, (up * s) / sh, 1 - (down * s) / sh),
      }
      this.layout()
    }
    const up2 = (e: PointerEvent) => {
      icon.removeEventListener('pointermove', move)
      icon.removeEventListener('pointerup', up2)
      icon.removeEventListener('pointercancel', up2)
      icon.releasePointerCapture?.(e.pointerId)
      this.moving = false
      saveAt(this.opts.id, this.at)
      if (e.type === 'pointerup' && maxClientMove <= ICON_CLICK_SLOP) this.opts.onIconClick?.()
      console.info(
        `[folder] ${this.opts.id}: { x: ${this.at.x.toFixed(3)}, y: ${this.at.y.toFixed(3)} }`,
      )
    }
    icon.addEventListener('pointermove', move)
    icon.addEventListener('pointerup', up2)
    icon.addEventListener('pointercancel', up2)
  }

  /** 当前位置，__folderPos() 用来一次性导出四个 */
  get position(): V2 {
    return { ...this.at }
  }

  get id(): string {
    return this.opts.id
  }

  /**
   * 把这个文件夹此刻的「桌面图标」（图标 + 圆点 + 名字/品牌）画到截屏合成用的
   * canvas 上——只画静止态，展开的扇形卡片、停留进度环、悬浮提示都不画，
   * 那些是交互反馈，不是桌面本身的样子。
   *
   * 位置/尺寸算法特意跟 layout()/folderSize() 保持同一套换算，不然截图里
   * 的图标会和屏幕上看到的对不上。
   */
  renderDesktopIcon(ctx: CanvasRenderingContext2D) {
    const { w, h } = this.opts.stageSize()
    if (!w || !h) return
    const size = this.folderSize(w)
    const cx = this.at.x * w
    const cy = this.at.y * h

    const img = this.icon as HTMLImageElement
    if (img.complete && img.naturalWidth) {
      const draw = size * ICON_DRAW
      // object-fit: contain 的手算版——直接拿 draw×draw 硬拉伸的话非方形图标（云、废纸篓）会变形
      const s = Math.min(draw / img.naturalWidth, draw / img.naturalHeight)
      const iw = img.naturalWidth * s
      const ih = img.naturalHeight * s
      ctx.drawImage(img, cx - iw / 2, cy - ih / 2, iw, ih)
    }

    const label = this.opts.label
    const brand = this.opts.brand
    const hasDot = !!this.opts.dot
    const fontSize = size * 0.145
    const dotSize = size * 0.13
    const gap = size * 0.06
    const rowTop = cy + size * 0.52
    const nameLineH = fontSize * 1.2
    const brandLineH = brand ? fontSize * 0.76 * 1.2 : 0
    const textBlockH = nameLineH + brandLineH
    const rowH = Math.max(hasDot ? dotSize : 0, textBlockH)

    ctx.save()
    ctx.font = `${fontSize}px ${DESKTOP_LABEL_FONT}`
    ctx.textBaseline = 'alphabetic'
    const nameWidth = ctx.measureText(label).width
    ctx.font = `${fontSize * 0.76}px ${DESKTOP_LABEL_FONT}`
    const brandWidth = brand ? ctx.measureText(brand).width : 0
    const textWidth = Math.max(nameWidth, brandWidth)
    const rowW = (hasDot ? dotSize + gap : 0) + textWidth
    const rowLeft = cx - rowW / 2

    if (hasDot) {
      ctx.fillStyle = getComputedStyle(this.dotEl).backgroundColor
      ctx.beginPath()
      ctx.arc(rowLeft + dotSize / 2, rowTop + rowH / 2, dotSize / 2, 0, Math.PI * 2)
      ctx.fill()
    }

    const textLeft = rowLeft + (hasDot ? dotSize + gap : 0)
    ctx.shadowColor = DESKTOP_LABEL_SHADOW
    ctx.shadowBlur = fontSize * 0.35
    ctx.fillStyle = DESKTOP_LABEL_COLOR
    ctx.font = `${fontSize}px ${DESKTOP_LABEL_FONT}`
    const nameY = rowTop + (rowH - textBlockH) / 2 + nameLineH * 0.82
    ctx.fillText(label, textLeft, nameY)
    if (brand) {
      ctx.globalAlpha = 0.8
      ctx.font = `${fontSize * 0.76}px ${DESKTOP_LABEL_FONT}`
      ctx.fillText(brand, textLeft, nameY + nameLineH * 0.5 + brandLineH * 0.72)
      ctx.globalAlpha = 1
    }
    ctx.restore()
  }

  /** 有东西存进来了，图标弹一下 —— 不然人不知道照片去哪儿了 */
  bump() {
    // 从「此刻的静止大小」弹起再落回去。手正压在图标上时静止大小是缩过的，
    // 写死 1 的话弹完会自己长回原大，和手指状态对不上
    const rest = this.touched ? TOUCH_SCALE : 1
    gsap.fromTo(
      this.icon,
      { scale: rest },
      {
        scale: rest * 1.22,
        duration: 0.14,
        ease: 'power2.out',
        yoyo: true,
        repeat: 1,
        overwrite: true,
      },
    )
  }

  /** 这个点是不是落在图标本身上（捏合快门要用，比整个感应区严得多） */
  hitIcon(p: V2): boolean {
    const { w, h } = this.opts.stageSize()
    if (!w || !h) return false
    const s = this.folderSize(w)
    return Math.hypot(p.x - this.at.x * w, p.y - this.at.y * h) < s * 0.65
  }

  /**
   * 进度环摆在这件衣服的**法线**方向上 —— 扇形里每张卡是斜的，环跟着卡一起斜出去，
   * 才像是这件衣服自己的东西；一律摆正上方的话，左右两端那两张会觉得环挂错了。
   */
  private ringSpot(i: number, w: number, h: number): V2 {
    const s = this.folderSize(w)
    const f = this.fan[i]
    const c = this.cardCenter(i, w, h)
    // 卡片绕自身转过 rot 之后，它的「上」方向
    const a = (f.rot * Math.PI) / 180
    const ux = Math.sin(a)
    const uy = -Math.cos(a)
    // 从卡片中心推出去：半个卡高（被指着时是放大过的）+ 一点间距 + 半个环
    const out = (f.h * s * AIM_SCALE) / 2 + s * 0.12 + this.ringSize(w) / 2
    // 被指着的卡整体抬起过，环跟着抬
    return { x: c.x + ux * out, y: c.y - AIM_LIFT * s + uy * out }
  }

  /** 光标落在哪张卡上。手会抖，判定范围给得比卡本身松一圈 */
  private aimAt(p: V2, w: number, h: number): number {
    if (!this.open) return -1
    const s = this.folderSize(w)
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cardCenter(i, w, h)
      const reach = Math.max(this.fan[i].w, this.fan[i].h) * s * 0.7
      const d = Math.hypot(p.x - c.x, p.y - c.y)
      if (d < reach && d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  /* ── 停留计时 ───────────────────────────────────────────────── */

  private aim(p: V2, now: number, w: number, h: number) {
    const i = this.aimAt(p, w, h)
    if (i < 0) {
      this.lockIndex = -1
      // 抖出去一下不算移开，超过 AIM_GRACE_MS 才真的放弃
      if (this.aimIndex >= 0 && now - this.aimLostAt > AIM_GRACE_MS) this.clearAim()
      return
    }
    this.aimLostAt = now
    if (i !== this.lockIndex) this.lockIndex = -1
    if (i === this.lockIndex) return // 刚穿过这件，等光标挪开再说

    if (i !== this.aimIndex) {
      this.bringToFront()
      const prev = this.aimIndex
      this.aimIndex = i
      this.aimFrom = now
      this.refreshAim(prev)
      this.showRing(this.ringSpot(i, w, h))
      return
    }
    if (now - this.aimFrom >= DWELL_BY_MODE[this.opts.mode ?? 'wear']) {
      const piece = this.pieces[i]
      // 锁住这件，不然光标不动的话下一帧又开始数
      this.lockIndex = i
      // 只有衣柜里的衣服会飞到身上；照片和脱下来的都交给主页面处理。
      // wear 分支故意先 flyToBody 再 clearAim（flyToBody 内部的 setOpen(false)
      // 自己会调 clearAim）——顺序不能反。反过来的话，clearAim 会先把这张
      // 刚被指着的卡标记成「不再被指」，refreshAim 就会补一个「退回正常展开位置」
      // 的动画（原始大小、rotation、opacity:1）；等 flyToBody 再把它标记成
      // flying、把透明度摁回 0，那个动画里位移/缩放/旋转的部分已经在跑，
      // 不会被这一次只针对透明度的 gsap.set 顺带杀掉，跑完之后卡片就定在
      // 一个「看不见但形状摆在那儿」的状态——is-flying 一解除，就成了一张
      // 凭空浮在原处的缩略图。
      if (this.opts.mode && this.opts.mode !== 'wear') {
        this.clearAim()
        this.opts.onDelete?.(piece, i)
      } else {
        this.flyToBody(i, piece)
      }
    }
  }

  /* ── 滑到身上 ───────────────────────────────────────────────── */

  private clearAim() {
    if (this.aimIndex < 0) return
    const prev = this.aimIndex
    this.aimIndex = -1
    this.refreshAim(prev)
    this.hideRing()
  }

  private showRing(at: V2) {
    this.ring.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`
    // 先摘掉再加，过渡才会从头走一遍
    this.ring.classList.remove('is-on')
    void this.ring.offsetWidth
    this.ring.classList.add('is-on')
    // 提示贴在环再往外一点，不挡环本身的转圈
    if (this.cardHintEl) {
      this.cardHintEl.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -180%)`
      this.cardHintEl.classList.add('is-on')
    }
  }

  private hideRing() {
    this.ring.classList.remove('is-on')
    this.cardHintEl?.classList.remove('is-on')
  }

  /**
   * 选中之后：卡片缩回文件夹，衣服以**一块布**的形态从文件夹里飘出来。
   *
   * 飞行本身不在这里做 —— 交给 main.ts，因为那是真的布料物理，要每帧推进，
   * 而且最后得和骨骼算出来的位置对上。这里只负责把「从哪儿出来」告诉它。
   */
  private flyToBody(i: number, piece: FolderPiece) {
    const { w, h } = this.opts.stageSize()
    const s = this.folderSize(w)
    // 先把原小图立即拿掉，再生成布料；并在整段飞行动画期间把它排除在扇形布局外。
    // 否则手指还停在文件夹上时，下一帧自动展开会把刚隐藏的卡片重新显示出来。
    this.fly?.kill()
    this.flying.add(i)
    // 保险：不管这张卡此刻是不是正跑着别的动画（比如刚被指着又被划走那一下的
    // 回退动画），一律直接杀掉，不指望后面 gsap.set 的 overwrite:'auto' 去帮忙——
    // 那只按属性覆盖，位移/缩放/旋转这些没写进 gsap.set 里的属性会继续跑完。
    gsap.killTweensOf(this.cards[i])
    this.cards[i].classList.add('is-flying')
    gsap.set(this.cards[i], { opacity: 0, overwrite: 'auto' })
    this.setOpen(false)
    // 起点就是文件夹图标本身，大小也是图标那么大 —— 布从里面撑出来
    this.opts.onWear(piece, { x: this.at.x * w, y: this.at.y * h, w: s, h: s })

  }

  /**
   * @param tip 这一帧「比 1」的食指指尖在舞台里的位置，没有手势就传 null
   */
  tick(now: number, tip: V2 | null = null) {
    this.layout()
    const { w, h } = this.opts.stageSize()
    if (!w || !h) return

    if (tip) {
      this.tip = tip
      this.tipAt = now
    }
    // 手部识别会闪，丢一两帧不能就把已经数了一半的 4 秒清零
    const hand = this.tip && now - this.tipAt < GESTURE_GRACE_MS ? this.tip : null
    this.cursor.classList.toggle('is-on', !!hand)
    if (hand) this.cursor.style.transform = `translate(${hand.x}px, ${hand.y}px) translate(-50%, -50%)`

    // 正在拖着挪位置，不数停留 —— 不然挪完手一松就给你穿一件
    if (this.moving) return

    // 有人在比手势就听手势的，鼠标停在哪儿不该抢
    const p = hand ?? (mouseClient && this.opts.toLocal(mouseClient.x, mouseClient.y))
    if (!p) return

    // 独占光标：隔壁开着的时候这里装作没看见，免得它的扇形卡片顺手把这个文件夹也点亮
    const mine = this.claimAt(p)
    let inside = mine < Infinity
    if (inside) {
      if (holder && holder !== this) inside = false
      // 没人占着，但两个感应区叠上了 —— 让给离光标近的那个
      else if (!holder && instances.some((f) => f !== this && f.claimAt(p) < mine)) inside = false
      else holder = this
    } else if (holder === this) {
      holder = null
    }

    // 碰到图标就缩一下。已经缩着的时候判离开给得松一点（slack 2.5），
    // 手在边界上抖不会让图标一缩一放地抽搐
    this.setTouched(inside && this.onArt(p, w, h, this.touched ? 2.5 : 1))

    // 取走的缩略图不按动画时长恢复。只有手指/鼠标真正离开文件夹及其展开区域后，
    // 才解除隐藏；这样一直停在文件夹上时不会看到库存卡凭空长回来。
    if (this.flying.size && !inside) {
      for (const i of this.flying) this.cards[i]?.classList.remove('is-flying')
      this.flying.clear()
    }

    this.setOpen(inside)
    if (this.open) this.aim(p, now, w, h)
    if (this.opts.onIconDwell) this.tickIconDwell(p, now, w, h)
  }

  /**
   * 长按图标满 3 秒触发一次性动作（比如「我的Wool人格」攒满 4 张后的打印）。
   * 和 aim() 的卡片停留计时是两条独立的线——这条只认「压在图标本身上」，
   * 扇形有没有展开、光标有没有顺带落在某张卡上都不管。
   */
  private tickIconDwell(p: V2, now: number, w: number, h: number) {
    const spec = this.opts.onIconDwell!
    const duration = spec.durationMs ?? ICON_DWELL_MS
    const onIcon = this.onArt(p, w, h, this.touched ? 2.5 : 1) && spec.ready()
    if (!onIcon) {
      if (this.iconDwellFrom) this.hideRing()
      this.iconDwellFrom = 0
      this.iconDwellFired = false
      return
    }
    if (!this.iconDwellFrom) {
      this.iconDwellFrom = now
      this.iconDwellFired = false
      this.ring.style.setProperty('--dwell', `${duration}ms`)
      this.showRing({ x: this.at.x * w, y: this.at.y * h })
    }
    if (!this.iconDwellFired && now - this.iconDwellFrom >= duration) {
      this.iconDwellFired = true
      this.hideRing()
      spec.fire()
    }
  }

  destroy() {
    if (holder === this) holder = null
    const at = instances.indexOf(this)
    if (at >= 0) instances.splice(at, 1)
    this.fly?.kill()
    this.fanTl?.kill()
    gsap.killTweensOf(this.cards)
    this.root.remove()
    this.ring.remove()
    this.cardHintEl?.remove()
    // cursor 是全局共用的，不归这个实例删
  }
}
