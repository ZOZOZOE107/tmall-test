/**
 * 输入源抽象。摄像头 / 本地视频 / 本地图片 / 屏幕捕获对外都吐同一种「帧」，
 * 下游（MediaPipe、贴合、渲染）完全不关心画面从哪来。
 * 以后要加 WebRTC 手机推流，只是在这里多一个实现。
 */

export type SourceKind = 'none' | 'camera' | 'video' | 'image' | 'screen'

export interface ActiveSource {
  kind: SourceKind
  el: HTMLVideoElement | HTMLImageElement | null
  width: number
  height: number
  label: string
}

export interface CameraRequest {
  deviceId?: string
  /** 'auto' 或 '1280x720' 这类 */
  resolution?: string
  /** 竖向环境要 9:16 的流，横向要 16:9，这样 Fit Best 留边最小 */
  orientation?: 'landscape' | 'portrait'
}

const EMPTY: ActiveSource = { kind: 'none', el: null, width: 0, height: 0, label: '—' }

export class SourceManager {
  private videoEl: HTMLVideoElement
  private imageEl: HTMLImageElement
  private stream: MediaStream | null = null
  private objectUrl: string | null = null

  current: ActiveSource = EMPTY
  permissionGranted = false

  /** 摄像头实际交付的格式，和请求的可能不一样 */
  get trackSettings(): MediaTrackSettings | null {
    return this.stream?.getVideoTracks()[0]?.getSettings() ?? null
  }

  onChange?: (src: ActiveSource) => void
  onError?: (message: string) => void
  /** 不算出错，但人得知道：比如挑的那档相机给不了，退回了它自己的格式 */
  onNotice?: (message: string) => void
  onDevicesChange?: (devices: MediaDeviceInfo[]) => void

  constructor(videoEl: HTMLVideoElement, imageEl: HTMLImageElement) {
    this.videoEl = videoEl
    this.imageEl = imageEl

    // 热插拔：插上 USB 摄像头、iPhone 连上 Continuity，列表自动刷新
    navigator.mediaDevices?.addEventListener('devicechange', () => void this.refreshDevices())

    // 从别的 App 切回来时重新枚举。连续互通相机是独占的，被 TouchDesigner /
    // OBS / 视频会议抓住时会整个从列表里消失，放开之后要重新扫才看得到。
    window.addEventListener('focus', () => void this.refreshDevices())
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this.refreshDevices()
    })
  }

  async refreshDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await this.listDevices()
    this.onDevicesChange?.(devices)
    return devices
  }

  /** 授权之前 label 是空的，所以要先拿一次权限再枚举 */
  async requestPermission(): Promise<boolean> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      s.getTracks().forEach((t) => t.stop())
      this.permissionGranted = true
      return true
    } catch (err) {
      this.onError?.(describeMediaError(err))
      return false
    }
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'videoinput')
  }

  async useCamera(req: CameraRequest = {}): Promise<boolean> {
    this.stop()

    const portrait = req.orientation === 'portrait'
    /**
     * @param hard 挑明的那一档用 exact 要。
     *   ideal 是**建议**，设备可以当没看见 —— 连续互通相机就基本全程无视，
     *   于是选了哪一档画面都一个样。exact 要不到会抛 OverconstrainedError，
     *   那时再退回 ideal，至少还有画面，同时告诉人这台机器没有这一档。
     */
    const build = (hard: boolean): MediaTrackConstraints => {
      const video: MediaTrackConstraints = { frameRate: { ideal: 30 } }
      if (req.deviceId) video.deviceId = { exact: req.deviceId }

      if (req.resolution === 'native') {
        // 让浏览器原样交付摄像头格式，不做任何缩放和裁切
        ;(video as MediaTrackConstraints & { resizeMode?: string }).resizeMode = 'none'
        return video
      }
      if (req.resolution && req.resolution !== 'auto') {
        // 请求什么比例就给什么比例。连续互通相机竖着摆时，要竖向档才拿得到
        // 完整的垂直视野；要横向档系统就会按 16:9 裁给你。
        const [w, h] = req.resolution.split('x').map(Number)
        video.width = hard ? { exact: w } : { ideal: w }
        video.height = hard ? { exact: h } : { ideal: h }
        if (!hard) video.aspectRatio = { ideal: w / h }
        return video
      }
      video.width = { ideal: portrait ? 720 : 1280 }
      video.height = { ideal: portrait ? 1280 : 720 }
      video.aspectRatio = { ideal: portrait ? 9 / 16 : 16 / 9 }
      return video
    }

    /** 挑明了某一档才有硬要的意义；native / auto 本来就是「你看着办」 */
    const picked = !!req.resolution && req.resolution !== 'native' && req.resolution !== 'auto'

    try {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: build(picked), audio: false })
      } catch (err) {
        if (!picked || (err as DOMException)?.name !== 'OverconstrainedError') throw err
        console.warn('[camera]', req.resolution, '这台设备给不了，退回 ideal')
        this.onNotice?.(`This camera has no ${req.resolution} mode — using its closest format.`)
        stream = await navigator.mediaDevices.getUserMedia({ video: build(false), audio: false })
      }
      this.permissionGranted = true
      this.stream = stream
      const track = stream.getVideoTracks()[0]
      // 设备到底能给出哪些格式，直接打到控制台，方便判断是不是被裁了
      console.info('[camera] settings', track.getSettings())
      console.info('[camera] capabilities', track.getCapabilities?.())
      await this.attachStream(stream, 'camera', track.label || 'Camera')
      return true
    } catch (err) {
      this.onError?.(describeMediaError(err))
      this.emit(EMPTY)
      return false
    }
  }

  async useScreen(): Promise<boolean> {
    this.stop()
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      this.stream = stream
      await this.attachStream(stream, 'screen', 'Screen')
      return true
    } catch (err) {
      this.onError?.(describeMediaError(err))
      this.emit(EMPTY)
      return false
    }
  }

  async useFile(file: File): Promise<boolean> {
    this.stop()
    this.objectUrl = URL.createObjectURL(file)
    return this.loadMedia(this.objectUrl, file.type.startsWith('image/'), file.name)
  }

  /**
   * 直接喂一个 URL，配合 ?src= 用。
   * 调锚点要反复跑同一段素材，比每次站到镜头前试快得多；
   * 也是现场演示摄像头翻车时的兜底。
   */
  async useUrl(url: string): Promise<boolean> {
    this.stop()
    const isImage = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(url)
    return this.loadMedia(url, isImage, url.split('/').pop() ?? url)
  }

  private loadMedia(url: string, isImage: boolean, label: string): Promise<boolean> {
    if (isImage) {
      return new Promise((resolve) => {
        this.imageEl.onload = () => {
          this.videoEl.hidden = true
          this.imageEl.hidden = false
          this.emit({
            kind: 'image',
            el: this.imageEl,
            width: this.imageEl.naturalWidth,
            height: this.imageEl.naturalHeight,
            label,
          })
          resolve(true)
        }
        this.imageEl.onerror = () => {
          this.onError?.('Image decode failed')
          resolve(false)
        }
        this.imageEl.src = url
      })
    }

    return new Promise((resolve) => {
      const v = this.videoEl
      v.srcObject = null
      v.src = url
      v.loop = true
      v.muted = true
      v.onloadedmetadata = () => {
        void v.play()
        this.imageEl.hidden = true
        v.hidden = false
        this.emit({ kind: 'video', el: v, width: v.videoWidth, height: v.videoHeight, label })
        resolve(true)
      }
      v.onerror = () => {
        this.onError?.('Video decode failed — try mp4 (H.264)')
        resolve(false)
      }
    })
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null

    const v = this.videoEl
    v.pause()
    v.srcObject = null
    v.removeAttribute('src')
    v.load()
    v.hidden = true

    this.imageEl.removeAttribute('src')
    this.imageEl.hidden = true

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
    this.emit(EMPTY)
  }

  private attachStream(stream: MediaStream, kind: SourceKind, label: string): Promise<void> {
    return new Promise((resolve) => {
      const v = this.videoEl
      v.removeAttribute('src')
      v.loop = false
      v.srcObject = stream
      v.onloadedmetadata = () => {
        void v.play()
        this.imageEl.hidden = true
        v.hidden = false
        this.emit({ kind, el: v, width: v.videoWidth, height: v.videoHeight, label })
        resolve()
      }
    })
  }

  private emit(src: ActiveSource) {
    this.current = src
    this.onChange?.(src)
  }
}

function describeMediaError(err: unknown): string {
  const e = err as DOMException
  switch (e?.name) {
    case 'NotAllowedError':
      return 'Camera permission denied. Re-allow it from the address bar, or load a local video.'
    case 'NotFoundError':
      return 'No camera device found.'
    case 'NotReadableError':
      return 'Device is busy — another app (TouchDesigner / OBS / a video call) is holding it.'
    case 'OverconstrainedError':
      return 'This camera does not support the selected resolution.'
    case 'AbortError':
      return 'Cancelled.'
    default:
      return `Cannot open source: ${e?.message ?? String(err)}`
  }
}
