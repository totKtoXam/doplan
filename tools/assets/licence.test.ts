import { describe, expect, it } from 'vitest'
import { khronosCredits, parseLicence } from './licence'

describe('manifest licence strings', () => {
  it('reads a single licence with its authors', () => {
    expect(parseLicence('CC-BY-4.0 (Wayfair, LLC / Eric Chadwick)')).toEqual({ licence: 'CC-BY-4.0', author: 'Wayfair, LLC / Eric Chadwick' })
    expect(parseLicence('CC0-1.0 (Wayfair / Eric Chadwick)')).toEqual({ licence: 'CC0', author: 'Wayfair / Eric Chadwick' })
    expect(parseLicence('CC-BY-4.0 (DGG / Eric Chadwick; Sean Thomas)')).toEqual({ licence: 'CC-BY-4.0', author: 'DGG / Eric Chadwick; Sean Thomas' })
  })

  it('reads a licence without authors', () => {
    expect(parseLicence('CC0-1.0')).toEqual({ licence: 'CC0' })
    expect(parseLicence('CC-BY-4.0')).toEqual({ licence: 'CC-BY-4.0' })
  })

  it('splits models whose parts have different licences, keeping the stricter one for the entry', () => {
    expect(parseLicence('CC-BY-4.0 (DGG / Eric Chadwick) + CC0 (Fran Calvente)')).toEqual({
      licence: 'CC-BY-4.0',
      author: 'DGG / Eric Chadwick; Fran Calvente (CC0)',
    })
    expect(parseLicence('CC0 (Rico Cilliers) + CC-BY-4.0 (DGG / Eric Chadwick)')).toEqual({
      licence: 'CC-BY-4.0',
      author: 'Rico Cilliers (CC0); DGG / Eric Chadwick',
    })
  })

  it('never leaves a stray bracket in the author', () => {
    for (const l of ['CC-BY-4.0 (DGG / Eric Chadwick) + CC0 (Rico Cilliers)', 'CC-BY-4.0 (DGG)']) {
      expect(parseLicence(l).author).not.toMatch(/^\)|\($|\) \+ /)
    }
  })
})

describe('Khronos credits', () => {
  it('lists CC-BY models with author and source page, skips CC0 ones', () => {
    const files = (dir: string) => ({ files: [{ url: `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${dir}/glTF-Binary/${dir}.glb` }] })
    expect(
      khronosCredits([
        { name: 'Sheen Chair', source: 'khronos-gltf-sample-assets', licence: 'CC0', author: 'Wayfair / Eric Chadwick', download: files('SheenChair') },
        { name: 'Lights Punctual Lamp', nameRu: 'Лампа', source: 'khronos-gltf-sample-assets', licence: 'CC-BY-4.0', author: 'DGG', download: files('LightsPunctualLamp') },
        { name: 'Other', source: 'polyhaven', licence: 'CC-BY-4.0' },
      ]),
    ).toEqual(['- Лампа: "Lights Punctual Lamp" by DGG, https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/LightsPunctualLamp, CC-BY-4.0'])
  })
})
