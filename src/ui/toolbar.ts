/** 左侧折叠工具栏的开合。正式皮肤上线后这整块可以直接摘掉。 */
export class DevPanel {
  private panel: HTMLElement
  private handle: HTMLButtonElement

  constructor(panel: HTMLElement, handle: HTMLButtonElement) {
    this.panel = panel
    this.handle = handle

    handle.addEventListener('click', () => this.toggle())

    // 反引号快速开合，演示时不用找把手
    window.addEventListener('keydown', (e) => {
      if (e.key === '`' && !isTyping(e.target)) {
        e.preventDefault()
        this.toggle()
      }
    })
  }

  get isOpen() {
    return !this.panel.classList.contains('is-closed')
  }

  toggle(force?: boolean) {
    const open = force ?? !this.isOpen
    this.panel.classList.toggle('is-closed', !open)
    this.handle.setAttribute('aria-expanded', String(open))
  }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
}
