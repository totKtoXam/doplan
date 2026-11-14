import { describe, expect, it } from 'vitest'
import { pathTracingDone } from './ui'

describe('pathTracingDone', () => {
  it('is true only for an active session that reached its target', () => {
    expect(pathTracingDone({ active: true, samples: 256, target: 256 })).toBe(true)
    expect(pathTracingDone({ active: true, samples: 255, target: 256 })).toBe(false)
    expect(pathTracingDone({ active: false, samples: 256, target: 256 })).toBe(false)
    expect(pathTracingDone({ active: true, samples: 0, target: 0 })).toBe(false)
  })
})

describe('door preset of the opening tool', () => {
  const barn = { id: 'barn', kind: 'slidingDoor' as const, patch: { slide: 'barn' as const, width: 800 } }
  const pick = async () => {
    const { uiStore } = await import('./ui')
    uiStore.getState().set({ tool: 'door', openingKind: 'slidingDoor', openingPreset: barn })
    return uiStore
  }

  it('is dropped when the tool changes', async () => {
    const ui = await pick()
    expect(ui.getState().openingPreset).toBe(barn)
    ui.getState().setTool('wall')
    expect(ui.getState().openingPreset).toBeNull()
  })

  it('is dropped when the opening kind changes', async () => {
    const ui = await pick()
    ui.getState().set({ openingKind: 'door' })
    expect(ui.getState().openingPreset).toBeNull()
    ui.getState().set({ openingKind: 'slidingDoor' })
    expect(ui.getState().openingPreset).toBeNull()
  })
})
