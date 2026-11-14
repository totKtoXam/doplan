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
