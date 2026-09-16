/**
 * MediaPipe Hand Landmarker 封装。每只手 21 个点。
 * Pose 只给到手腕和几个粗略的手部点，拿不到手指 —— 文件夹停留命中、
 * 捏取拖拽、毛线绘画这些都要靠这里的指尖。
 */
import { HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision'
import { getFileset } from './vision'
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

  async load(numHands = this.numHands, delegate: Delegate = this.delegate): Promise<void> {
    this.ready = false
    this.numHands = numHands
    this.delegate = delegate

    const fileset = await getFileset()

    this.landmarker?.close()
    this.landmarker = await HandLandmarker.createFromOptions(fileset as never, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
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
