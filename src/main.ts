import './styles/app.css'
import { Stage, type Rotation } from './core/stage'
import { SourceManager } from './core/source'
import { PoseEngine, type ModelName, type Delegate, type PoseLandmarkerResult } from './core/pose'
import { HandEngine, type HandLandmarkerResult } from './core/hands'
import { clear, drawHands, drawSkeleton, resizeCanvas } from './core/draw'
import { StandGuide, type GuideBox, type StandReport } from './core/stand-guide'
import { forInference, inferSize } from './core/downscale'
import { Garment, TOP_01 } from './core/garment'
import { MeshGarment, type MeshGarmentConfig } from './core/garment-mesh'
import { TAPE_SLOTS, drawTape } from './core/tape'
import type { ClothParams } from './core/cloth'
import { loadWardrobe, findLook, lookFromQuery, dumpFit } from './core/wardrobe'
import { DevPanel } from './ui/toolbar'
import { WardrobeFolder, type FolderPiece } from './ui/wardrobe-folder'
import { pointUp, pinch, openPalmTilt } from './core/gesture'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { gsap } from 'gsap'
import { CloudRainEffect } from './core/cloud-rain'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const viewportEl = $('viewport')
const stageEl = $('stage')
const videoEl = $<HTMLVideoElement>('src-video')
const imageEl = $<HTMLImageElement>('src-image')
const segmentationEl = $<HTMLCanvasElement>('segmentation')
const canvasEl = $<HTMLCanvasElement>('overlay')
const propsEl = $('props')
const frameGuideEl = $('frame-guide')

const frameGuideLabelEl = $('frame-guide-label')
const standRingEl = $('stand-ring')
const standRingBarEl = standRingEl.querySelector<SVGCircleElement>('circle.bar')!
/** 进度环的周长，和 folder.css 里 circle.bar 的 stroke-dasharray 对齐（2πr, r=18） */
const STAND_RING_LEN = 113.1

// 横向居中改交给 GSAP（xPercent），后面弹走动画要写同一个 transform，
// 留给 CSS 的话每次 gsap.to() 都会把 translateX(-50%) 一起冲掉
gsap.set(frameGuideEl, { xPercent: -50, y: 0 })

const standGuide = new StandGuide()

/** #frame-guide 在舞台坐标里的框。未变换的布局值，和 stage.content 同一套单位 */
function guideBox(): GuideBox {
  // CSS 是 left:50% + translateX(-50%)：offsetLeft 拿到的是「没被 transform 挪过」
  // 的左边缘，也就是中线。视觉上的左边缘要往回退半个宽度 —— 不修这一步，
  // 判定会以为人形框在画面右半边，所有人都会被判成「偏左」。
  const w = frameGuideEl.offsetWidth
  return {
    x: frameGuideEl.offsetLeft - w / 2,
    y: frameGuideEl.offsetTop,
    w,
    h: frameGuideEl.offsetHeight,
  }
}

/** 定格完成后这层还留多久 —— 让人看一眼「姿势已锁定」，然后让位给后面的流程 */
const READY_SHOW_MS = 1600
let readyShownAt = 0
let guideClock = performance.now()
/** 首次姿势锁定后才弹走；锁定前必须保留人形框给用户对齐动作。 */
let guideDismissed = false
/** 没在弹走/弹回那两下的时候，普通淡入淡出跟着这个值走，只在它变了才补一次 tween */
let guideOnPrev = false

/**
 * 站位引导 + 姿势确认的显示层。判定全在 core/stand-guide.ts，这里只管画：
 *
 *   idle    人形 + 一句「往哪儿站」
 *   framed  站位对了，人形就是姿势参照，文字提示摆姿势
 *   holding 姿势命中，进度环开始走
 *   ready   定格完成，人形和文字一起收掉
 *
 * 画面上只有这一条线 —— 之前还会用分割遮罩在 overlay canvas 上再描一条
 * 「贴着真人走」的轮廓，两条线一起动反而看不清该往哪儿站，撤掉了。
 * core/body-outline.ts 留着，将来要做「贴合度」反馈可以再挂回去。
 */
function paintStandGuide(r: StandReport): void {
  // Guide 勾上就常显，调样式时不用真等人走出识别范围
  const forced = ui.guide.checked
  let label: string

  if (r.state === 'ready') {
    if (!readyShownAt) readyShownAt = performance.now()
    label = '姿势已锁定'
  } else {
    // 站位/姿势/远近偏移之前各有各的提示语，现在统一成一句——不管差在哪，
    // 都只说「请进入虚线框内」，具体怎么站交给虚线人形本身去演示
    readyShownAt = 0
    label = '请进入虚线框内:)'
  }

  const on = forced || r.state !== 'ready' || performance.now() - readyShownAt < READY_SHOW_MS
  frameGuideEl.classList.toggle('is-ready', r.state === 'ready')
  if (frameGuideLabelEl.textContent !== label) frameGuideLabelEl.textContent = label

  // 人形框是叉腰姿势的参照物，必须留到首次锁定成功后才能弹走；之前按髋部出现
  // 就隐藏，会导致用户还没摆好叉腰姿势、参照物已经消失。
  // Guide 勾上强制常显时不弹走——调样式总得让它老实待着。
  const dismissed = garmentUnlocked && !forced
  if (dismissed !== guideDismissed) {
    guideDismissed = dismissed
    gsap.killTweensOf(frameGuideEl)
    if (dismissed) {
      gsap.to(frameGuideEl, { y: -140, opacity: 0, duration: 0.5, ease: 'back.in(1.8)' })
    } else {
      guideOnPrev = on
      gsap.to(frameGuideEl, { y: 0, opacity: on ? 0.85 : 0, duration: 0.45, ease: 'back.out(1.6)' })
    }
  } else if (!guideDismissed && on !== guideOnPrev) {
    guideOnPrev = on
    gsap.to(frameGuideEl, { opacity: on ? 0.85 : 0, duration: 0.15, overwrite: 'auto' })
  }

  const ringOn = r.state === 'holding' && r.hold > 0
  standRingEl.classList.toggle('is-on', ringOn)
  if (ringOn) standRingBarEl.style.strokeDashoffset = String(STAND_RING_LEN * (1 - r.hold))
}

/** 最近一次判定结果。调试用：窗口里能直接读原始数字，和 __lms / __mesh 一个路子 */
let lastStand: StandReport | null = null
;(window as unknown as { __standGuide: () => StandReport | null }).__standGuide = () => lastStand
const bootHint = $('boot-hint')
const loadingScreen = $('loading-screen')
const loadingBarFill = $('loading-bar-fill')
const loadingPct = $('loading-pct')

/** AI 模型下载进度条，0~1。boot() 里按 pose/hand 两个模型文件的真实字节数加权算 */
function setLoadingProgress(fraction: number) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  loadingBarFill.style.width = `${pct}%`
  loadingPct.textContent = `${pct}%`
}
function hideLoadingScreen() {
  setLoadingProgress(1)
  loadingScreen.classList.add('is-hidden')
}

const ui = {
  device: $<HTMLSelectElement>('dev-device'),
  refresh: $<HTMLButtonElement>('dev-refresh'),
  deviceNote: $('dev-device-note'),
  res: $<HTMLSelectElement>('dev-res'),
  fileVideo: $<HTMLButtonElement>('dev-file-video'),
  fileImage: $<HTMLButtonElement>('dev-file-image'),
  fileInput: $<HTMLInputElement>('dev-file-input'),
  screen: $<HTMLButtonElement>('dev-screen'),
  stop: $<HTMLButtonElement>('dev-stop'),
  rotate: $<HTMLSelectElement>('dev-rotate'),
  mirror: $<HTMLInputElement>('dev-mirror'),
  cover: $<HTMLInputElement>('dev-cover'),
  pose: $<HTMLInputElement>('dev-pose'),
  index: $<HTMLInputElement>('dev-index'),
  model: $<HTMLSelectElement>('dev-model'),
  delegate: $<HTMLSelectElement>('dev-delegate'),
  vis: $<HTMLInputElement>('dev-vis'),
  visVal: $<HTMLOutputElement>('dev-vis-val'),
  guide: $<HTMLInputElement>('dev-guide'),
  hand: $<HTMLInputElement>('dev-hand'),
  segmentation: $<HTMLInputElement>('dev-segmentation'),
  cloudRain: $<HTMLInputElement>('dev-cloud-rain'),
  cloudHeight: $<HTMLInputElement>('dev-cloud-height'),
  cloudHeightVal: $<HTMLOutputElement>('dev-cloud-height-val'),
  cloudSize: $<HTMLInputElement>('dev-cloud-size'),
  cloudSizeVal: $<HTMLOutputElement>('dev-cloud-size-val'),
  handUi: $<HTMLInputElement>('dev-hand-ui'),
  gesture: $<HTMLInputElement>('dev-gesture'),
  handNum: $<HTMLSelectElement>('dev-hand-num'),
  handDelegate: $<HTMLSelectElement>('dev-hand-delegate'),
  inferRes: $<HTMLSelectElement>('dev-infer-res'),
  handEvery: $<HTMLSelectElement>('dev-hand-every'),
  deviceBadge: $('dev-device-badge'),
  statDevices: $('stat-devices'),
  statState: $('stat-state'),
  statSource: $('stat-source'),
  statSrc: $('stat-src'),
  statTrack: $('stat-track'),
  statInferSize: $('stat-infer-size'),
  statStage: $('stat-stage'),
  statEnv: $('stat-env'),
  statFps: $('stat-fps'),
  statInfer: $('stat-infer'),
  statInferHand: $('stat-infer-hand'),
  statHands: $('stat-hands'),
  statGuide: $('stat-guide'),
}

const panel = new DevPanel($('dev-panel'), $<HTMLButtonElement>('dev-handle'))

/**
 * 要不要跑手部推理。和身体那边一个道理：检测和显示是两件事。
 * Hand = 想看手部骨骼，Point = 要用手势操作 —— 两者任一开着就得检测。
 */
const handNeeded = () => ui.hand.checked || ui.gesture.checked || ui.cloudRain.checked

// 扩展诊断区默认隐藏（设计稿里只有 FPS / pose / hand 三行），按 V 展开
window.addEventListener('keydown', (e) => {
  if (e.key !== 'v' && e.key !== 'V') return
  const t = e.target as HTMLElement | null
  if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
  const root = document.documentElement
  root.dataset.verbose = root.dataset.verbose === 'on' ? 'off' : 'on'
})
const stage = new Stage(stageEl, viewportEl)
const sources = new SourceManager(videoEl, imageEl)
const pose = new PoseEngine()
const hand = new HandEngine()
const garment = new Garment(TOP_01)

const maskCanvas = document.createElement('canvas')
const maskCtx = maskCanvas.getContext('2d')
let maskImage: ImageData | null = null

/** 用 Pose 的人物置信度遮罩，把人物以外区域换成网页的米白底。 */
function renderSegmentation(src: CanvasImageSource, w: number, h: number) {
  const mask = lastResult?.segmentationMasks?.[0]
  if (!ui.segmentation.checked || !mask || !maskCtx) {
    segmentationEl.hidden = true
    videoEl.style.opacity = ''
    imageEl.style.opacity = ''
    return
  }

  if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height || !maskImage) {
    maskCanvas.width = mask.width
    maskCanvas.height = mask.height
    maskImage = maskCtx.createImageData(mask.width, mask.height)
  }
  const values = mask.getAsFloat32Array()
  const pixels = maskImage.data
  for (let i = 0, p = 0; i < values.length; i++, p += 4) {
    pixels[p] = 255
    pixels[p + 1] = 255
    pixels[p + 2] = 255
    pixels[p + 3] = Math.round(Math.max(0, Math.min(1, values[i])) * 255)
  }
  maskCtx.putImageData(maskImage, 0, 0)

  const out = resizeCanvas(segmentationEl, w, h)
  if (!out) return
  out.clearRect(0, 0, w, h)
  out.globalCompositeOperation = 'source-over'
  out.drawImage(src, 0, 0, w, h)
  out.globalCompositeOperation = 'destination-in'
  out.drawImage(maskCanvas, 0, 0, w, h)
  out.globalCompositeOperation = 'destination-over'
  out.fillStyle = '#ede8e0'
  out.fillRect(0, 0, w, h)
  out.globalCompositeOperation = 'source-over'

  segmentationEl.hidden = false
  videoEl.style.opacity = '0'
  imageEl.style.opacity = '0'
}

// 方案 C 的 WebGL 层。下装在下、上衣在上，各一张画布，都压在骨骼 overlay 之下
function makeMeshLayer(id: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.id = id
  Object.assign(c.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    pointerEvents: 'none',
  } as CSSStyleDeclaration)
  stageEl.insertBefore(c, canvasEl)
  return c
}

let meshBottom: MeshGarment | null = null
let meshTop: MeshGarment | null = null
/** 双手叉腰姿势首次锁定后永久解锁；后续动作变化不再隐藏衣服。 */
let garmentUnlocked = false

/** 从 manifest 建两件。参数全部来自 JSON，代码里不留任何数值 */
async function loadLook(themeId: string, lookId: string) {
  const m = await loadWardrobe()
  const look = findLook(m, themeId, lookId)
  if (!look) {
    console.warn('[wardrobe] 找不到', themeId, lookId)
    return
  }
  for (const g of meshAll()) g.clear(stage.content.w, stage.content.h, 1)
  meshBottom = null
  meshTop = null
  try {
    if (look.fit.bottom) meshBottom = new MeshGarment(look.fit.bottom, layerBottom)
    if (look.fit.top) meshTop = new MeshGarment(look.fit.top, layerTop)
  } catch (e) {
    console.warn('[mesh] WebGL 不可用，退回方案 B', e)
    return
  }
  await Promise.all(meshAll().map((g) => g.load().catch((e) => console.warn('[mesh]', g.cfg.id, e))))
  // 开局这套本来就穿在身上，胶带当场贴好，和后面换上来的保持一致
  for (const g of meshAll()) tapeFrom.set(g, performance.now())
  ;(window as unknown as { __mesh: MeshGarment | null }).__mesh = meshTop
  ;(window as unknown as { __meshBottom: MeshGarment | null }).__meshBottom = meshBottom
  syncTrash()
  syncThemeTagline()
  console.info('[wardrobe] 已加载', themeId, lookId, meshAll().map((g) => g.cfg.id))
}

/**
 * 文件夹摆在舞台里的位置和大小。归一化：x/y 是舞台的比例，size 是「图标边长 ÷ 舞台宽」。
 * 挪位置改这两行就行 —— 扇形展开的相对几何在 wardrobe-folder.ts 里，跟着一起走。
 */
/*
 * 四个主题各一个文件夹，左右各两个，中间让给人。
 *
 * 每个文件夹的占地是「图标边长」的 2.9 倍宽、3.1 倍高（扇形往上撑 2.05、标签往下
 * 0.7）。注意图标边长是按舞台**宽度**算的，而上下余量要按**高度**衡量 ——
 * 横屏一宽一矮最紧张，所以位置是照 1920×1080 定的，竖屏只会更宽松。
 *
 * x = 0.16 / 0.84：扇形横向 ±0.13，占 0.03–0.29 和 0.71–0.97，人在 0.35–0.65，不打架。
 * y = 0.30 / 0.70：上排扇形顶到 0.04，下排标签落在 0.81，中间还隔着 0.03。
 */
const FOLDER_SIZE = 0.09
const FOLDER_AT: Record<string, { x: number; y: number }> = {
  intellect: { x: 0.16, y: 0.3 },
  editor: { x: 0.16, y: 0.7 },
  outdoor: { x: 0.84, y: 0.3 },
  homebody: { x: 0.84, y: 0.7 },
  /* 下面三个是空的，没有扇形，占地只有图标本身，所以能摆得离边缘更近 */
  persona: { x: 0.5, y: 0.1 },
  trash: { x: 0.92, y: 0.93 },
  screenshot: { x: 0.08, y: 0.5 },
  'wool-rain': { x: 0.92, y: 0.5 },
}

/**
 * 贴边扇形转向现在是 WardrobeFolder 自己按当前位置判的（离哪边近就往哪边转，
 * 中间正常打开），不用在这儿按主题手动配了——见 wardrobe-folder.ts 的
 * fanSideAuto()。
 */

/** 桌面上的摆设图标：只有图标和名字，不装衣服，但一样能拖 */
/** 四个主题文件夹各自的图标图，来自 Figma 导出（天猫超级品类日VI-2026年7月(2)/icon） */
const THEME_ICON: Record<string, string> = {
  intellect: '/assets/folder-intellect.png',
  editor: '/assets/folder-editor.png',
  homebody: '/assets/folder-homebody.png',
  outdoor: '/assets/folder-outdoor.png',
}

const DESK_ICONS: Array<{ id: string; label: string; icon: string; dot?: string; iconHint?: string; cardHint?: string }> = [
  { id: 'trash', label: '废纸篓', icon: '/assets/icon-trash-full.png', cardHint: '停留脱下' },
  { id: 'screenshot', label: '截屏', icon: '/assets/icon-screenshot-macos.png', iconHint: '点击或停留 3 秒拍照' },
  { id: 'wool-rain', label: '羊毛雨', icon: '/assets/cloud.png', dot: '#ffffff', iconHint: '指向停留开关' },
]

let folders: WardrobeFolder[] = []

/*
 * 道具层被 CSS 反向镜像过一次，它的坐标系等于「观众看到的」坐标系。
 * 所以喂给文件夹的三样东西都要换到这个坐标系里，缺一样就会出现
 * 「看得见但点不着」或者「衣服飞到对面去」。
 */

/** 屏幕坐标 → 道具层坐标。stage.toLocal 会把镜像解掉，这里要再镜回去 */
const toProps = (cx: number, cy: number) => {
  const p = stage.toLocal(cx, cy)
  return stage.mirrored ? { x: stage.content.w - p.x, y: p.y } : p
}

/** 调参用：控制台能拿到这一帧的骨骼点 */
const exposeLms = (v: unknown) => {
  ;(window as unknown as { __lms: unknown }).__lms = v
}

/** 骨骼点是源图坐标系的，镜像时横着翻一下再给文件夹算落点 */
const propsLandmarks = () => {
  const lms = lastResult?.landmarks?.[0]
  if (!lms) return null
  const out = stage.mirrored ? lms.map((p) => ({ ...p, x: 1 - p.x })) : lms
  exposeLms(out)
  return out
}

/** 道具层使用观众看到的坐标；布料 canvas 跟着源画面镜像，要把横坐标换回源坐标。 */
const propsPointToCloth = (p: { x: number; y: number }, w = stage.content.w) => ({
  x: stage.mirrored ? w - p.x : p.x,
  y: p.y,
})

const layerBottom = makeMeshLayer('mesh-bottom')
const layerTop = makeMeshLayer('mesh-top')
/**
 * 胶带单独一层，压在两件衣服之上。
 *
 * 不画在 #overlay 上 —— 那是调试层（骨骼线、锚点），抓拍时故意不合成进去；
 * 胶带是画面的一部分，得跟着衣服一起进照片。
 */
const layerTape = makeMeshLayer('mesh-tape')
/** 云、拉绳和雨独立一层，但仍然复用同一个舞台坐标系与主循环。 */
const layerCloudRain = makeMeshLayer('cloud-rain')
const cloudRain = new CloudRainEffect(layerCloudRain)

/**
 * 拉绳手柄没有对应的 DOM 元素（画在 canvas 上），提示单独造，挂在 #props 里跟着
 * toProps() 换算位置 —— 这样镜像时文字不会被翻转反着写。只在手/鼠标已经抓住
 * 手柄时才出现（确认「抓对了」，不是教人怎么抓），贴在手柄正上方，躲开羊毛图标本身。
 */
const handleHintTag = document.createElement('div')
handleHintTag.className = 'hint-tag'
handleHintTag.textContent = '拉一下下雨'
propsEl.append(handleHintTag)

/** 云雨层用的是源画面坐标（没镜像过），道具层是观众看到的坐标——镜像时要翻一下横坐标 */
const sourceToProps = (p: { x: number; y: number }) =>
  stage.mirrored ? { x: stage.content.w - p.x, y: p.y } : p

/** 每帧把手柄的悬浮提示贴到它此刻的实际渲染位置上 */
function syncCloudRainHints() {
  const handleAt = cloudRain.handleHintVisible ? cloudRain.getHandlePoint() : null
  if (handleAt) {
    const p = sourceToProps(handleAt)
    // 手柄图标本身是 radius*4 那么高，提示得躲到它上沿以外，不能压在羊头上
    handleHintTag.style.transform = `translate(${p.x}px, ${p.y - handleAt.radius * 2 - 10}px) translate(-50%, -100%)`
    handleHintTag.classList.add('is-on')
  } else {
    handleHintTag.classList.remove('is-on')
  }
}

/** 点在截屏图标上 → 直接起倒计时，和长按 3 秒是并列的两条路，谁先到算谁的 */
function handleScreenshotClick(clientX: number, clientY: number) {
  const icon = folders.find((f) => f.id === 'screenshot')
  if (icon?.hitIcon(toProps(clientX, clientY))) startCountdown(performance.now())
}

/** 指针事件是主路径；少数展示机只发传统鼠标事件，所以保留兼容监听。 */
let lastPointerDownAt = 0
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) {
  viewportEl.addEventListener(
    type,
    (event) => {
      const p = stage.toLocal(event.clientX, event.clientY)
      if (type === 'pointerdown') {
        lastPointerDownAt = performance.now()
        cloudRain.pointerDown(p)
        handleScreenshotClick(event.clientX, event.clientY)
      } else if (type === 'pointermove') cloudRain.pointerMove(p)
      else cloudRain.pointerUp()
    },
    // 绳头可能和衣服/文件夹道具重叠，捕获阶段先收到事件，不被子元素 stopPropagation 拦住。
    { capture: true },
  )
}
// 部分展示机/远程控制软件只合成传统鼠标事件，留一条兼容路径。
for (const type of ['mousedown', 'mousemove', 'mouseup'] as const) {
  viewportEl.addEventListener(
    type,
    (event) => {
      // 浏览器通常会在 pointerdown 后补发 mousedown，同一次点击不能切两次开关。
      if (type === 'mousedown' && performance.now() - lastPointerDownAt < 400) return
      const p = stage.toLocal(event.clientX, event.clientY)
      if (type === 'mousedown') {
        cloudRain.pointerDown(p)
        handleScreenshotClick(event.clientX, event.clientY)
      } else if (type === 'mousemove') cloudRain.pointerMove(p)
      else cloudRain.pointerUp()
    },
    { capture: true },
  )
}

const meshAll = () => [meshBottom, meshTop].filter(Boolean) as MeshGarment[]

/* ── 胶带 ────────────────────────────────────────────────────────
 * 每次换完衣服，在衣服边缘贴上几片半透明胶带（形状抄自 Figma 6:217 / 6:213）。
 * 贴的时机是「布放完那一刻」—— 还在飞的时候贴上去，胶带会跟着布一起乱飘。
 */

/** 每件衣服的胶带是什么时候开始贴的。没有记录 = 还没贴 */
const tapeFrom = new WeakMap<MeshGarment, number>()
/** 一片胶带按下去用多久，以及片与片之间错开多少 */
const TAPE_MS = 260
const TAPE_STAGGER = 130

/**
 * 胶带层自己管一个 2D 上下文。
 * draw.ts 的 resizeCanvas 只缓存一个 canvas，两张画布每帧轮流调它，
 * 等于每帧都要重新 getContext 一次。
 */
const tapeCtx = layerTape.getContext('2d')
function tapeSurface(w: number, h: number): CanvasRenderingContext2D | null {
  if (!tapeCtx) return null
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  const pw = Math.max(1, Math.round(w * dpr))
  const ph = Math.max(1, Math.round(h * dpr))
  if (layerTape.width !== pw || layerTape.height !== ph) {
    layerTape.width = pw
    layerTape.height = ph
  }
  tapeCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  tapeCtx.clearRect(0, 0, w, h)
  return tapeCtx
}

/**
 * 画这一帧所有胶带。
 *
 * 位置不写死在平铺图上：每片按自己那一行去问衣服的轮廓边在哪，然后骑在边上 ——
 * 一半贴着衣服、一半悬空。换任何一件衣服都不用重新量坐标。
 */
function drawTapes(now: number, w: number, h: number, lms?: NormalizedLandmark[]) {
  const ctx = tapeSurface(w, h)
  if (!ctx) return
  if (!showGarment || !garmentUnlocked || garmentMode !== 'mesh' || !lms) return

  // 胶带多长按肩宽算，上下装才是同一卷；人走近走远，胶带跟着一起大小
  const ls = lms[11]
  const rs = lms[12]
  if (!ls || !rs) return
  const shoulder = Math.hypot((ls.x - rs.x) * w, (ls.y - rs.y) * h)
  if (shoulder < 1) return

  for (const [kind, mesh] of [['top', meshTop], ['bottom', meshBottom]] as const) {
    if (!mesh || !mesh.ready || mesh.released) continue
    const start = tapeFrom.get(mesh)
    if (start === undefined) continue

    TAPE_SLOTS[kind].forEach((s, i) => {
      const progress = (now - start - i * TAPE_STAGGER) / TAPE_MS
      if (progress <= 0) return
      const u = mesh.edgeU(s.v, s.side)
      if (u === null) return
      const at = mesh.sample(u, s.v)
      if (!at) return
      drawTape(ctx, {
        x: at.x,
        y: at.y,
        // 衣服此刻的朝向 + 这片自己的倾角
        angle: at.angle + (s.rot * Math.PI) / 180,
        len: s.len * shoulder,
        progress: Math.min(1, progress),
      })
    })
  }
}

/**
 * 单独换一件。文件夹里拖出来穿上走的是这条路 —— 上衣换上衣、下装换下装，
 * 另一件保持不动，所以可以跨 look 混搭。
 */
/* ── 截屏 ───────────────────────────────────────────────────────
 * 点击图标，或者食指指着它停满 3 秒 → 倒数 3 秒 → 抓一张，存进「我的Wool人格」。
 * 不再要求捏两下——捏合手势识别没有点按稳，点击/停留两条路都比它更好上手。
 */

/** 倒计时长度 */
const COUNTDOWN_MS = 3000
/** 最多存几张，超了丢最早那张 */
const MAX_SHOTS = 4
/** 照片飞进相册要多久。卡片出现的延时和它绑在一起 */
const FLY_INTO_MS = 720

let countdownUntil = 0
let captureNext = false
/** 倒计时上一次报的数。变了才播一次「嘀」，不然每帧重播就成蜂鸣了 */
let lastCountdownTick = 0

interface Shot {
  id: string
  src: string
}
let shots: Shot[] = []

const countdownEl = document.createElement('div')
countdownEl.id = 'countdown'
propsEl.append(countdownEl)

/** 点击截屏图标，或者点它停满 3 秒，都从这条路起倒计时——只在没已经在倒数时生效 */
function startCountdown(now: number) {
  if (countdownUntil) return
  countdownUntil = now + COUNTDOWN_MS
  lastCountdownTick = 0
  playReadyChime()
}

function showCountdown(n: number) {
  if (countdownEl.textContent === String(n)) return
  countdownEl.textContent = String(n)
  countdownEl.classList.add('is-on')
  // 每跳一个数重播一次，才有「咔、咔、咔」的节奏；声音跟着一起跳，数字越小声调越高
  if (n !== lastCountdownTick) {
    lastCountdownTick = n
    playCountdownTick(n)
  }
  gsap.fromTo(
    countdownEl,
    { scale: 1.35, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.28, ease: 'power3.out', overwrite: true },
  )
}

function hideCountdown() {
  countdownEl.classList.remove('is-on')
  countdownEl.textContent = ''
  gsap.killTweensOf(countdownEl)
}

/** 每帧推进截屏倒计时；捏合不再控制羊毛雨 UI 图标。 */
function tickCountdown(now: number) {
  if (!countdownUntil) return
  const left = countdownUntil - now
  if (left > 0) {
    showCountdown(Math.ceil(left / 1000))
  } else {
    countdownUntil = 0
    hideCountdown()
    captureNext = true
  }
}

/** 右上/左上品牌角标、右下角小 logo——数值原样抄 app.css 里 .corner-title / #corner-logo 那几行，改了记得两边一起改 */
const brandBadgeEl = document.getElementById('brand-badge') as HTMLImageElement
const campaignTitleEl = document.getElementById('campaign-title') as HTMLImageElement
/** corner-logo 是内联 SVG，眨眼/描边动画只存在于 DOM 里，canvas 画不出动画中间态——
 * 直接拿它的源文件当静态图用，截图里显示的是「画完」那一帧，反而更清楚 */
const cornerLogoImg = new Image()
cornerLogoImg.src = '/assets/aoe-logo-source.svg'

function drawCornerBranding(g: CanvasRenderingContext2D, w: number, h: number) {
  if (brandBadgeEl.complete && brandBadgeEl.naturalWidth) {
    const bw = Math.min(260, w * 0.17)
    const bh = bw * (brandBadgeEl.naturalHeight / brandBadgeEl.naturalWidth)
    g.drawImage(brandBadgeEl, w * 0.025, h * 0.03, bw, bh)
  }
  if (campaignTitleEl.complete && campaignTitleEl.naturalWidth) {
    // CSS 里这张图有个 scale(1.3) transform-origin:top right，右上角是不动点
    const baseW = Math.min(190, w * 0.12)
    const baseH = baseW * (campaignTitleEl.naturalHeight / campaignTitleEl.naturalWidth)
    const anchorX = w - w * 0.02
    const topY = h * 0.03
    const sw = baseW * 1.3
    const sh = baseH * 1.3
    g.drawImage(campaignTitleEl, anchorX - sw, topY, sw, sh)
  }
  if (cornerLogoImg.complete && cornerLogoImg.naturalWidth) {
    const lw = Math.min(44, Math.max(28, w * 0.06))
    const lh = lw * (cornerLogoImg.naturalHeight / cornerLogoImg.naturalWidth || 93 / 87)
    g.drawImage(cornerLogoImg, w - w * 0.02 - lw, h - h * 0.02 - lh, lw, lh)
  }
}

/**
 * 把画面合成成一张照片：背景 + 两层衣服 + 云雨 + 桌面品牌角标/文件夹图标。
 * 骨骼线、扇形卡片、停留进度环这些交互调试态不进照片——拍的是「穿着这身、
 * 站在这张桌面上的你」，不是调试画面。
 */
async function snapshot(w: number, h: number) {
  const src = sources.current
  if (!src.el) return
  const c = document.createElement('canvas')
  c.width = Math.round(w)
  c.height = Math.round(h)
  const g = c.getContext('2d')
  if (!g) return
  // 画面镜像时照片也要镜像，不然拍出来和人看到的左右相反
  if (stage.mirrored) {
    g.translate(c.width, 0)
    g.scale(-1, 1)
  }
  try {
    const background = ui.segmentation.checked && !segmentationEl.hidden ? segmentationEl : src.el
    g.drawImage(background as CanvasImageSource, 0, 0, c.width, c.height)
    for (const layer of [layerBottom, layerTop, layerTape, layerCloudRain]) {
      g.drawImage(layer, 0, 0, c.width, c.height)
    }
    // 桌面图标/品牌角标本来就是「观众视角」坐标（#props 的 CSS 反向 transform 已经
    // 抵消过舞台镜像了）——继续用上面那个镜像过的 context 画，会被镜镜相抵画反，
    // 这里先归零变换，让它们按自己本来的坐标落进去
    g.setTransform(1, 0, 0, 1, 0, 0)
    drawCornerBranding(g, c.width, c.height)
    for (const f of folders) f.renderDesktopIcon(g)
  } catch (e) {
    console.warn('[shot] 合成失败', e)
    return
  }

  // 声音和闪白要在合成的当下就出来，不能等编码完 —— 那要几十毫秒，人会觉得慢半拍
  playShutter()
  flash()

  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
  if (!blob) return
  const shot: Shot = { id: `shot-${Date.now()}`, src: URL.createObjectURL(blob) }

  // 先入库再放动画。反过来（等飞行动画的 onComplete 再存）看着更顺，但页面一旦
  // 被切到后台，GSAP 的 ticker 停了 onComplete 就永远不来，这张照片就丢了。
  shots.push(shot)
  while (shots.length > MAX_SHOTS) {
    const old = shots.shift()
    if (old) URL.revokeObjectURL(old.src)
  }
  console.info('[shot] 已存入我的Wool人格，现有', shots.length, '张')

  // 卡片等照片「落地」再出现。用 setTimeout 不用动画回调 —— 节流了只是晚一点
  flyIntoAlbum(shot.src, w, h)
  window.setTimeout(() => {
    syncAlbum()
    folders.find((f) => f.id === 'persona')?.bump()
  }, FLY_INTO_MS)
}

/* ── 快门声 ─────────────────────────────────────────────────────
 * 用 WebAudio 合出来的，不带音频文件 —— 园区版要整包离线。
 */
let audioCtx: AudioContext | null = null
function ensureAudio(): AudioContext | null {
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext()
    } catch {
      return null
    }
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume()
  return audioCtx
}
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => ensureAudio(), { once: true })
}

function playShutter() {
  const ac = ensureAudio()
  if (!ac || ac.state !== 'running') return
  const t0 = ac.currentTime
  // 两声：反光镜弹起 + 落下。一小段白噪声配极陡的包络
  for (const [delay, gain, freq] of [
    [0, 0.5, 2600],
    [0.055, 0.3, 1700],
  ] as const) {
    const len = Math.floor(ac.sampleRate * 0.05)
    const buf = ac.createBuffer(1, len, ac.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3
    const src = ac.createBufferSource()
    src.buffer = buf
    const bp = ac.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = freq
    bp.Q.value = 1.2
    const g = ac.createGain()
    g.gain.value = gain
    src.connect(bp).connect(g).connect(ac.destination)
    src.start(t0 + delay)
  }
}

/** 一声干净的正弦「嘀」，倒计时的每一跳、起手的提示音都拿它拼——和快门那种机械噪声故意分开，一听就知道是两件事 */
function playTone(freq: number, duration: number, peakGain = 0.22) {
  const ac = ensureAudio()
  if (!ac || ac.state !== 'running') return
  const t0 = ac.currentTime
  const osc = ac.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = freq
  const g = ac.createGain()
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(peakGain, t0 + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
  osc.connect(g).connect(ac.destination)
  osc.start(t0)
  osc.stop(t0 + duration + 0.02)
}

/** 「准备好了，开始数」——起手一次，倒计时正式开始那一刻响 */
function playReadyChime() {
  playTone(760, 0.16, 0.2)
  window.setTimeout(() => playTone(1080, 0.18, 0.22), 90)
}

/** 倒计时每跳一个数响一声，越接近拍摄音调越高，听感上有种「要来了」的推进感 */
function playCountdownTick(n: number) {
  playTone(520 + (3 - n) * 130, 0.12, 0.18)
}

/**
 * 「我的Wool人格」攒满 4 张、相纸从取物槽往下吐的那几秒配的打印机声。
 * 两层：锯齿波过低通做电机的持续嗡鸣（叠一个 LFO 让频率轻微抖动，像步进电机
 * 一格一格走），再撒几下带通噪声当走纸的咔嗒——纯音效果太干净，加点粗糙感
 * 才像真的机器在动，不是电子提示音。
 */
function playPrintSound(durationS: number) {
  const ac = ensureAudio()
  if (!ac || ac.state !== 'running') return
  const t0 = ac.currentTime

  const osc = ac.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.value = 130
  const lfo = ac.createOscillator()
  lfo.frequency.value = 13
  const lfoGain = ac.createGain()
  lfoGain.gain.value = 16
  lfo.connect(lfoGain).connect(osc.frequency)

  const filter = ac.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 850

  const hum = ac.createGain()
  hum.gain.setValueAtTime(0, t0)
  hum.gain.linearRampToValueAtTime(0.13, t0 + 0.15)
  hum.gain.setValueAtTime(0.13, t0 + durationS - 0.2)
  hum.gain.linearRampToValueAtTime(0, t0 + durationS)

  osc.connect(filter).connect(hum).connect(ac.destination)
  osc.start(t0)
  lfo.start(t0)
  osc.stop(t0 + durationS + 0.05)
  lfo.stop(t0 + durationS + 0.05)

  const clicks = Math.max(4, Math.floor(durationS / 0.32))
  for (let i = 0; i < clicks; i++) {
    const when = t0 + 0.12 + (i * (durationS - 0.24)) / clicks
    const len = Math.floor(ac.sampleRate * 0.03)
    const buf = ac.createBuffer(1, len, ac.sampleRate)
    const d = buf.getChannelData(0)
    for (let j = 0; j < len; j++) d[j] = (Math.random() * 2 - 1) * (1 - j / len) ** 2
    const src = ac.createBufferSource()
    src.buffer = buf
    const bp = ac.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2200
    bp.Q.value = 1.5
    const g = ac.createGain()
    g.gain.value = 0.1
    src.connect(bp).connect(g).connect(ac.destination)
    src.start(when)
  }
}

/* ── 闪白 + 照片飞进相册 ───────────────────────────────────── */

const flashEl = document.createElement('div')
flashEl.id = 'flash'
propsEl.append(flashEl)

/**
 * 闪白用 CSS 过渡 + setTimeout 归零，不用 GSAP —— ticker 一停 tween 不跑，
 * 就会留下一层白挡在画面上。
 */
function flash() {
  flashEl.style.transition = 'none'
  flashEl.style.opacity = '0.85'
  window.setTimeout(() => {
    flashEl.style.transition = ''
    flashEl.style.opacity = '0'
  }, 20)
}

const flyEl = document.createElement('img')
flyEl.id = 'shot-fly'
flyEl.draggable = false
propsEl.append(flyEl)
gsap.set(flyEl, { xPercent: -50, yPercent: -50 })

/** 照片从画面正中缩着飞进「我的Wool人格」 */
function flyIntoAlbum(src: string, w: number, h: number) {
  const album = folders.find((f) => f.id === 'persona')
  if (!album) return
  const to = album.position
  const from = { x: w / 2, y: h / 2 }
  const dest = { x: to.x * w, y: to.y * h }
  const h0 = h * 0.46
  const w0 = h0 * (w / h)

  const dx = dest.x - from.x
  const dy = dest.y - from.y
  const dist = Math.hypot(dx, dy) || 1
  let nx = -dy / dist
  let ny = dx / dist
  // 弧朝外侧鼓，别从人脸上压过去
  if ((from.x < w / 2 && nx > 0) || (from.x >= w / 2 && nx < 0)) {
    nx = -nx
    ny = -ny
  }
  const cx = (from.x + dest.x) / 2 + nx * dist * 0.35
  const cy = (from.y + dest.y) / 2 + ny * dist * 0.35
  const endW = w * FOLDER_SIZE * 0.5

  flyEl.src = src
  flyEl.className = 'is-on is-photo'
  gsap.set(flyEl, { x: from.x, y: from.y, width: w0, height: h0, rotation: 0, opacity: 1 })

  const p = { t: 0 }
  const fly = FLY_INTO_MS / 1000
  gsap
    .timeline({
      onComplete: () => {
        flyEl.classList.remove('is-on')
        flyEl.removeAttribute('src')
      },
    })
    .to(p, {
      t: 1,
      duration: fly,
      ease: 'power2.inOut',
      onUpdate: () => {
        const u = 1 - p.t
        gsap.set(flyEl, {
          x: u * u * from.x + 2 * u * p.t * cx + p.t * p.t * dest.x,
          y: u * u * from.y + 2 * u * p.t * cy + p.t * p.t * dest.y,
        })
      },
    }, 0)
    .to(flyEl, { width: endW, height: h0 * (endW / w0), rotation: -12, duration: fly, ease: 'power2.in' }, 0)
    .to(flyEl, { opacity: 0, duration: 0.18, ease: 'power1.in' }, fly - 0.16)

  // 兜底收尾：ticker 一停 onComplete 就不来了
  window.setTimeout(() => {
    flyEl.classList.remove('is-on')
    flyEl.removeAttribute('src')
  }, FLY_INTO_MS + 220)
}

// 没摄像头也能试快门：控制台敲 __shutter() 起倒计时，__shot() 直接拍
;(window as unknown as { __shutter: () => void }).__shutter = () => {
  startCountdown(performance.now())
}
;(window as unknown as { __shot: () => void }).__shot = () => {
  captureNext = true
}

/** 把照片列表推给「我的Wool人格」那个文件夹 */
function syncAlbum() {
  const persona = folders.find((f) => f.id === 'persona')
  persona?.setPieces(shots.map((s) => ({ id: s.id, src: s.src })))
}

function removeShot(index: number) {
  const [gone] = shots.splice(index, 1)
  if (gone) URL.revokeObjectURL(gone.src)
  syncAlbum()
  console.info('[shot] 删掉一张，还剩', shots.length, '张')
}

/* ── 长按「我的Wool人格」攒满 4 张 → 整台取物机跳到画面中间打印 ─────
 * 素材直接抄 Figma 那台取物机（print-machine.png 机身 + print-paper.png
 * 白边相纸），不是文件夹那套扇形卡片。机身贴出来后，纸从机身的取物槽
 * 部位往下"吐"出来——掩体（overflow: hidden）卡在取物槽的位置，纸本身
 * 钉在掩体顶部不动，掩体越长越高，看着就是纸从缝里吐出来，和 Figma 里
 * 收起态（一条缝）→ 展开态（完整四宫格）的两帧对得上。
 *
 * 取物槽 / 四张照片格子在机身图里的比例，量的是 Figma 原始节点坐标
 * （机身 759×1350；取物槽 130,489,500,711；四张照片格子在取物槽内的
 * 相对坐标），换算成百分比，机身不管缩多大这套比例都对得上。
 */
const PRINT_MACHINE_ASPECT = 759 / 1350
const PRINT_SLOT = { left: 130 / 759, top: 489 / 1350, width: 500 / 759, height: 711 / 1350 }
/** 四张照片格子在「取物槽」内部的相对位置，顺序对应 shots[0..3]：左上、右上、左下、右下 */
const PRINT_CELLS = [
  { left: 0.062, top: 0.012658, width: 0.438, height: 0.45993 },
  { left: 0.51, top: 0.012658, width: 0.438, height: 0.45993 },
  { left: 0.062, top: 0.48242, width: 0.438, height: 0.4782 },
  { left: 0.51, top: 0.48242, width: 0.438, height: 0.4782 },
]

/** 整台素材放大到 1.4 倍，其余全是相对比例，跟着一起放大不用改 */
const PRINT_SCALE = 1.4
/** 左上角那个小叉，相对机身框（不是相对机身图片）的位置和大小，机身多大它跟着多大 */
const PRINT_CLOSE_BTN = { left: -0.055, top: -0.055, size: 0.11 }
/** 手指指着叉停多久算「点」了一下——不是捏合那种一下到位的手势，只能靠停留代替点击 */
const PRINT_CLOSE_DWELL_MS = 550
/** 相纸从取物槽里吐出来要多久（秒）。原来 1.05s 太快像甩出来的，放慢才像真的在「印」 */
const PRINT_REVEAL_S = 2.6

const printEl = document.createElement('div')
printEl.id = 'persona-print'
printEl.innerHTML = `
  <img class="print-machine" src="/assets/print-machine.png" draggable="false" alt="" />
  <div class="print-slot">
    <div class="print-sheet">
      <img class="print-paper" src="/assets/print-paper.png" draggable="false" alt="" />
      <img class="cell" draggable="false" alt="" />
      <img class="cell" draggable="false" alt="" />
      <img class="cell" draggable="false" alt="" />
      <img class="cell" draggable="false" alt="" />
    </div>
  </div>
  <button type="button" class="print-close" aria-label="关闭">
    <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
  </button>
`
propsEl.append(printEl)
gsap.set(printEl, { xPercent: -50, yPercent: -50, opacity: 0, scale: 0.6 })
const printSlotEl = printEl.querySelector('.print-slot') as HTMLElement
const printCloseEl = printEl.querySelector('.print-close') as HTMLElement
const printCells = Array.from(printEl.querySelectorAll<HTMLImageElement>('.cell'))
printSlotEl.style.left = `${PRINT_SLOT.left * 100}%`
printSlotEl.style.top = `${PRINT_SLOT.top * 100}%`
printSlotEl.style.width = `${PRINT_SLOT.width * 100}%`
printCloseEl.style.left = `${PRINT_CLOSE_BTN.left * 100}%`
printCloseEl.style.top = `${PRINT_CLOSE_BTN.top * 100}%`
printCloseEl.style.width = `${PRINT_CLOSE_BTN.size * 100}%`
printCells.forEach((img, i) => {
  const c = PRINT_CELLS[i]
  img.style.left = `${c.left * 100}%`
  img.style.top = `${c.top * 100}%`
  img.style.width = `${c.width * 100}%`
  img.style.height = `${c.height * 100}%`
})
// 鼠标点这个叉直接关——不用等停留
printCloseEl.addEventListener('pointerdown', (e) => {
  e.stopPropagation()
  closePersonaPrint()
})

let printTl: gsap.core.Timeline | null = null
/** 展开着才需要理会关闭手势，收起来之后这些全部作废 */
let printVisible = false
/** 关闭叉在舞台坐标里的命中圆，只有展开时才有值——算法和 printPersonaStrip 里摆放机身用的是同一套基准 */
let printCloseHit: { cx: number; cy: number; r: number } | null = null
let printCloseDwellFrom = 0

/**
 * 停满 3 秒且正好 4 张时触发。不足 4 张的话 onIconDwell 那边根本不会数到这一步。
 * 打印完不会自己收起——这是给用户看的「成果」，得让他们自己点叉/指着停 3 秒关掉，
 * 不能刚看清楚就被系统收走。
 */
function printPersonaStrip() {
  if (shots.length < MAX_SHOTS) return
  const { w, h } = stage.content
  if (!w || !h) return

  const deviceW = Math.min(420, Math.max(220, w * 0.32)) * PRINT_SCALE
  const deviceH = deviceW / PRINT_MACHINE_ASPECT
  const slotFullH = deviceH * PRINT_SLOT.height
  printCells.forEach((img, i) => {
    img.src = shots[i]?.src ?? ''
  })

  const left = w / 2 - deviceW / 2
  const top = h / 2 - deviceH / 2
  printCloseHit = {
    cx: left + (PRINT_CLOSE_BTN.left + PRINT_CLOSE_BTN.size / 2) * deviceW,
    cy: top + (PRINT_CLOSE_BTN.top + PRINT_CLOSE_BTN.size / 2) * deviceW,
    // 判定半径比按钮本体再宽一点，手指抖一抖也不会刚好停不中
    r: PRINT_CLOSE_BTN.size * deviceW * 0.75,
  }
  printVisible = true
  printCloseDwellFrom = 0

  gsap.killTweensOf(printEl)
  gsap.killTweensOf(printSlotEl)
  gsap.set(printEl, { left: w / 2, top: h / 2, width: deviceW, height: deviceH, opacity: 0, scale: 0.6 })
  gsap.set(printSlotEl, { height: 0 })

  printTl?.kill()
  printTl = gsap
    .timeline()
    .to(printEl, { opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(1.6)' })
    // 走纸放慢一点，配合下面的打印声——原来 1.05s 太快，像甩出来的，不像"印"出来的
    .to(
      printSlotEl,
      {
        height: slotFullH,
        duration: PRINT_REVEAL_S,
        ease: 'power1.out',
        onStart: () => playPrintSound(PRINT_REVEAL_S),
      },
      '-=0.15',
    )
}

/** 鼠标点叉、或手指停满 PRINT_CLOSE_DWELL_MS，都走这条路收起来——没有第三条自动收起的路 */
function closePersonaPrint() {
  if (!printVisible) return
  printVisible = false
  printCloseHit = null
  gsap
    .timeline()
    .to(printSlotEl, { height: 0, duration: 0.4, ease: 'power2.in' })
    .to(printEl, { opacity: 0, scale: 0.6, duration: 0.35, ease: 'power2.in' }, '-=0.1')
}

/**
 * 每帧问一下：手指（point up 指尖）是不是停在关闭叉上。是鼠标点还是手势，
 * 在这个函数里看不出来——鼠标走的是上面那个 pointerdown 监听器，这里只管手势。
 */
function tickPersonaPrintClose(tip: { x: number; y: number } | null) {
  printCloseEl.classList.toggle('is-armed', false)
  if (!printVisible || !printCloseHit) {
    printCloseDwellFrom = 0
    return
  }
  const d = tip ? Math.hypot(tip.x - printCloseHit.cx, tip.y - printCloseHit.cy) : Infinity
  if (d >= printCloseHit.r) {
    printCloseDwellFrom = 0
    return
  }
  printCloseEl.classList.add('is-armed')
  const now = performance.now()
  if (!printCloseDwellFrom) printCloseDwellFrom = now
  else if (now - printCloseDwellFrom >= PRINT_CLOSE_DWELL_MS) closePersonaPrint()
}/* ── 脱下来扔进废纸篓：真的布料物理 ─────────────────────────── */

interface Falling {
  mesh: MeshGarment
  slot: 'top' | 'bottom'
  /** 被「拎住」的那几针。只拽它们，布才不会塌成一坨 */
  grab: Int32Array
  until: number
}
let falling: Falling[] = []

/** 布料飘多久之后收掉 */
const FALL_MS = 1000
/** 拎着走的力度，按时间从小到大。作用在 grab 那几针上，不是整块布 */
const PULL_K0 = 0.018
const PULL_K1 = 0.38
/** 前这么久基本不拽，只是飘 */
const FALL_FREE_MS = 0
/**
 * 「飘」而不是「掉」，两个旋钮：
 *   LAUNCH_V —— 起手往上甩多快，**决定浮多高**。上升高度 ≈ v × 28.6
 *   LIFT0    —— 持续的反重力，决定在空中**停多久**，不决定高度
 */
const LAUNCH_V = 0
const LIFT0 = 0
const FLOAT_MS = 1
/** 进桶是被顺势拖走，不是烟一样漂散：低风、较快收住惯性。 */
const FALL_CLOTH: Partial<ClothParams> = { wind: 0.025, friction: 0.91, gravity: 0.055 }

/**
 * 每个主题文件夹的全部家当。穿在身上的那件要从扇形里拿掉 ——
 * 都已经穿上了还躺在文件夹里，看着就像那一下没选中；脱下来再放回去。
 */
const stock = new Map<string, FolderPiece[]>()
/** 上一次真正写进某个文件夹的件数组合。没变就别重建卡片，重建会让扇形闪一下 */
const stockShown = new Map<string, string>()

function syncStock() {
  const worn = new Set([meshTop?.cfg.id, meshBottom?.cfg.id].filter(Boolean) as string[])
  for (const [id, all] of stock) {
    const folder = folders.find((f) => f.id === id)
    if (!folder) continue
    const left = all.filter((p) => !worn.has(p.id))
    const key = left.map((p) => p.id).join(',')
    if (stockShown.get(id) === key) continue
    stockShown.set(id, key)
    folder.setPieces(left)
  }
}

/** 废纸篓里装的是「身上正穿着的」，所以每次换装都要同步一次 */
function syncTrash() {
  syncStock()
  const trash = folders.find((f) => f.id === 'trash')
  if (!trash) return
  const worn: FolderPiece[] = []
  if (meshTop) worn.push({ id: meshTop.cfg.id, src: meshTop.cfg.src, slot: 'top', cfg: meshTop.cfg })
  if (meshBottom) worn.push({ id: meshBottom.cfg.id, src: meshBottom.cfg.src, slot: 'bottom', cfg: meshBottom.cfg })
  trash.setPieces(worn)
}

function takeOff(piece: FolderPiece) {
  if (!piece.slot || !piece.cfg) return
  const slot = piece.slot
  const mesh = slot === 'top' ? meshTop : meshBottom
  if (!mesh || mesh.released) return

  dropFalling(slot)
  dropArriving(slot)

  // 交给布料：静止边长按此刻身上的形状量，所以不会先弹回平铺状
  mesh.release({
    // 只给一点点不规则，保留布感，但不能散开得像烟。
    scatter: [4, -3, 3],
    launch: [0, -LAUNCH_V],
    params: FALL_CLOTH,
  })
  falling.push({ mesh, slot, grab: mesh.grabPoints(), until: performance.now() + FALL_MS })

  if (slot === 'top') meshTop = null
  else meshBottom = null
  ;(window as unknown as { __mesh: MeshGarment | null }).__mesh = meshTop
  ;(window as unknown as { __meshBottom: MeshGarment | null }).__meshBottom = meshBottom

  syncTrash()
  // 脱衣服不用等飞行动画，人一摘下来就该收
  syncThemeTagline()
  console.info('[wardrobe] 脱下', piece.cfg.id)
}

/** 提前收掉某个槽位上正在飘的那块布 */
function dropFalling(slot: 'top' | 'bottom') {
  const { w, h } = stage.content
  falling = falling.filter((f) => {
    if (f.slot !== slot) return true
    f.mesh.clear(w, h, 1)
    f.mesh.dispose()
    return false
  })
}

/** 每帧推进所有正在下落的布 */
function stepFalling(now: number, w: number, h: number, dpr: number) {
  if (!falling.length) return
  const bin = folders.find((f) => f.id === 'trash')
  const targetVisual = bin ? bin.position : { x: 0.9, y: 0.9 }
  const target = propsPointToCloth({ x: targetVisual.x * w, y: targetVisual.y * h }, w)

  falling = falling.filter((f) => {
    const left = f.until - now
    const age = FALL_MS - left
    const ramp = Math.min(1, Math.max(0, (age - FALL_FREE_MS) / (FALL_MS - FALL_FREE_MS)))
    const pull = {
      x: target.x,
      y: target.y,
      k: PULL_K0 + (PULL_K1 - PULL_K0) * ramp * ramp,
      only: f.grab,
    }
    const lift = LIFT0 * Math.max(0, 1 - age / FLOAT_MS)
    // 到桶口最后 140ms 才快速收掉，前面始终看得见衣服确实滑进去了。
    const fade = left < 140 ? 0.16 : 0
    const alive = f.mesh.simulate(pull, fade, lift) && left > -200
    if (alive) {
      f.mesh.render(w, h, dpr)
      return true
    }
    f.mesh.clear(w, h, dpr)
    f.mesh.dispose()
    bin?.bump()
    return false
  })
}

/* ── 穿上：从文件夹里飘出来的一块布 ───────────────────────────
 *
 * 衣服不是「一张图飞过去然后变成衣服」—— 它从文件夹里以布的形态撑出来，带着
 * 微风飘到人身上，最后几百毫秒里慢慢贴回骨骼算出来的位置。最后那段混合是关键：
 * 布飘到哪儿是物理说了算，蒙皮要求顶点必须落在骨骼定的位置上，硬切会跳一下。
 */

/** 飘过去要多久 */
const ARRIVE_MS = 1400
/** 最后这么久用来「固定住骨骼点」：布的位置渐变到蒙皮位置 */
const SETTLE_MS = 380
/** 往身上拽的力度，作用在领口那几针上 */
const ARRIVE_K0 = 0.025
const ARRIVE_K1 = 0.085
/** 飘出来时布比图标大多少倍，之后一路长到身体尺寸 */
const ARRIVE_SEED = 1.6
/**
 * 飘过去时是一整片轻布：斜向约束防剪切，跨格约束防止衣服卷成细条。
 * 这些只用于穿衣动画，不影响脱下衣服时更松软的布料效果。
 */
const ARRIVE_CLOTH: Partial<ClothParams> = {
  wind: 0.045,
  friction: 0.94,
  gravity: 0.075,
  iterations: 9,
  stiffness: 0.3,
  shear: true,
  shearStrength: 0.14,
  bend: false,
}

interface Arriving {
  mesh: MeshGarment
  slot: 'top' | 'bottom'
  grab: [Int32Array, Int32Array]
  /** 文件夹处的起点和衣服刚出现时顶边两点的间距 */
  from: { x: number; y: number; span: number }
  /** 每帧要把静止边长乘的系数，累计起来就是从图标大小长到身体大小 */
  grow: number
  start: number
}
let arriving: Arriving[] = []

async function wearFit(
  slot: 'top' | 'bottom',
  cfg: MeshGarmentConfig,
  from?: { x: number; y: number; w: number; h: number },
) {
  // 这个槽位要是还有块布在飘，先收掉 —— 它和新衣服共用一张画布
  dropFalling(slot)
  dropArriving(slot)
  const layer = slot === 'top' ? layerTop : layerBottom
  const prev = slot === 'top' ? meshTop : meshBottom
  let next: MeshGarment
  try {
    next = new MeshGarment(cfg, layer)
    await next.load()
  } catch (e) {
    console.warn('[wardrobe] 换装失败', cfg.id, e)
    return
  }
  // 同一个 canvas 上的旧那套 GL 资源要还回去，否则每换一次就攒一张贴图
  prev?.clear(stage.content.w, stage.content.h, 1)
  prev?.dispose()
  if (slot === 'top') meshTop = next
  else meshBottom = next
  // __dump() 要导出「现在身上这件」的参数，换装后这两个引用得跟着走
  ;(window as unknown as { __mesh: MeshGarment | null }).__mesh = meshTop
  ;(window as unknown as { __meshBottom: MeshGarment | null }).__meshBottom = meshBottom
  syncTrash()
  console.info('[wardrobe] 穿上', cfg.id)

  if (!from) {
    // 没给起点（比如开局加载）就直接穿上，不放飞行动画，胶带也就当场贴好
    tapeFrom.set(next, performance.now())
    syncThemeTagline()
    return
  }

  // 布从文件夹里撑出来：先只有图标那么大，一路把静止边长放大到身体尺寸
  const { w, h } = stage.content
  const clothFrom = propsPointToCloth(from, w)
  const seed = from.w * ARRIVE_SEED
  next.appear(
    { x: clothFrom.x, y: clothFrom.y, w: seed, h: seed },
    { launch: [0, -1.2], params: ARRIVE_CLOTH },
  )
  const target = bodyWidthFor(cfg, slot, w, h)
  const frames = Math.max(1, Math.round(((ARRIVE_MS - SETTLE_MS) / 1000) * 60))
  arriving.push({
    mesh: next,
    slot,
    // 只轻轻牵住顶边左右两针，像拎着衣服的两个肩点
    grab: next.grabCorners(),
    from: { x: clothFrom.x, y: clothFrom.y, span: seed * 0.64 },
    grow: Math.pow(Math.max(0.2, target / seed), 1 / frames),
    start: performance.now(),
  })
}

/* ── 张掌快速换装 ─────────────────────────────────────────────── */

const PALM_ARM_MS = 1500
const PALM_NEUTRAL_DEG = 22
const PALM_TRIGGER_DEG = 28
// 举稳阶段丢一下手就该重来，容错给短的；但转到 25°+ 去触发时手本来就更容易
// 被识别成「没伸直/没张开」而短暂丢帧 —— 已经解锁的状态不该被这种正常抖动打回原形，
// 容错给长一点，真的把手放下才会解锁状态。
const PALM_LOST_GRACE_MS = 420
const PALM_ARMED_LOST_GRACE_MS = 900

let palmNeutralFrom = 0
let palmLastSeen = 0
let palmArmed = false
let palmTriggered = false
let palmChanging = false

/*
 * 视觉反馈：举稳阶段手上跟一个进度环（复用文件夹停留选中那套 .folder-dwell），
 * 解锁后环收起、换成一条常驻提示条，触发换装时提示条对应那侧弹一下。
 * 环本身的「转圈」交给 CSS transition 走，这里每帧只管挪位置 + 开关 class。
 */
const palmRing = document.createElement('div')
palmRing.className = 'folder-dwell'
palmRing.innerHTML =
  '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" /><circle cx="20" cy="20" r="18" class="bar" /></svg>'
palmRing.style.setProperty('--dwell', `${PALM_ARM_MS}ms`)
propsEl.append(palmRing)

const palmBadge = document.createElement('div')
palmBadge.id = 'palm-badge'
palmBadge.className = 'hint-tag'
palmBadge.innerHTML = '<span class="side is-left">◀ 上衣</span><span class="side is-right">下装 ▶</span>'
propsEl.append(palmBadge)

/** 举稳阶段（还没解锁）跟着 palmRing 一起显示的待命提示 */
const palmArmHint = document.createElement('div')
palmArmHint.className = 'hint-tag palm-arm-hint'
palmArmHint.textContent = '举掌稳住'
propsEl.append(palmArmHint)

/**
 * 主题赛道词语：上衣和下装凑成同一个主题的整套时才出现，图来自 Figma 导出的
 * 主题 SVG（psd/SVG 目录），一个主题一张，src 换着来。
 */
const THEME_TAGLINE_SRC: Record<string, string> = {
  intellect: '/assets/tagline-intellect.svg',
  editor: '/assets/tagline-editor.svg',
  homebody: '/assets/tagline-homebody.svg',
  outdoor: '/assets/tagline-outdoor.svg',
}
const themeTagline = document.createElement('img')
themeTagline.id = 'theme-tagline'
themeTagline.alt = ''
propsEl.append(themeTagline)

/** 掉落动画的起点：从这么多像素高的上方落下来，收起时原路跳回去 */
const TAGLINE_DROP_PX = 40
gsap.set(themeTagline, { xPercent: -50, scale: 0.8, y: -TAGLINE_DROP_PX, opacity: 0 })
let taglineOn = false

/** 上衣下装凑成同一个主题整套时才亮出对应的赛道词语，混搭或缺一件就收起 */
function syncThemeTagline() {
  const topTheme = meshTop?.cfg.id.split('-look')[0]
  const bottomTheme = meshBottom?.cfg.id.split('-look')[0]
  const src = topTheme && topTheme === bottomTheme ? THEME_TAGLINE_SRC[topTheme] : undefined
  if (!src) {
    if (taglineOn) {
      taglineOn = false
      // 离开：原路跳回上面去，快一点，不用弹性
      gsap.to(themeTagline, { y: -TAGLINE_DROP_PX, opacity: 0, duration: 0.28, ease: 'power2.in', overwrite: true })
    }
    return
  }
  if (themeTagline.getAttribute('src') !== src) themeTagline.src = src
  if (!taglineOn) {
    taglineOn = true
    // 出现：从上面掉下来，带一点回弹，像真的掉在这儿一样
    gsap.fromTo(
      themeTagline,
      { y: -TAGLINE_DROP_PX, opacity: 0 },
      { y: 0, opacity: 0.9, duration: 0.5, ease: 'bounce.out', overwrite: true },
    )
  }
}

/**
 * 虚线框贴着赛道词语的实际底边走，不用写死的百分比 —— 换一张比例不同的图，
 * #stage 的高宽比会跟着变，两个固定百分比之间的视觉间距也会跟着跑偏。
 * 用 getBoundingClientRect 量的是变换（scale）之后的真实渲染框，比 offsetHeight 准。
 */
function syncFrameGuideTop(stageW: number) {
  const taglineRect = themeTagline.getBoundingClientRect()
  const parentRect = propsEl.getBoundingClientRect()
  const gap = stageW * 0.015
  frameGuideEl.style.top = `${taglineRect.bottom - parentRect.top + gap}px`
}

let palmRingOn = false

function showPalmRing(at: { x: number; y: number }) {
  palmRing.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`
  // 提示贴在环正上方一点
  palmArmHint.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -140%)`
  palmArmHint.classList.add('is-on')
  if (palmRingOn) return
  palmRingOn = true
  // 重启一次 CSS transition：先摘掉 class，逼一次重排，再挂回去
  palmRing.classList.remove('is-on')
  void palmRing.offsetWidth
  palmRing.classList.add('is-on')
}

function hidePalmRing() {
  palmRingOn = false
  palmRing.classList.remove('is-on')
  palmArmHint.classList.remove('is-on')
}

function flashPalmSide(side: 'left' | 'right') {
  const el = palmBadge.querySelector<HTMLElement>(side === 'left' ? '.is-left' : '.is-right')
  if (!el) return
  gsap.fromTo(
    el,
    { scale: 1.35, opacity: 0.4 },
    { scale: 1, opacity: 1, duration: 0.32, ease: 'power3.out', overwrite: true },
  )
}

async function cycleGarment(slot: 'top' | 'bottom') {
  if (palmChanging) return
  // 主题看这个槽位身上现在这件自己的 id，不看 activeThemeId ——
  // 文件夹允许上衣下装分别跨主题混搭，共用一个「最近穿的主题」会把另一条槽位带错主题。
  const current = slot === 'top' ? meshTop?.cfg.id : meshBottom?.cfg.id
  const themeId = current?.split('-look')[0]
  if (!themeId) return
  palmChanging = true
  try {
    const manifest = await loadWardrobe()
    const theme = manifest.themes.find((t) => t.id === themeId)
    if (!theme) return
    const options = theme.looks.map((l) => l.fit[slot]).filter(Boolean) as MeshGarmentConfig[]
    if (options.length < 2) return
    const at = options.findIndex((cfg) => cfg.id === current)
    const next = options[(at + 1 + options.length) % options.length]
    await wearFit(slot, next)
  } finally {
    palmChanging = false
  }
}

function handleQuickChange(hands: HandLandmarkerResult['landmarks'] | undefined, now: number) {
  if (!garmentUnlocked) return
  const pose = hands?.length ? openPalmTilt(hands, stage.content.w, stage.content.h, stage.mirrored) : null
  if (!pose) {
    const grace = palmArmed ? PALM_ARMED_LOST_GRACE_MS : PALM_LOST_GRACE_MS
    if (now - palmLastSeen > grace) {
      palmNeutralFrom = 0
      palmArmed = false
      palmTriggered = false
      hidePalmRing()
      palmBadge.classList.remove('is-on')
    }
    return
  }
  palmLastSeen = now
  const tilt = pose.angle

  if (!palmArmed) {
    if (Math.abs(tilt) <= PALM_NEUTRAL_DEG) {
      if (!palmNeutralFrom) palmNeutralFrom = now
      showPalmRing(pose.at)
      if (now - palmNeutralFrom >= PALM_ARM_MS) {
        palmArmed = true
        hidePalmRing()
        palmBadge.classList.add('is-on')
      }
    } else {
      palmNeutralFrom = 0
      hidePalmRing()
    }
    return
  }

  // 解锁之后提示条跟着手走，贴在中指上方——每帧都要跟，不然手一动提示就甩在原地了
  palmBadge.style.transform = `translate(${pose.mid.x}px, ${pose.mid.y}px) translate(-50%, -130%)`

  // 换过一次后必须先回到竖直区，才允许下一次倾斜触发。
  if (Math.abs(tilt) <= PALM_NEUTRAL_DEG) {
    palmTriggered = false
    return
  }
  if (palmTriggered || Math.abs(tilt) < PALM_TRIGGER_DEG) return
  palmTriggered = true
  if (tilt < 0) {
    flashPalmSide('left')
    void cycleGarment('top')
  } else {
    flashPalmSide('right')
    void cycleGarment('bottom')
  }
}

/** 这件衣服穿在身上该多宽 —— 实测肩宽 ÷ 静止骨架里的肩间距 */
function bodyWidthFor(cfg: MeshGarmentConfig, slot: 'top' | 'bottom', w: number, h: number): number {
  const lms = propsLandmarks()
  const top = slot === 'top'
  const a = lms?.[top ? 12 : 24]
  const b = lms?.[top ? 11 : 23]
  const ra = cfg.rest[top ? 'rShoulder' : 'rHip']
  const rb = cfg.rest[top ? 'lShoulder' : 'lHip']
  if (!a || !b || !ra || !rb) return w * 0.4
  const restDx = Math.abs(ra.x - rb.x)
  const bodyPx = Math.hypot((a.x - b.x) * w, (a.y - b.y) * h)
  return restDx > 0.01 && bodyPx > 1 ? bodyPx / restDx : w * 0.4
}

function dropArriving(slot: 'top' | 'bottom') {
  arriving = arriving.filter((a) => {
    if (a.slot !== slot) return true
    a.mesh.dropCloth()
    return false
  })
}

/**
 * 每帧推进正在飘来的衣服。返回一组「这一帧已经自己画过了」的 mesh，
 * 主循环就不用再按蒙皮画一遍。
 */
function stepArriving(now: number, lms: NormalizedLandmark[] | undefined, w: number, h: number, dpr: number): Set<MeshGarment> {
  const done = new Set<MeshGarment>()
  if (!arriving.length) return done
  const minVis = Number(ui.vis.value)
  const tSec = now / 1000

  arriving = arriving.filter((a) => {
    const age = now - a.start
    const top = a.slot === 'top'
    // 领口往肩中点飘 —— 「固定住骨骼点」字面意义上就是往那两个点去
    const j0 = lms?.[top ? 12 : 24]
    const j1 = lms?.[top ? 11 : 23]
    const shoulders = j0 && j1
      ? [{ x: Math.min(j0.x, j1.x) * w, y: (j0.x <= j1.x ? j0.y : j1.y) * h },
         { x: Math.max(j0.x, j1.x) * w, y: (j0.x > j1.x ? j0.y : j1.y) * h }]
      : null

    const ramp = Math.min(1, age / (ARRIVE_MS - SETTLE_MS))
    // 不直接吸向身体：引导点先沿柔和弧线抬起，再带着布自然落到肩膀/髋部。
    // 起点不能慢慢蓄力：新生成的布必须立刻离开缩略图位置，否则视觉上仍像小图留在原处。
    // ease-out 让离开文件夹干脆，接近身体时再逐渐减速。
    const travel = 1 - Math.pow(1 - ramp, 2.2)
    let aims: { x: number; y: number }[] | null = null
    if (shoulders) {
      const endX = (shoulders[0].x + shoulders[1].x) * 0.5
      const endY = (shoulders[0].y + shoulders[1].y) * 0.5
      const dx = endX - a.from.x
      const dy = endY - a.from.y
      const distance = Math.hypot(dx, dy)
      const arc = Math.min(130, Math.max(42, distance * 0.16))
      const controlX = a.from.x + dx * 0.48
      const controlY = Math.min(a.from.y, endY) - arc
      const inv = 1 - travel
      const pathX = inv * inv * a.from.x + 2 * inv * travel * controlX + travel * travel * endX
      const pathY = inv * inv * a.from.y + 2 * inv * travel * controlY + travel * travel * endY
      const endSpan = shoulders[1].x - shoulders[0].x
      const span = a.from.span + (endSpan - a.from.span) * travel
      aims = [
        { x: pathX - span * 0.5, y: pathY },
        { x: pathX + span * 0.5, y: pathY },
      ]
    }
    if (ramp < 1) a.mesh.growCloth(a.grow)
    a.mesh.clothStep(
      aims ? aims.map((aim, i) => ({
        x: aim.x,
        y: aim.y,
        k: ARRIVE_K0 + (ARRIVE_K1 - ARRIVE_K0) * travel,
        only: a.grab[i],
      })) : undefined,
    )

    // 最后 SETTLE_MS：布的位置渐变到蒙皮位置
    const k = Math.min(1, Math.max(0, (age - (ARRIVE_MS - SETTLE_MS)) / SETTLE_MS))
    const smooth = k * k * (3 - 2 * k)
    const skinned = lms ? a.mesh.fit(lms, w, h, minVis, tSec) : false
    if (skinned) a.mesh.blendCloth(smooth)
    a.mesh.render(w, h, dpr)
    done.add(a.mesh)

    if (age >= ARRIVE_MS) {
      a.mesh.dropCloth()
      // 布放完了，这会儿才贴胶带 —— 飞的过程中贴上去会跟着布一起乱飘
      tapeFrom.set(a.mesh, now)
      // 赛道词语也要等衣服真的穿好落地，不然衣服还在飞就先亮了
      syncThemeTagline()
      return false
    }
    return true
  })
  return done
}

/**
 * 桌面上的四个衣橱文件夹，每个主题一个。件数不齐没关系 ——「长期主义生活家」
 * 只有三件上下装（look1 没有下装），扇形会按件数自己重排。
 *
 * look2 的 inner 不进扇形：主页面本来就只渲染 top / bottom 两层。
 */
async function mountFolders() {
  const m = await loadWardrobe()

  // 外侧放下装、中间放上衣，和 Figma 扇形里的轮廓一致
  const order: Array<['top' | 'bottom', string]> = [
    ['bottom', 'look1'],
    ['top', 'look1'],
    ['top', 'look2'],
    ['bottom', 'look2'],
  ]

  for (const f of folders) f.destroy()
  folders = []
  stock.clear()
  stockShown.clear()

  for (const theme of m.themes) {
    const at = FOLDER_AT[theme.id]
    if (!at) {
      console.warn('[wardrobe] 没给', theme.id, '安排位置，跳过')
      continue
    }
    const pieces: FolderPiece[] = []
    for (const [slot, lookId] of order) {
      const cfg = theme.looks.find((l) => l.id === lookId)?.fit?.[slot]
      if (cfg) pieces.push({ id: cfg.id, slot, src: cfg.src, cfg })
    }
    if (!pieces.length) continue

    // 记下这个主题的全部家当。扇形里显示哪几件由 syncStock() 按「身上穿着什么」决定
    stock.set(theme.id, pieces)
    stockShown.set(theme.id, pieces.map((p) => p.id).join(','))

    folders.push(
      new WardrobeFolder({
        host: propsEl,
        id: theme.id,
        label: theme.name,
        icon: THEME_ICON[theme.id],
        dot: `var(--${theme.color.replace(/\//g, '-')})`,
        ring: `var(--${theme.color.replace(/\//g, '-')}-vivid)`,
        iconHint: '指向展开',
        cardHint: '停留穿上',
        pieces,
        at,
        size: FOLDER_SIZE,
        stageSize: () => stage.content,
        toLocal: toProps,
        onWear: (p, from) => {
          // 姿势锁定是换装入口；锁定前不启动衣服飞入动画。
          if (!garmentUnlocked) return
          if (p.slot && p.cfg) void wearFit(p.slot, p.cfg, from)
        },
      }),
    )
  }
  // 白灰的「我的Wool人格」。现在是空的 —— 只有图标和名字，没有扇形也没有停留计时
  const at = FOLDER_AT.persona
  if (at) {
    folders.push(
      new WardrobeFolder({
        host: propsEl,
        id: 'persona',
        label: '我的Wool人格',
        icon: '/assets/icon-persona-wool.png',
        dot: 'var(--color-ink-50)',
        mode: 'photo',
        iconHint: '集满 4 张停留 3 秒打印',
        cardHint: '停留删除',
        pieces: [],
        at,
        size: FOLDER_SIZE,
        stageSize: () => stage.content,
        toLocal: toProps,
        onWear: () => {},
        onDelete: (_p, i) => removeShot(i),
        onIconDwell: {
          ready: () => shots.length >= MAX_SHOTS,
          fire: () => printPersonaStrip(),
        },
      }),
    )
  }

  // 摆设图标。和文件夹同一个组件、同一个 FOLDER_SIZE，比例自然就一致
  for (const d of DESK_ICONS) {
    const p = FOLDER_AT[d.id]
    if (!p) continue
    folders.push(
      new WardrobeFolder({
        host: propsEl,
        id: d.id,
        label: d.label,
        icon: d.icon,
        dot: d.dot,
        // 废纸篓装的是「身上正穿着的」，停满 2 秒就脱下来扔进去
        mode: d.id === 'trash' ? 'trash' : undefined,
        iconHint: d.iconHint,
        cardHint: d.cardHint,
        pieces: [],
        at: p,
        size: FOLDER_SIZE,
        stageSize: () => stage.content,
        toLocal: toProps,
        onWear: () => {},
        // 实体屏轻点仍然可用；组件内部会排除拖动。
        onIconClick: d.id === 'wool-rain' ? () => setCloudRainOn(!ui.cloudRain.checked) : undefined,
        onDelete: d.id === 'trash' ? (piece) => {
          if (garmentUnlocked) takeOff(piece)
        } : undefined,
        // 截屏图标：停满 3 秒等同点了一下，起倒计时。没有「攒够几张」这种前提，ready 恒真
        onIconDwell:
          d.id === 'screenshot'
            ? { ready: () => true, fire: () => startCountdown(performance.now()) }
            : d.id === 'wool-rain'
              ? {
                  // 摄像头识别“比 1”的食指，指向图标停留 1 秒触发。
                  // 触发后必须先移开再指回来，避免手不动时连续开关。
                  ready: () => true,
                  fire: () => setCloudRainOn(!ui.cloudRain.checked),
                  durationMs: 1000,
                }
            : undefined,
      }),
    )
  }

  ;(window as unknown as { __folders: WardrobeFolder[] }).__folders = folders
  // 排好版之后在控制台敲 __folderPos()，把打出来的整段贴回上面的 FOLDER_AT
  ;(window as unknown as { __folderPos: () => void }).__folderPos = () => {
    const lines = folders.map((f) => {
      const p = f.position
      return `  ${f.id}: { x: ${p.x.toFixed(3)}, y: ${p.y.toFixed(3)} },`
    })
    console.info('const FOLDER_AT: Record<string, { x: number; y: number }> = {\n' + lines.join('\n') + '\n}')
  }
  ;(window as unknown as { __folderReset: () => void }).__folderReset = () => {
    for (const f of folders) localStorage.removeItem(`aoe.folder.at.${f.id}`)
    console.info('[folder] 已清掉本地位置，刷新回到代码里的默认值')
  }
  // loadLook 和 mountFolders 是并发的，谁先完成不一定。loadLook 里那次 syncTrash
  // 可能跑在废纸篓还没建出来的时候，所以这儿要再同步一次
  syncTrash()
  syncThemeTagline()
  console.info('[wardrobe] 文件夹', folders.length, '个')
}

/** 'mesh' = 方案 C 网格变形，'rigid' = 方案 B 刚性贴合 */
let garmentMode: 'mesh' | 'rigid' = 'mesh'
let showGarment = true
let showAnchors = false
/** 键盘微调作用在哪件上，B 键切换 */
let nudgeTarget: 'top' | 'bottom' = 'top'
;(window as unknown as { __garment: Garment }).__garment = garment
;(window as unknown as { __dump: () => void }).__dump = () => {
  for (const g of meshAll()) console.info(dumpFit(g.cfg))
}

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null
  if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
  if (e.key === 'g' || e.key === 'G') showGarment = !showGarment
  if (e.key === 'a' || e.key === 'A') showAnchors = !showAnchors
  if (e.key === 'm' || e.key === 'M') {
    garmentMode = garmentMode === 'mesh' ? 'rigid' : 'mesh'
    garment.reset()
    for (const g of meshAll()) g.reset()
    console.info('[garment] mode =', garmentMode)
  }
  // B 键切换微调目标（上衣 / 下装），三对键分别调三排关节的 y
  //   [ ]  上排 —— 上衣是肩，下装是髋。y 小则领口/腰头下移
  //   , .  中排 —— 肘 / 膝
  //   ; '  下排 —— 腕 / 踝。y 大则袖口/裤脚收短
  if (e.key === 'b' || e.key === 'B') {
    nudgeTarget = nudgeTarget === 'top' ? 'bottom' : 'top'
    console.info('[garment] nudge target =', nudgeTarget)
  }
  const ROWS: Record<'top' | 'bottom', [string, string, string]> = {
    top: ['rShoulder', 'rElbow', 'rWrist'],
    bottom: ['rHip', 'rKnee', 'rAnkle'],
  }
  const KEYS: Record<string, [0 | 1 | 2, number]> = {
    '[': [0, -0.01], ']': [0, 0.01],
    ',': [1, -0.01], '.': [1, 0.01],
    ';': [2, -0.01], "'": [2, 0.01],
  }
  // - / = 横向收窄 / 放宽：整套静止骨架的 x 相对中线缩放。
  // 落肩 oversize 款的骨骼点要比衣服肩缝窄，不然衣服会被压到人的体宽。
  const target0 = nudgeTarget === 'top' ? meshTop : meshBottom
  if ((e.key === '-' || e.key === '=') && target0) {
    const k = e.key === '-' ? 0.97 : 1 / 0.97
    const r = target0.cfg.rest
    for (const j of Object.keys(r)) r[j].x = +(0.5 + (r[j].x - 0.5) * k).toFixed(4)
    const half = Math.abs(r[Object.keys(r)[0]].x - 0.5)
    console.info(`[garment] ${target0.cfg.id} 半宽 =`, half.toFixed(4))
    void target0.load()
  }

  const hit = KEYS[e.key]
  const target = target0
  if (hit && target) {
    const [row, d] = hit
    const joint = ROWS[nudgeTarget][row]
    const mirror = joint.replace(/^r/, 'l')
    const r = target.cfg.rest
    r[joint].y = +(r[joint].y + d).toFixed(3)
    r[mirror].y = +(r[mirror].y + d).toFixed(3)
    console.info(`[garment] ${target.cfg.id} ${joint}.y =`, r[joint].y)
    void target.load()
  }
})

let lastResult: PoseLandmarkerResult | null = null
let lastHandResult: HandLandmarkerResult | null = null
let lastVideoTime = -1
let detectFrame = 0
/** null = 用默认规则；手动勾过之后就锁定用户的选择 */
let mirrorOverride: boolean | null = null
let fps = 0
let frames = 0
let fpsClock = performance.now()

/* ── 状态显示 ────────────────────────────────────────────────── */

function setState(text: string, isError = false) {
  ui.statState.textContent = text
  ui.deviceNote.classList.toggle('is-error', isError)
}

function refreshStats() {
  const s = sources.current
  ui.statSource.textContent = s.kind === 'none' ? '—' : `${s.kind} · ${trim(s.label, 18)}`
  ui.statSrc.textContent = s.width ? `${s.width}×${s.height}` : '—'

  const t = sources.trackSettings
  ui.statTrack.textContent = t?.width ? `${t.width}×${t.height} @${Math.round(t.frameRate ?? 0)}` : '—'
  ui.statInferSize.textContent = inferSize.w ? `${inferSize.w}×${inferSize.h}` : '—'

  ui.statStage.textContent = stage.rect.w ? `${Math.round(stage.rect.w)}×${Math.round(stage.rect.h)}` : '—'
  ui.statEnv.textContent = `${stage.env.label} · ${stage.env.tier} · ${stage.env.canvas.w}×${stage.env.canvas.h}`
  ui.statFps.textContent = fps ? `${fps}` : '—'
  ui.statInfer.textContent = pose.ready ? `${pose.inferMs.toFixed(1)} ms` : 'loading'
  ui.statInferHand.textContent = !handNeeded() ? 'off' : hand.ready ? `${hand.inferMs.toFixed(1)} ms` : 'loading'
  ui.statHands.textContent = handNeeded() ? String(lastHandResult?.landmarks?.length ?? 0) : '—'
  // 站位引导的当前状态 + 姿势分：调阈值时盯着这两个数就够了
  ui.statGuide.textContent = lastStand
    ? `${lastStand.state} · ${Math.round(lastStand.metrics.pose * 100)}%`
    : '—'
}

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/* ── 输入源 ──────────────────────────────────────────────────── */

sources.onChange = (src) => {
  lastResult = null
  lastVideoTime = -1

  // 摄像头默认镜像（照镜子的手感），本地视频/图片/屏幕捕获不镜像。
  // 手动改过就以手动的为准，不再被切换来源覆盖。
  const wantMirror = src.kind === 'camera' ? (mirrorOverride ?? true) : false
  ui.mirror.checked = wantMirror
  stage.setOptions({ mirrored: wantMirror })

  stage.setSource(src.width, src.height)
  bootHint.classList.toggle('is-hidden', src.kind !== 'none')
  if (src.kind === 'none') {
    ui.device.value = OFF
    setState('idle')
  } else {
    setState('running')
    if (src.kind === 'image') void detectStill()
  }
  refreshStats()
}

sources.onError = (msg) => {
  ui.deviceNote.textContent = msg
  setState('error', true)
  panel.toggle(true)
}

// 挑的那档要不到、退回相机自己的格式：不是错，但得说一声
sources.onNotice = (msg) => {
  ui.deviceNote.textContent = msg
  ui.deviceNote.classList.remove('is-error')
}

sources.onDevicesChange = (devices) => fillDevices(devices)

const OFF = '__off__'
/** 摄像头不可用时的默认场景图 */
const DEFAULT_SCENE = '/test/default-scene.jpg'

function fillDevices(devices: MediaDeviceInfo[]) {
  const keep = ui.device.value
  ui.device.innerHTML = ''
  ui.statDevices.textContent = String(devices.length)

  // 关闭 = 真的 stop() 掉轨道，释放设备，指示灯灭
  ui.device.append(new Option('OFF', OFF))

  if (!devices.length) {
    ui.device.append(new Option('No camera', ''))
    ui.device.value = OFF
    return
  }
  devices.forEach((d, i) => {
    ui.device.append(new Option(d.label || `Camera ${i + 1}`, d.deviceId))
  })

  if (sources.current.kind !== 'camera') ui.device.value = OFF
  else if (keep && devices.some((d) => d.deviceId === keep)) ui.device.value = keep

  // 被别的 App 独占的连续互通相机会整个消失，这里给个提示免得以为是 bug
  if (sources.permissionGranted && devices.length === 1) {
    ui.deviceNote.textContent =
      'Only 1 device? Continuity Camera is exclusive — close whatever is holding it (TouchDesigner / OBS / a video call), then hit refresh.'
  }
}

/**
 * 选的档和相机真正给的对不上时，直接把差异写在面板上。
 *
 * getUserMedia 的分辨率是**请求**不是命令：设备没有这个模式就按自己的格式给，
 * 不报错也不提示。不写出来的话，换档换半天画面纹丝不动，只会以为是这里坏了。
 */
function resolutionNote(): string | null {
  const want = ui.res.value
  if (want === 'native' || want === 'auto') return null
  const t = sources.trackSettings
  if (!t?.width) return null
  const got = `${t.width}×${t.height}`
  if (got === want.replace('x', '×')) return null
  return `Asked ${want.replace('x', '×')}, camera delivered ${got} — this device has no such mode.`
}

async function openCamera(deviceId?: string) {
  setState('opening…')
  const ok = await sources.useCamera({
    deviceId,
    resolution: ui.res.value,
    orientation: stage.env.orientation,
  })
  if (ok) {
    ui.deviceNote.classList.remove('is-error')
    const devices = await sources.refreshDevices()
    const track = (videoEl.srcObject as MediaStream | null)?.getVideoTracks()[0]
    const active = devices.find((d) => d.label === track?.label)
    if (active) ui.device.value = active.deviceId
    // 必须排在 refreshDevices 之后 —— 它只认出一台设备时也会往 deviceNote 里写东西，
    // 先写就被它盖掉了。只剩一台时把那行独占提示留着，那个更要紧
    const mismatch = resolutionNote()
    if (mismatch) ui.deviceNote.textContent = mismatch
    else if (devices.length !== 1) {
      ui.deviceNote.textContent = 'Processed on-device only. Nothing is recorded or uploaded.'
    }
  }
}

/* ── 控件 ────────────────────────────────────────────────────── */

ui.device.addEventListener('change', () => {
  if (ui.device.value === OFF) {
    sources.stop()
    setState('off')
    return
  }
  void openCamera(ui.device.value || undefined)
})
ui.res.addEventListener('change', () => {
  if (sources.current.kind === 'camera') void openCamera(ui.device.value || undefined)
})
ui.refresh.addEventListener('click', async () => {
  if (!sources.permissionGranted) await sources.requestPermission()
  await sources.refreshDevices()
})

ui.fileVideo.addEventListener('click', () => {
  ui.fileInput.accept = 'video/*'
  ui.fileInput.click()
})
ui.fileImage.addEventListener('click', () => {
  ui.fileInput.accept = 'image/*'
  ui.fileInput.click()
})
ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files?.[0]
  if (file) void sources.useFile(file)
  ui.fileInput.value = ''
})
ui.screen.addEventListener('click', () => void sources.useScreen())
ui.stop.addEventListener('click', () => {
  sources.stop()
  setState('off')
})

// 直接把文件拖到页面上也能用
viewportEl.addEventListener('dragover', (e) => e.preventDefault())
viewportEl.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer?.files?.[0]
  if (file) void sources.useFile(file)
})

ui.mirror.addEventListener('change', () => {
  mirrorOverride = ui.mirror.checked
  stage.setOptions({ mirrored: ui.mirror.checked })
})
ui.rotate.addEventListener('change', () => {
  stage.setOptions({ rotation: Number(ui.rotate.value) as Rotation })
  refreshStats()
})
ui.cover.addEventListener('change', () => {
  stage.setOptions({ cover: ui.cover.checked })
  refreshStats()
})

function paintSlider() {
  const min = Number(ui.vis.min)
  const max = Number(ui.vis.max)
  const pct = ((Number(ui.vis.value) - min) / (max - min)) * 100
  ui.vis.style.setProperty('--p', `${pct}%`)
  ui.visVal.textContent = Number(ui.vis.value).toFixed(2)
}
paintSlider()

ui.vis.addEventListener('input', () => {
  paintSlider()
  if (sources.current.kind === 'image') void detectStill()
})

/**
 * segmentation mask 一直请求，不再跟着 Cutout / Cloud Rain 两个勾选框忽开忽关。
 *
 * `pose.load()` 会整个重建 MediaPipe 的 WASM 任务实例（close 掉旧的、await 建新的），
 * 这中间有一段姿态检测完全拿不到结果的空档——之前云雨开关会触发这个重载，衣服就跟着
 * 闪一下消失。mask 常驻的代价只是姿态模型多算一点，比反复重载便宜得多，也不会卡顿。
 */
async function reloadModel(onProgress?: (loaded: number, total: number) => void) {
  setState('loading model…')
  try {
    await pose.load(ui.model.value as ModelName, ui.delegate.value as Delegate, true, onProgress)
    setState(sources.current.kind === 'none' ? 'idle' : 'running')
    if (sources.current.kind === 'image') void detectStill()
  } catch (err) {
    setState('pose model failed', true)
    ui.deviceNote.textContent = String(err)
  }
}
ui.model.addEventListener('change', () => void reloadModel())
ui.delegate.addEventListener('change', () => void reloadModel())
ui.segmentation.addEventListener('change', () => {
  // 纯粹是要不要画出来的开关，mask 本来就一直在算，不用重载模型
  if (!ui.segmentation.checked) {
    segmentationEl.hidden = true
    videoEl.style.opacity = ''
    imageEl.style.opacity = ''
  }
})
/**
 * 桌面「羊毛雨」图标和调试勾选框共用这一个开关。手部模型是否需要跟 gesture/hand
 * 勾选框走，不受云雨影响，这里不用管；mask 也一直在算，不用重载——纯粹切一下
 * CloudRainEffect 自己的开关状态机就够了。
 */
function setCloudRainOn(on: boolean) {
  cloudRain.setEnabled(on)
  ui.cloudRain.checked = on
  refreshStats()
}
ui.cloudRain.addEventListener('change', () => setCloudRainOn(ui.cloudRain.checked))

function paintCloudTuning() {
  const height = Number(ui.cloudHeight.value)
  const size = Number(ui.cloudSize.value)
  const heightPct = ((height - Number(ui.cloudHeight.min)) /
    (Number(ui.cloudHeight.max) - Number(ui.cloudHeight.min))) * 100
  const sizePct = ((size - Number(ui.cloudSize.min)) /
    (Number(ui.cloudSize.max) - Number(ui.cloudSize.min))) * 100
  ui.cloudHeight.style.setProperty('--p', `${heightPct}%`)
  ui.cloudSize.style.setProperty('--p', `${sizePct}%`)
  ui.cloudHeightVal.textContent = `${height > 0 ? '+' : ''}${height}%`
  ui.cloudSizeVal.textContent = `${size}%`
  cloudRain.setTuning(height / 100, size / 100)
}
paintCloudTuning()
ui.cloudHeight.addEventListener('input', paintCloudTuning)
ui.cloudSize.addEventListener('input', paintCloudTuning)

async function reloadHand(onProgress?: (loaded: number, total: number) => void) {
  if (!handNeeded()) return
  try {
    await hand.load(Number(ui.handNum.value), ui.handDelegate.value as Delegate, onProgress)
    if (sources.current.kind === 'image') void detectStill()
  } catch (err) {
    setState('hand model failed', true)
    ui.deviceNote.textContent = String(err)
  }
}
for (const el of [ui.hand, ui.gesture]) {
  el.addEventListener('change', () => {
    if (handNeeded()) void reloadHand()
    else lastHandResult = null
    refreshStats()
  })
}
ui.handNum.addEventListener('change', () => void reloadHand())
ui.handDelegate.addEventListener('change', () => void reloadHand())

stage.onChange = (_rect, env) => {
  // 拖窗口时能直接看到切到了哪一档
  ui.deviceBadge.textContent = `${env.label} · ${Math.round(viewportEl.clientWidth)}`
  ui.deviceBadge.classList.remove('is-flash')
  void ui.deviceBadge.offsetWidth // 重启动画
  ui.deviceBadge.classList.add('is-flash')
  refreshStats()
}

/* ── 渲染循环 ────────────────────────────────────────────────── */

async function detectStill() {
  if (sources.current.kind !== 'image' || !sources.current.el) return
  const el = sources.current.el as HTMLImageElement
  lastResult = await pose.detectImage(el)
  if (handNeeded()) lastHandResult = await hand.detectImage(el)
}

/** 热更新时旧模块的循环必须停掉，否则每存一次盘就多叠一个 rAF 循环 */
let alive = true
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    alive = false
    sources.stop()
    pose.close()
    hand.close()
    cloudRain.dispose()
  })
}

function loop() {
  if (!alive) return
  requestAnimationFrame(loop)

  // canvas 跟舞台元素本身走（未旋转的内容尺寸），旋转由 CSS transform 带着一起转
  const { w, h } = stage.content
  const ctx = resizeCanvas(canvasEl, w, h)
  if (!ctx) return
  clear(ctx, w, h)

  const src = sources.current
  if (src.kind === 'none' || !src.el) return

  if (src.kind !== 'image') {
    const v = src.el as HTMLVideoElement
    if (v.readyState < 2) return
    // 源尺寸可能在首帧之后才准确（部分虚拟摄像头会晚报）
    if (v.videoWidth && v.videoWidth !== src.width) {
      src.width = v.videoWidth
      src.height = v.videoHeight
      stage.setSource(v.videoWidth, v.videoHeight)
    }
    if (v.currentTime !== lastVideoTime) {
      lastVideoTime = v.currentTime
      detectFrame++

      // 显示用原图，推理用缩小图。关键点是归一化坐标，贴合精度不受影响
      const input = forInference(v, Number(ui.inferRes.value))

      // 检测和显示是两件事：UI 勾选框只管画不画骨骼线，衣服也要靠骨骼点，
      // 所以只要还在穿衣服就得继续检测。两者都关掉才真的停下来省算力。
      if (ui.pose.checked || showGarment) {
        lastResult = pose.detectVideo(input, performance.now())
      }

      // 手部按间隔跑。手的移动本来就比不上帧率那么快，隔帧几乎看不出差别
      if (handNeeded() && detectFrame % Number(ui.handEvery.value) === 0) {
        lastHandResult = hand.detectVideo(input, performance.now())
      }
    }
  }

  renderSegmentation(src.el as CanvasImageSource, w, h)

  // 这一帧的人物遮罩：喂给云雨做「人挡住雨」的判定。
  // getAsFloat32Array() 是一次从 WASM 里拷出来的，别重复取。
  const personMask = lastResult?.segmentationMasks?.[0]
  const maskValues = personMask ? personMask.getAsFloat32Array() : null

  const drawOpts = {
    minVisibility: Number(ui.vis.value),
    showIndex: ui.index.checked,
    mirrored: ui.mirror.checked,
  }

  // 衣服画在骨骼之下 —— 调试时骨骼线压在衣服上，一眼看出偏了多少
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const lms = lastResult?.landmarks?.[0]
  // 先摆位再判定：syncFrameGuideTop 每帧都要写 top，而它里面那两次
  // getBoundingClientRect 已经把布局刷过一次了，紧接着读 offset* 不再额外付账
  syncFrameGuideTop(w)
  const guideNow = performance.now()
  lastStand = standGuide.update(lms ?? null, guideNow - guideClock, {
    box: guideBox(),
    stageW: w,
    stageH: h,
    minVisibility: Number(ui.vis.value),
    mirrored: stage.mirrored,
  })
  guideClock = guideNow
  if (lastStand.state === 'ready') garmentUnlocked = true
  paintStandGuide(lastStand)
  const tSec = performance.now() / 1000

  // 正在从文件夹飘过来的衣服自己走布料 + 渐变贴合，这一帧已经画过了，
  // 下面按蒙皮再画一遍会把布覆盖掉
  // 首次姿势锁定前，任何衣服（包括飞入/脱下动画）都保持不可见。
  const flying = garmentUnlocked ? stepArriving(performance.now(), lms, w, h, dpr) : new Set<MeshGarment>()

  for (const g of meshAll()) {
    if (flying.has(g)) continue
    if (showGarment && garmentUnlocked && garmentMode === 'mesh' && g.ready && lms) {
      if (g.fit(lms, w, h, Number(ui.vis.value), tSec)) g.render(w, h, dpr)
      else g.clear(w, h, dpr)
    } else {
      g.clear(w, h, dpr)
    }
  }

  // 脱下来的布和身上的衣服画在同一批画布上，所以要排在这儿
  if (garmentUnlocked) stepFalling(performance.now(), w, h, dpr)

  // 胶带压在衣服之上，所以排在衣服全部画完之后
  drawTapes(performance.now(), w, h, lms)

  // 抓拍必须卡在这个位置：衣服刚画完、骨骼线还没画上去。
  // 而且 WebGL 画布合成完就被清空了（没开 preserveDrawingBuffer），
  // 换到别处再 drawImage 只会拿到一张空的。
  if (captureNext) {
    captureNext = false
    void snapshot(w, h)
  }

  // A 键：把每件衣服自己的骨架画在人身上，并在右上角放平铺图对照
  if (showAnchors && garmentMode === 'mesh') {
    const COLORS = ['#ffd166', '#00e5ff'] // 下装琥珀、上衣青
    meshAll().forEach((g, i) => g.drawRig(ctx, COLORS[i % 2]))
    const size = Math.min(160, w * 0.28)
    meshAll().forEach((g, i) =>
      g.drawRestInspector(ctx, w - size - 12, 12 + i * (size + 12), size, COLORS[i % 2]),
    )
  }

  if (showGarment && garmentUnlocked && garmentMode === 'rigid' && garment.ready && lms) {
    const fit = garment.fit(lms, w, h, Number(ui.vis.value), tSec)
    if (fit) {
      garment.draw(ctx, fit)
      if (showAnchors) garment.drawAnchors(ctx, fit)
    }
  }

  if (ui.pose.checked && lastResult?.landmarks?.length) {
    drawSkeleton(ctx, lastResult.landmarks[0], w, h, drawOpts)
  }

  // 手画在骨架之上，指尖不会被躯干线盖住。
  // Hand = 跑不跑推理，Hand UI = 画不画 —— 和身体那边的 UI 勾选框同一套逻辑，
  // 关掉显示不影响手势数据，后面做捏取交互时还要照常用
  if (ui.hand.checked && ui.handUi.checked && lastHandResult?.landmarks?.length) {
    drawHands(ctx, lastHandResult.landmarks, lastHandResult.handedness, w, h, drawOpts)
  }

  // 文件夹自己不跑循环，跟着主循环走：重新摆位 + 推进停留进度。
  // 手势用的是原始归一化坐标 × 舞台尺寸 —— 和骨骼线同一套，镜像/旋转由舞台
  // 的 CSS transform 一起带着走，这里不用再换算。
  let tip =
    ui.gesture.checked && lastHandResult?.landmarks?.length
      ? pointUp(lastHandResult.landmarks, w, h)
      : null
  // 指尖也是源图坐标系的，镜像时要翻到观众看到的那一侧
  if (tip && stage.mirrored) tip = { x: w - tip.x, y: tip.y }
  tickPersonaPrintClose(tip)
  const now = performance.now()
  // 捏合（4 号点碰 8 号点）走单独一条路：它不是「指向」，不参与文件夹的停留判定
  const hands = ui.gesture.checked ? lastHandResult?.landmarks : null
  tickCountdown(now)
  handleQuickChange(hands ?? undefined, now)

  // 云雨层没有反向抵消舞台镜像，因此手势要用源画面坐标。
  const rainPinch = hands?.length ? pinch(hands, w, h) : null
  // 捏合只保留羊头绳的抓取，不再触发羊毛雨 UI 图标或直接关闭云朵。
  cloudRain.updateHand(rainPinch)
  cloudRain.setMask(maskValues, personMask?.width ?? 0, personMask?.height ?? 0)
  cloudRain.update(now, w, h, lms)
  syncCloudRainHints()

  for (const f of folders) f.tick(now, tip)

  frames++
  if (now - fpsClock >= 500) {
    fps = Math.round((frames * 1000) / (now - fpsClock))
    frames = 0
    fpsClock = now
    refreshStats()
  }
}

/* ── 启动 ────────────────────────────────────────────────────── */

/**
 * 权重只用来算加载条走多快，不是真的字节数——真实字节数在下载时从
 * Content-Length 读，这里只是「pose 模型比 hand 模型占加载条几成」的估算，
 * 跟 public/models 里当前几个 .task 文件的实际大小对得上就行。
 */
const POSE_MODEL_WEIGHT: Record<ModelName, number> = {
  lite: 5_777_746,
  full: 9_398_198,
  heavy: 30_664_242,
}
const HAND_MODEL_WEIGHT = 7_819_105

async function boot() {
  refreshStats()
  requestAnimationFrame(loop)

  const needHand = handNeeded()
  const poseWeight = POSE_MODEL_WEIGHT[ui.model.value as ModelName] ?? POSE_MODEL_WEIGHT.lite
  const totalWeight = poseWeight + (needHand ? HAND_MODEL_WEIGHT : 0)
  let poseLoaded = 0
  let handLoaded = 0
  const paintLoading = () => setLoadingProgress((poseLoaded + handLoaded) / totalWeight)

  await reloadModel((loaded, total) => {
    poseLoaded = total ? (loaded / total) * poseWeight : poseWeight
    paintLoading()
  })
  await reloadHand((loaded, total) => {
    handLoaded = total ? (loaded / total) * HAND_MODEL_WEIGHT : HAND_MODEL_WEIGHT
    paintLoading()
  })
  garment.load().catch((e) => console.warn(e))
  const { theme, look } = lookFromQuery()
  void loadLook(theme, look)
  void mountFolders()

  // ?src=/test/xxx.png 直接喂素材，跳过摄像头（调锚点 / 演示兜底用）
  const src = new URLSearchParams(location.search).get('src')
  await sources.useUrl(src || DEFAULT_SCENE)
  void sources.refreshDevices()
  // 摄像头不再开局自动要权限——默认就是参考图，要开摄像头去面板里手动选设备。
  hideLoadingScreen()
}

void boot()
