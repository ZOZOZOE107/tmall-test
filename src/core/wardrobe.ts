/**
 * 衣橱清单。每件衣服的形变参数只有一份，就在 public/garments/manifest.json 里。
 * 代码不再硬编码任何数值 —— 调好的值写回 manifest，改一处全站生效。
 */
import type { MeshGarmentConfig } from './garment-mesh'

export type Slot = 'top' | 'bottom' | 'inner'

export interface LookEntry {
  id: string
  /** 一张完整的透明穿搭图，替代分开的上衣和下装。 */
  fullOverlay?: string
  /** 肩宽倍数与图片内肩点位置，用于整套图贴合锁定的人物。 */
  fullOverlayFit?: { widthByShoulders: number; shoulderX: number; shoulderY: number }
  pieces: Partial<Record<Slot | 'full', string>>
  fit: Partial<Record<Slot, MeshGarmentConfig & { tuned?: boolean }>>
}

export interface ThemeEntry {
  id: string
  name: string
  scene: string
  brand: string
  tagline: string
  color: string
  logo?: string
  looks: LookEntry[]
}

export interface Manifest {
  version: number
  themes: ThemeEntry[]
}

let cache: Manifest | null = null

export async function loadWardrobe(): Promise<Manifest> {
  if (cache) return cache
  const res = await fetch('/garments/manifest.json')
  if (!res.ok) throw new Error(`manifest load failed: ${res.status}`)
  cache = (await res.json()) as Manifest
  return cache
}

export function findLook(m: Manifest, themeId: string, lookId: string): LookEntry | null {
  const t = m.themes.find((x) => x.id === themeId)
  return t?.looks.find((l) => l.id === lookId) ?? null
}

/** 解析 ?look=outdoor/look1，缺省回到示范用的那套 */
export function lookFromQuery(): { theme: string; look: string } {
  const raw = new URLSearchParams(location.search).get('look') ?? 'outdoor/look1'
  const [theme, look] = raw.split('/')
  return { theme: theme || 'outdoor', look: look || 'look1' }
}

/** 把当前（可能刚用键盘调过的）参数导出成可以贴回 manifest 的 JSON */
export function dumpFit(cfg: MeshGarmentConfig): string {
  const { id, src, rig, rest, grid, torsoBias, falloff, widthEase, lengthEase, offsetY } = cfg
  const { seam, seamPenalty, pins, pinRadius } = cfg
  return JSON.stringify(
    { id, src, rig, rest, grid, torsoBias, falloff, widthEase, lengthEase, offsetY, seam, seamPenalty, pins, pinRadius, tuned: true },
    null,
    2,
  )
}
