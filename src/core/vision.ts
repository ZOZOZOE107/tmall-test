/** wasm 只加载一次，Pose 和 Hand 两个 landmarker 共用。 */
import { FilesetResolver } from '@mediapipe/tasks-vision'

let cached: Promise<unknown> | null = null

export function getFileset(): Promise<unknown> {
  cached ??= FilesetResolver.forVisionTasks('/mediapipe/wasm')
  return cached
}
