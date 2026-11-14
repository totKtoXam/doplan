import { describe, expect, it } from 'vitest'
import { shortcutKey } from './keys'

describe('shortcutKey', () => {
  it('maps letters by physical key on a Russian layout', () => {
    expect(shortcutKey({ key: 'я', code: 'KeyZ' })).toBe('z')
    expect(shortcutKey({ key: 'Я', code: 'KeyZ' })).toBe('z')
    expect(shortcutKey({ key: 'н', code: 'KeyY' })).toBe('y')
    expect(shortcutKey({ key: 'ц', code: 'KeyW' })).toBe('w')
  })
  it('keeps Latin letters and digits', () => {
    expect(shortcutKey({ key: 'Z', code: 'KeyZ' })).toBe('z')
    expect(shortcutKey({ key: '"', code: 'Digit2' })).toBe('2')
    expect(shortcutKey({ key: '3', code: 'Numpad3' })).toBe('3')
  })
  it('falls back to key for non-alphanumeric keys', () => {
    expect(shortcutKey({ key: 'Delete', code: 'Delete' })).toBe('delete')
    expect(shortcutKey({ key: '+', code: 'Equal' })).toBe('+')
    expect(shortcutKey({ key: 'z', code: '' })).toBe('z')
  })
})
