import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import type { Vec2 } from '@core/types'

// «Пометить» is a chat tool now: no button on the left rail, P still starts it, and a mark drawn on
// the plan goes into the message as a «Пометка ①» chip with the keyboard back in the chat input.

vi.mock('@/store/api', () => {
  const fallback = (o: Record<string, unknown> = {}): unknown => new Proxy(o, { get: (t, k: string) => (k in t ? t[k] : async () => undefined) })
  return { api: fallback({ platform: 'win32', aiChat: fallback({ onEvent: () => () => {} }), settings: fallback(), project: fallback() }) }
})

const { docStore } = await import('@/store/document')
const { uiStore } = await import('@/store/ui')
const { marksStore, MARK_HINT } = await import('@/store/marks')
const { aiStore } = await import('./store')
const { createPencilTool } = await import('@/editor2d/tools/pencil')
const { TOOLS } = await import('@/ui/shell/ToolRail')
const { t } = await import('@/i18n')
await import('./i18n')

beforeAll(() => {
  docStore.getState().load(createEmptyDoc('T'), null)
})

describe('the «Пометить» tool', () => {
  it('has the P hotkey but no rail button; the label, hint and status text are translated', () => {
    const def = TOOLS.find((d) => d !== 'sep' && d.id === 'pencil')
    expect(def).toMatchObject({ key: 'P', label: 'Пометить', hint: MARK_HINT, rail: false })
    uiStore.setState({ lang: 'en' })
    try {
      expect(t('Пометить')).toBe('Mark')
      expect(t('Пометки')).toBe('Marks')
      expect(t(MARK_HINT)).not.toMatch(/[А-Яа-яЁё]/)
    } finally {
      uiStore.setState({ lang: 'ru' })
    }
    // nothing else is left off the rail
    expect(TOOLS.filter((d) => d !== 'sep' && d.rail === false).map((d) => d !== 'sep' && d.id)).toEqual(['pencil'])
  })

  it('a mark drawn on the plan becomes a numbered chip and the chat input gets the keyboard', async () => {
    const lv = Object.keys(docStore.getState().doc.levels)[0]
    let hint = ''
    const ctx = {
      doc: () => docStore.getState().doc,
      levelId: () => lv,
      ui: () => uiStore.getState(),
      mm: (n: number) => n * 10,
      setHint: (h: string) => void (hint = h),
      setCursor: () => {},
      requestRender: () => {},
    }
    const tool = createPencilTool(ctx as never)
    tool.activate?.()
    expect(hint).toBe(MARK_HINT)
    const ev = (p: Vec2) => ({ button: 0, plan: p, client: { x: 0, y: 0 } }) as never
    const focus0 = aiStore.getState().focusTick
    marksStore.getState().setShape('rect')
    tool.pointerDown?.(ev({ x: 0, y: 0 }))
    tool.pointerMove?.(ev({ x: 1000, y: 800 }))
    tool.pointerUp?.(ev({ x: 1000, y: 800 }))
    await new Promise((r) => setTimeout(r, 0))

    const marks = Object.values(docStore.getState().doc.annotations ?? {})
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ n: 1, shape: 'zone' })
    expect(marksStore.getState().selected).toBe(marks[0].id)
    const chip = aiStore.getState().chips.find((c) => c.id === marks[0].id)
    expect(chip).toMatchObject({ kind: 'annotation', label: 'Пометка ①' })
    expect(aiStore.getState().focusTick).toBe(focus0 + 1)

    // Delete removes the selected mark (the canvas has the keyboard again)
    expect(tool.keyDown?.({ key: 'Delete' } as never)).toBe(true)
    expect(docStore.getState().doc.annotations).toBeUndefined()
  })
})
