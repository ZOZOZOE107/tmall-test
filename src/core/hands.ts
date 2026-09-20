/**
 * MediaPipe Hand Landmarker 封装。每只手 21 个点。
 * Pose 只给到手腕和几个粗略的手部点，拿不到手指 —— 文件夹停留命中、
 * 捏取拖拽、毛线绘画这些都要靠这里的指尖。
 */
import { HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision'
import { getFileset } from './vision'
import { fetchWithProgress } from './progress'
import type { Delegate } from './pose'

const MODEL_PATH = '/models/hand_landmarker.task'

export class HandEngine {
  private landmarker: HandLandmarker | null = null
  private runningMode: 'VIDEO' | 'IMAGE' = 'VIDEO'
  private lastTimestamp = -1

  delegate: Delegate = 'GPU'
  numHands = 2
  ready = false
  inferMs = 0

  async load(
    numHands = this.numHands,
    delegate: Delegate = this.delegate,
    /** 传了就手动下载模型文件量真实字节进度，不传就照旧交给库自己 fetch */
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    this.ready = false
    this.numHands = numHands
    this.delegate = delegate

    const [fileset, modelAssetBuffer] = await Promise.all([
      getFileset(),
      onProgress
        ? fetchWithProgress(MODEL_PATH, onProgress).then((buf) => new Uint8Array(buf))
        : Promise.resolve(undefined),
    ])

    this.landmarker?.close()
    this.landmarker = await HandLandmarker.createFromOptions(fileset as never, {
      baseOptions: modelAssetBuffer ? { modelAssetBuffer, delegate } : { modelAssetPath: MODEL_PATH, delegate },
      runningMode: this.runningMode,
      numHands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })

    this.lastTimestamp = -1
    this.ready = true
  }

  private async setMode(mode: 'VIDEO' | 'IMAGE') {
    if (this.runningMode === mode || !this.landmarker) return
    this.runningMode = mode
    await this.landmarker.setOptions({ runningMode: mode })
    this.lastTimestamp = -1
  }

  detectVideo(
    el: HTMLVideoElement | HTMLCanvasElement,
    timestampMs: number,
  ): HandLandmarkerResult | null {
    if (!this.ready || !this.landmarker) return null
    if (this.runningMode !== 'VIDEO') {
      void this.setMode('VIDEO')
      return null
    }
    const ts = timestampMs <= this.lastTimestamp ? this.lastTimestamp + 1 : timestampMs
    this.lastTimestamp = ts

    const t0 = performance.now()
    try {
      const res = this.landmarker.detectForVideo(el, ts)
      this.inferMs = performance.now() - t0
      return res
    } catch {
      return null
    }
  }

  async detectImage(el: HTMLImageElement): Promise<HandLandmarkerResult | null> {
    if (!this.ready || !this.landmarker) return null
    await this.setMode('IMAGE')
    const t0 = performance.now()
    try {
      const res = this.landmarker.detect(el)
      this.inferMs = performance.now() - t0
      return res
    } catch {
      return null
    }
  }

  close() {
    this.landmarker?.close()
    this.landmarker = null
    this.ready = false
  }
}

export type { HandLandmarkerResult }
