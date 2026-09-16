/**
 * MediaPipe Pose Landmarker 封装。
 * wasm 和模型都在 public/ 下本地托管 —— 园区版要能整包离线跑，不依赖 CDN。
 */
import { PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision'
import { getFileset } from './vision'

export type ModelName = 'lite' | 'full' | 'heavy'
export type Delegate = 'GPU' | 'CPU'

const MODEL_PATH: Record<ModelName, string> = {
  lite: '/models/pose_landmarker_lite.task',
  full: '/models/pose_landmarker_full.task',
  heavy: '/models/pose_landmarker_heavy.task',
}

export class PoseEngine {
  private landmarker: PoseLandmarker | null = null
  private runningMode: 'VIDEO' | 'IMAGE' = 'VIDEO'
  private lastTimestamp = -1

  model: ModelName = 'lite'
  delegate: Delegate = 'GPU'
  segmentation = false
  ready = false
  /** 最近一次推理耗时 ms */
  inferMs = 0

  async load(
    model: ModelName = this.model,
    delegate: Delegate = this.delegate,
    segmentation = this.segmentation,
  ): Promise<void> {
    this.ready = false
    this.model = model
    this.delegate = delegate
    this.segmentation = segmentation

    const fileset = await getFileset()

    this.landmarker?.close()
    this.landmarker = await PoseLandmarker.createFromOptions(fileset as never, {
      baseOptions: {
        modelAssetPath: MODEL_PATH[model],
        delegate,
      },
      runningMode: this.runningMode,
      numPoses: 1, // 多人入镜时只追一个，规则见工作台 4.5「园区横屏规则」
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: segmentation,
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
  ): PoseLandmarkerResult | null {
    if (!this.ready || !this.landmarker) return null
    if (this.runningMode !== 'VIDEO') {
      void this.setMode('VIDEO')
      return null
    }
    // detectForVideo 要求时间戳严格递增，否则直接抛错
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

  async detectImage(el: HTMLImageElement): Promise<PoseLandmarkerResult | null> {
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

export type { PoseLandmarkerResult }
export { PoseLandmarker }
