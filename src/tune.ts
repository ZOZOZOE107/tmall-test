/**
 * 衣服骨骼调参台（独立页面，和主页面共用 manifest.json）。
 *
 * 左边是平铺的衣服图，上面的点是「人穿上这件衣服之后关节会在哪」，鼠标直接拖。
 * 右边拿 MediaPipe 在背景图上跑一次身体识别，实时把变形结果画上去。
 * 调好按 Save，参数写回 public/garments/manifest.json —— 主页面读的是同一份。
 *
 * 保存走 vite.config.ts 里的 /__manifest 开发接口，只在 dev server 上存在。
 */
import './styles/tune.css'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { MeshGarment, type MeshGarmentConfig } from './core/garment-mesh'
import { PoseEngine } from './core/pose'
import { RIGS, resolveRef, type V2 } from './core/rig'
import { drawSkeleton } from './core/draw'
import type { Manifest, Slot } from './core/wardrobe'

const BG = '/test/desk-scene.png'
const MIN_VIS = 0.5
const SLOT_ORDER: Slot[] = ['top', 'inner', 'bottom']
const DPR = Math.min(window.devicePixelRatio || 1, 2)

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const ui = {
  pick: $<HTMLSelectElement>('pick'),
  mirror: $<HTMLInputElement>('mirror'),
  showRig: $<HTMLInputElement>('showRig'),
  showPose: $<HTMLInputElement>('showPose'),
  rigid: $<HTMLInputElement>('rigid'),
  reset: $<HTMLButtonElement>('reset'),
  save: $<HTMLButtonElement>('save'),
  topOnly: $<HTMLSpanElement>('topOnly'),
  seamAdd: $<HTMLButtonElement>('seamAdd'),
  pinAdd: $<HTMLButtonElement>('pinAdd'),
  seamClear: $<HTMLButtonElement>('seamClear'),
  status: $<HTMLSpanElement>('status'),
  hint: $<HTMLParagraphElement>('hint'),
  flat: $<HTMLImageElement>('flat'),
  flatCv: $<HTMLCanvasElement>('flatCv'),
  bg: $<HTMLImageElement>('bg'),
  bodyWrap: $<HTMLDivElement>('bodyWrap'),
  meshCv: $<HTMLCanvasElement>('meshCv'),
  overlayCv: $<HTMLCanvasElement>('overlayCv'),
}

const sliders = [
  'widthEase', 'lengthEase', 'offsetY', 'torsoBias', 'falloff', 'grid', 'seamPenalty', 'pinRadius',
] as const
type SliderKey = (typeof sliders)[number]
/** 这几个参数改了要重建网格和权重，其余的每帧 fit 时才用到 */
const REBUILD_KEYS = new Set<SliderKey>(['torsoBias', 'falloff', 'grid', 'seamPenalty', 'pinRadius'])
const SLIDER_DEFAULT: Record<SliderKey, number> = {
  widthEase: 1, lengthEase: 1, offsetY: 0, torsoBias: 2, falloff: 3, grid: 24,
  seamPenalty: 5, pinRadius: 0.08,
}

const slider = (k: SliderKey) => $<HTMLInputElement>(k)
const sliderOut = (k: SliderKey) => $<HTMLOutputElement>(`${k}V`)

/* ── 状态 ───────────────────────────────────────────────────── */
interface Entry {
  key: string
  themeId: string
  themeName: string
  lookId: string
  slot: Slot
  cfg: MeshGarmentConfig & { tuned?: boolean }
  /** manifest 里的原始值，Revert 回到这里 */
  original: MeshGarmentConfig & { tuned?: boolean }
}

let entries: Entry[] = []
let current: Entry | null = null
let garment: MeshGarment | null = null
let landmarks: NormalizedLandmark[] | null = null
let needRebuild = false
let dragging: string | null = null
let hovered: string | null = null
let selected: string | null = null

const pose = new PoseEngine()

const setStatus = (msg: string, kind: '' | 'ok' | 'err' = '') => {
  ui.status.textContent = msg
  ui.status.className = `status ${kind}`
}

/* ── 画布对齐 ───────────────────────────────────────────────── */
/**
 * 把覆盖层贴到图片真正画出来的那块矩形上。
 *
 * <img> 自己铺满容器再 object-fit: contain，所以它的 boundingRect 是容器大小、
 * 不是画面大小 —— 这里按同一套 Fit Best 规则重新算一遍（等比缩放取小的那个，居中）。
 */
function syncCanvas(cv: HTMLCanvasElement, img: HTMLImageElement): { w: number; h: number } {
  // clientWidth/Height 是内边距盒，和绝对定位子元素的参照系一致（不含 1px 边框）
  const wrap = img.parentElement!
  const bw = wrap.clientWidth
  const bh = wrap.clientHeight
  const iw = img.naturalWidth || 1
  const ih = img.naturalHeight || 1
  const k = Math.min(bw / iw, bh / ih)
  const w = Math.max(1, Math.round(iw * k))
  const h = Math.max(1, Math.round(ih * k))
  cv.style.left = `${Math.round((bw - w) / 2)}px`
  cv.style.top = `${Math.round((bh - h) / 2)}px`
  cv.style.width = `${w}px`
  cv.style.height = `${h}px`
  return { w, h }
}

function ctx2d(cv: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const pw = Math.round(w * DPR)
  const ph = Math.round(h * DPR)
  if (cv.width !== pw || cv.height !== ph) {
    cv.width = pw
    cv.height = ph
  }
  const c = cv.getContext('2d')!
  c.setTransform(DPR, 0, 0, DPR, 0, 0)
  c.clearRect(0, 0, w, h)
  return c
}

/* ── 清单 ───────────────────────────────────────────────────── */
async function loadEntries(): Promise<void> {
  const res = await fetch(`/garments/manifest.json?t=${Date.now()}`)
  if (!res.ok) throw new Error(`manifest ${res.status}`)
  const m = (await res.json()) as Manifest

  entries = []
  for (const theme of m.themes) {
    for (const look of theme.looks) {
      for (const slot of SLOT_ORDER) {
        const fit = look.fit?.[slot]
        if (!fit) continue
        entries.push({
          key: `${theme.id}/${look.id}/${slot}`,
          themeId: theme.id,
          themeName: theme.name,
          lookId: look.id,
          slot,
          cfg: structuredClone(fit),
          original: structuredClone(fit),
        })
      }
    }
  }

  ui.pick.innerHTML = ''
  for (const e of entries) {
    const o = document.createElement('option')
    o.value = e.key
    o.textContent = `${e.cfg.tuned ? '✓' : '·'}  ${e.themeName} / ${e.lookId} / ${e.slot}`
    ui.pick.append(o)
  }
}

function refreshOptionLabel(e: Entry) {
  const o = [...ui.pick.options].find((x) => x.value === e.key)
  if (o) o.textContent = `${e.cfg.tuned ? '✓' : '·'}  ${e.themeName} / ${e.lookId} / ${e.slot}`
}

/** 把滑杆拨到当前这件的值上。cfg 里没写的走默认 */
function syncSliders() {
  if (!current) return
  for (const k of sliders) {
    const v = (current.cfg as unknown as Record<string, unknown>)[k]
    slider(k).value = String(typeof v === 'number' ? v : SLIDER_DEFAULT[k])
    sliderOut(k).textContent = slider(k).value
  }
}

/* ── 选中一件 ───────────────────────────────────────────────── */
async function select(key: string): Promise<void> {
  const e = entries.find((x) => x.key === key)
  if (!e) return
  current = e
  dragging = null
  selected = null
  ui.pick.value = key

  syncSliders()
  ui.rigid.checked = !!e.cfg.rigid
  // CSS 用 [data-rig] 决定藏不藏那两根上衣专属的滑杆
  document.body.dataset.rig = e.cfg.rig
  ui.topOnly.hidden = e.cfg.rig !== 'top'

  // 每件换一张新 canvas：WebGL 上下文一个 canvas 只能有一个，换元素才好回收
  const fresh = document.createElement('canvas')
  fresh.id = 'meshCv'
  ui.meshCv.replaceWith(fresh)
  ui.meshCv = fresh

  ui.flat.src = e.cfg.src
  // 提示只留一行 —— 窗口窄的时候多行提示会把上面两张图挤没
  ui.hint.textContent =
    `${e.cfg.id} · ${e.cfg.rig} rig — cyan = where the wearer's joint sits inside this garment` +
    (e.cfg.rig === 'top' ? ' · red = sleeve/body cut · blue = pin' : '')
  ui.flatCv.title =
    'Drag a handle to move it (mirror L/R applies). Arrow keys nudge, Shift = coarse.' +
    (e.cfg.rig === 'top'
      ? '\nDouble-click the red line: add a point.\n⌥-click empty space: drop a pair of pins.\nRight-click a red/blue handle (or select + Delete): remove it.'
      : '')
  setStatus(`loading ${e.cfg.id}…`)

  garment = new MeshGarment(e.cfg, fresh)
  await Promise.all([
    garment.load(),
    ui.flat.decode().catch(() => undefined),
  ])
  needRebuild = false
  setStatus(e.cfg.tuned ? 'tuned' : 'not tuned yet', e.cfg.tuned ? 'ok' : '')
}

/* ── 手柄 ───────────────────────────────────────────────────
 * 骨骼点、分割线控制点、图钉三种东西共用一套拖拽 —— 都是「图上的一个归一化点」，
 * 区别只在画成什么样、写回 cfg 的哪个字段。
 */
type Side = 'r' | 'l'
interface Handle {
  key: string
  kind: 'joint' | 'seam' | 'pin'
  /** joint 存关节名，seam/pin 存左右 */
  name: string
  index: number
  p: V2
}

const SIDES: Side[] = ['r', 'l']
const isTop = () => current?.cfg.rig === 'top'

function handles(): Handle[] {
  const out: Handle[] = []
  if (!current) return out
  for (const [name, p] of Object.entries(current.cfg.rest)) {
    out.push({ key: `j:${name}`, kind: 'joint', name, index: -1, p })
  }
  if (!isTop()) return out
  const { seam, pins } = current.cfg
  for (const s of SIDES) {
    seam?.[s]?.forEach((p, i) => out.push({ key: `s:${s}:${i}`, kind: 'seam', name: s, index: i, p }))
    pins?.[s]?.forEach((p, i) => out.push({ key: `p:${s}:${i}`, kind: 'pin', name: s, index: i, p }))
  }
  return out
}

/** 存进 manifest 的值取 4 位小数就够了，免得一屏全是 0.22459016393442624 */
const r4 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4

const partnerOf = (name: string) => {
  if (name.startsWith('r')) return `l${name.slice(1)}`
  if (name.startsWith('l')) return `r${name.slice(1)}`
  return null
}

function writeHandle(h: Handle, nx: number, ny: number) {
  if (!current) return
  const cfg = current.cfg
  const x = r4(nx)
  const y = r4(ny)
  if (h.kind === 'joint') {
    cfg.rest[h.name] = { x, y }
    if (ui.mirror.checked) {
      const o = partnerOf(h.name)
      // 衣服都是左右对称的，镜像点绕图片中线走
      if (o && cfg.rest[o]) cfg.rest[o] = { x: r4(1 - x), y }
    }
  } else {
    const bag = h.kind === 'seam' ? cfg.seam : cfg.pins
    if (!bag) return
    const side = h.name as Side
    bag[side][h.index] = { x, y }
    const other: Side = side === 'r' ? 'l' : 'r'
    if (ui.mirror.checked && bag[other][h.index]) bag[other][h.index] = { x: r4(1 - x), y }
  }
  needRebuild = true
  markDirty()
}

/* ── 增删 ───────────────────────────────────────────────────
 * 分割线和图钉的「有几个」两边永远一致 —— 增删一律成对做，mirror 勾选框只管
 * 拖的时候跟不跟，不管拓扑。否则两边长度一错，按下标配对的镜像就乱了。
 */
function defaultSeam() {
  if (!current) return
  const r = current.cfg.rest
  const sh = r.rShoulder
  const hip = r.rHip
  if (!sh || !hip) return
  // 从腋下起，顺着袖子内缘往下，一直拉出下摆 —— 屏障要贯通整个高度才挡得住
  const pts: V2[] = [
    { x: r4(sh.x + 0.05), y: r4(sh.y + 0.1) },
    { x: r4(hip.x - 0.005), y: 0.62 },
    { x: r4(hip.x - 0.06), y: 1 },
  ]
  current.cfg.seam = { r: pts, l: pts.map((p) => ({ x: r4(1 - p.x), y: p.y })) }
  current.cfg.seamPenalty ??= SLIDER_DEFAULT.seamPenalty
  needRebuild = true
  markDirty()
  syncSliders()
}

function addPinPair(at?: V2) {
  if (!current) return
  const hip = current.cfg.rest.rHip
  const p = at ?? (hip ? { x: hip.x, y: hip.y } : { x: 0.32, y: 0.9 })
  const cfg = current.cfg
  cfg.pins ??= { r: [], l: [] }
  cfg.pins.r.push({ x: r4(p.x), y: r4(p.y) })
  cfg.pins.l.push({ x: r4(1 - p.x), y: r4(p.y) })
  cfg.pinRadius ??= SLIDER_DEFAULT.pinRadius
  needRebuild = true
  markDirty()
  syncSliders()
}

/** 双击分割线：在最近的那一段中间插一个控制点 */
function insertSeamPoint(nx: number, ny: number) {
  const seam = current?.cfg.seam
  if (!seam) return false
  let best = { d: Infinity, i: -1 }
  for (let i = 0; i + 1 < seam.r.length; i++) {
    for (const s of SIDES) {
      const a = seam[s][i]
      const b = seam[s][i + 1]
      const vx = b.x - a.x
      const vy = b.y - a.y
      const len2 = vx * vx + vy * vy || 1e-9
      const t = Math.max(0, Math.min(1, ((nx - a.x) * vx + (ny - a.y) * vy) / len2))
      const d = Math.hypot(nx - (a.x + t * vx), ny - (a.y + t * vy))
      if (d < best.d) best = { d, i }
    }
  }
  if (best.i < 0 || best.d > 0.04) return false
  for (const s of SIDES) {
    const a = seam[s][best.i]
    const b = seam[s][best.i + 1]
    seam[s].splice(best.i + 1, 0, { x: r4((a.x + b.x) / 2), y: r4((a.y + b.y) / 2) })
  }
  needRebuild = true
  markDirty()
  return true
}

function deleteHandle(h: Handle) {
  if (!current || h.kind === 'joint') return
  const cfg = current.cfg
  if (h.kind === 'seam') {
    // 两点以下就不是线了
    if (!cfg.seam || cfg.seam.r.length <= 2) return
    for (const s of SIDES) cfg.seam[s].splice(h.index, 1)
  } else {
    if (!cfg.pins) return
    for (const s of SIDES) cfg.pins[s].splice(h.index, 1)
  }
  selected = null
  needRebuild = true
  markDirty()
}

/* ── 平铺图 ─────────────────────────────────────────────────── */
const JOINT = '#00e5ff'
const ACTIVE = '#ffd166'
const SEAM = '#ff2d2d'
const PIN = '#2233ff'

function drawFlat() {
  if (!current) return
  const { w, h } = syncCanvas(ui.flatCv, ui.flat)
  const c = ctx2d(ui.flatCv, w, h)
  const cfg = current.cfg
  const rest = cfg.rest
  const rig = RIGS[cfg.rig]
  const at = (p: V2) => ({ x: p.x * w, y: p.y * h })

  // 骨头
  c.lineWidth = 2
  c.strokeStyle = 'rgba(0,229,255,0.75)'
  c.lineCap = 'round'
  for (const [a, b] of rig.bones) {
    const pa = at(resolveRef(a, (j) => rest[j]))
    const pb = at(resolveRef(b, (j) => rest[j]))
    c.beginPath()
    c.moveTo(pa.x, pa.y)
    c.lineTo(pb.x, pb.y)
    c.stroke()
  }

  if (isTop()) {
    // 图钉作用范围：先铺一层淡蓝，让人看见钉子管到哪儿
    const rad = (cfg.pinRadius ?? 0) * w
    if (cfg.pins && rad > 0) {
      c.fillStyle = 'rgba(34,51,255,0.16)'
      for (const s of SIDES) {
        for (const p of cfg.pins[s]) {
          const q = at(p)
          c.beginPath()
          c.arc(q.x, q.y, rad, 0, Math.PI * 2)
          c.fill()
        }
      }
    }
    // 分割线
    if (cfg.seam) {
      c.lineWidth = 4
      c.strokeStyle = SEAM
      c.lineJoin = 'round'
      for (const s of SIDES) {
        const pts = cfg.seam[s]
        if (pts.length < 2) continue
        c.beginPath()
        pts.forEach((p, i) => {
          const q = at(p)
          if (i === 0) c.moveTo(q.x, q.y)
          else c.lineTo(q.x, q.y)
        })
        c.stroke()
      }
    }
  }

  // 手柄
  c.font = '600 11px ui-monospace, monospace'
  c.textBaseline = 'middle'
  for (const hd of handles()) {
    const q = at(hd.p)
    const on = hd.key === dragging || hd.key === hovered || hd.key === selected
    const base = hd.kind === 'joint' ? JOINT : hd.kind === 'seam' ? SEAM : PIN
    c.fillStyle = on ? ACTIVE : base
    c.lineWidth = 2
    c.strokeStyle = 'rgba(255,255,255,0.9)'
    if (hd.kind === 'seam') {
      const s = on ? 7 : 5
      c.beginPath()
      c.rect(q.x - s, q.y - s, s * 2, s * 2)
      c.fill()
      c.stroke()
    } else {
      c.beginPath()
      c.arc(q.x, q.y, on ? 8 : 6, 0, Math.PI * 2)
      c.fill()
      c.stroke()
    }

    // 骨骼点才标名字和坐标，分割线/图钉标上去就糊成一片了
    if (hd.kind !== 'joint') continue
    const name = hd.name
    const label = w < 460 && !on ? name : `${name}  ${hd.p.x.toFixed(3)}, ${hd.p.y.toFixed(3)}`
    const tw = c.measureText(label).width
    // 默认右侧关节的标签朝左写；贴到画布边上就翻到另一侧，别被裁掉
    let right = name.startsWith('r')
    if (right && q.x - 12 - tw < 2) right = false
    else if (!right && q.x + 12 + tw > w - 2) right = true
    c.textAlign = right ? 'right' : 'left'
    const tx = q.x + (right ? -12 : 12)
    const ty = Math.min(h - 8, Math.max(8, q.y))
    c.lineWidth = 3
    c.strokeStyle = 'rgba(255,255,255,0.85)'
    c.strokeText(label, tx, ty)
    c.fillStyle = '#1a1a1a'
    c.fillText(label, tx, ty)
  }
}

/** 屏幕坐标 → 命中的手柄。分割线和图钉优先，它们常压在骨骼点上 */
function hit(x: number, y: number, w: number, h: number): Handle | null {
  let best: Handle | null = null
  let bestD = 14
  for (const hd of handles()) {
    const d = Math.hypot(hd.p.x * w - x, hd.p.y * h - y)
    const bonus = hd.kind === 'joint' ? 0 : -3
    if (d + bonus < bestD) {
      bestD = d + bonus
      best = hd
    }
  }
  return best
}

const handleOf = (key: string | null) => (key ? handles().find((h) => h.key === key) ?? null : null)

function markDirty() {
  if (!current) return
  if (current.cfg.tuned) {
    current.cfg.tuned = false
    refreshOptionLabel(current)
  }
  setStatus('unsaved changes')
}

/* ── 鼠标 ───────────────────────────────────────────────────── */
const localXY = (ev: PointerEvent) => {
  const r = ui.flatCv.getBoundingClientRect()
  return { x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width, h: r.height }
}

ui.flatCv.addEventListener('pointerdown', (ev) => {
  const { x, y, w, h } = localXY(ev)
  // ⌥ + 点空白 = 在这儿钉一对图钉
  if (ev.altKey && isTop()) {
    addPinPair({ x: x / w, y: y / h })
    ev.preventDefault()
    return
  }
  const hd = hit(x, y, w, h)
  if (!hd) return
  dragging = hd.key
  selected = hd.key
  ui.flatCv.classList.add('dragging')
  ui.flatCv.setPointerCapture(ev.pointerId)
  ev.preventDefault()
})

ui.flatCv.addEventListener('pointermove', (ev) => {
  const { x, y, w, h } = localXY(ev)
  if (dragging) {
    const hd = handleOf(dragging)
    if (hd) writeHandle(hd, x / w, y / h)
  } else {
    hovered = hit(x, y, w, h)?.key ?? null
  }
})

/** 双击红线中间：加一个控制点 */
ui.flatCv.addEventListener('dblclick', (ev) => {
  if (!isTop()) return
  const r = ui.flatCv.getBoundingClientRect()
  if (insertSeamPoint((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height)) ev.preventDefault()
})

/** 右键手柄：删掉它（连同对面镜像的那个） */
ui.flatCv.addEventListener('contextmenu', (ev) => {
  const r = ui.flatCv.getBoundingClientRect()
  const hd = hit(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height)
  if (!hd || hd.kind === 'joint') return
  ev.preventDefault()
  deleteHandle(hd)
})

const endDrag = (ev: PointerEvent) => {
  if (!dragging) return
  dragging = null
  ui.flatCv.classList.remove('dragging')
  ui.flatCv.releasePointerCapture?.(ev.pointerId)
}
ui.flatCv.addEventListener('pointerup', endDrag)
ui.flatCv.addEventListener('pointercancel', endDrag)
ui.flatCv.addEventListener('pointerleave', () => {
  if (!dragging) hovered = null
})

/** 方向键微调选中的点；Shift = 粗调 */
window.addEventListener('keydown', (ev) => {
  if (!selected || !current) return
  // 焦点在滑杆/下拉里时方向键归它们
  const tag = (ev.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return
  const hd = handleOf(selected)
  if (!hd) return
  if (ev.key === 'Backspace' || ev.key === 'Delete') {
    ev.preventDefault()
    deleteHandle(hd)
    return
  }
  const step = ev.shiftKey ? 0.01 : 0.002
  const d: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
  }
  const v = d[ev.key]
  if (!v) return
  ev.preventDefault()
  writeHandle(hd, hd.p.x + v[0], hd.p.y + v[1])
})

/* ── 上衣专属的三个按钮 ─────────────────────────────────────── */
ui.seamAdd.addEventListener('click', () => defaultSeam())
ui.pinAdd.addEventListener('click', () => addPinPair())
ui.seamClear.addEventListener('click', () => {
  if (!current) return
  delete current.cfg.seam
  delete current.cfg.pins
  selected = null
  needRebuild = true
  markDirty()
})

ui.rigid.addEventListener('change', () => {
  if (!current) return
  current.cfg.rigid = ui.rigid.checked
  markDirty()
})

/* ── 滑杆 ───────────────────────────────────────────────────── */
for (const k of sliders) {
  slider(k).addEventListener('input', () => {
    if (!current) return
    const v = Number(slider(k).value)
    ;(current.cfg as unknown as Record<string, number>)[k] = v
    sliderOut(k).textContent = slider(k).value
    if (REBUILD_KEYS.has(k)) needRebuild = true
    markDirty()
  })
}

/* ── 保存 / 还原 ────────────────────────────────────────────── */
ui.reset.addEventListener('click', () => {
  if (!current) return
  current.cfg = structuredClone(current.original)
  refreshOptionLabel(current)
  void select(current.key)
})

ui.save.addEventListener('click', async () => {
  if (!current) return
  const e = current
  const { id, src, rig, rest, grid, torsoBias, falloff, widthEase, lengthEase, offsetY } = e.cfg
  const { seam, pins, seamPenalty, pinRadius } = e.cfg
  const fit: Record<string, unknown> = { rig, rest, widthEase, lengthEase, grid, torsoBias, falloff, src, id, tuned: true, offsetY: offsetY ?? 0 }
  // 没画分割线/图钉的衣服就别往 manifest 里塞空字段
  if (seam) Object.assign(fit, { seam, seamPenalty: seamPenalty ?? SLIDER_DEFAULT.seamPenalty })
  if (pins?.r.length) Object.assign(fit, { pins, pinRadius: pinRadius ?? SLIDER_DEFAULT.pinRadius })
  if (e.cfg.rigid) fit.rigid = true

  ui.save.disabled = true
  setStatus('saving…')
  try {
    const res = await fetch('/__manifest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeId: e.themeId, lookId: e.lookId, slot: e.slot, fit }),
    })
    const out = (await res.json()) as { ok: boolean; error?: string }
    if (!out.ok) throw new Error(out.error ?? `HTTP ${res.status}`)
    e.cfg.tuned = true
    e.original = structuredClone(e.cfg)
    refreshOptionLabel(e)
    setStatus(`saved · ${e.key}`, 'ok')
  } catch (err) {
    setStatus(`save failed: ${String(err)}`, 'err')
  } finally {
    ui.save.disabled = false
  }
})

ui.pick.addEventListener('change', () => void select(ui.pick.value))

/* ── 渲染循环 ───────────────────────────────────────────────── */
let alive = true

function frame(tMs: number) {
  if (!alive) return
  requestAnimationFrame(frame)
  if (!current || !garment?.ready) return

  if (needRebuild) {
    needRebuild = false
    garment.rebuild()
  }

  drawFlat()

  const { w, h } = syncCanvas(ui.meshCv, ui.bg)
  syncCanvas(ui.overlayCv, ui.bg)
  const c = ctx2d(ui.overlayCv, w, h)

  if (!landmarks) {
    garment.clear(w, h, DPR)
    return
  }

  const tSec = tMs / 1000
  if (garment.fit(landmarks, w, h, MIN_VIS, tSec)) garment.render(w, h, DPR)
  else garment.clear(w, h, DPR)

  if (ui.showPose.checked) {
    drawSkeleton(c, landmarks, w, h, { minVisibility: MIN_VIS, showIndex: false, mirrored: false })
  }
  if (ui.showRig.checked) garment.drawRig(c)
}

/* ── 启动 ───────────────────────────────────────────────────── */
async function boot() {
  setStatus('loading manifest…')
  await loadEntries()
  if (!entries.length) {
    setStatus('manifest has no fit entries', 'err')
    return
  }

  ui.bg.src = BG
  await ui.bg.decode().catch(() => undefined)

  await select(entries[0].key)
  requestAnimationFrame(frame)

  setStatus('detecting body…')
  await pose.load('full', 'GPU')
  const res = await pose.detectImage(ui.bg)
  landmarks = res?.landmarks?.[0] ?? null
  if (!landmarks) {
    setStatus('no body found in background image', 'err')
    ui.hint.textContent = `Background ${BG} — MediaPipe found no full body, the right pane stays empty.`
    return
  }
  setStatus(current?.cfg.tuned ? 'tuned' : 'not tuned yet', current?.cfg.tuned ? 'ok' : '')
}

void boot().catch((err) => setStatus(String(err), 'err'))

// 窗口尺寸变化不用特别处理：每帧都从 <img> 的实际矩形重新对齐画布

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    alive = false
    pose.close()
  })
}
