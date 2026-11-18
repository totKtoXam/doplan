import { describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { toolAfterEscape } from '@/store/viewOnly'
import { lockViewerTool } from './guard'

describe('view-only 2D plan', () => {
  it('Esc keeps the Pan tool in the viewer, and goes back to Select in the editor', () => {
    expect(toolAfterEscape('pan', true)).toBeNull()
    expect(toolAfterEscape('select', true)).toBeNull()
    expect(toolAfterEscape('pan', false)).toBe('select')
    expect(toolAfterEscape('wall', false)).toBe('select')
    expect(toolAfterEscape('select', false)).toBeNull()
  })

  it('the viewer stays on Pan with nothing selected, whatever switches the tool', () => {
    const store = createStore<{ tool: string; selection: string[] }>(() => ({ tool: 'select', selection: ['room1'] }))
    const stop = lockViewerTool(store)
    expect(store.getState()).toEqual({ tool: 'pan', selection: [] })
    store.setState({ tool: 'select' })
    expect(store.getState().tool).toBe('pan')
    store.setState({ selection: ['room1'] })
    expect(store.getState().selection).toEqual([])
    stop()
    store.setState({ tool: 'select' })
    expect(store.getState().tool).toBe('select')
  })
})
