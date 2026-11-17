import { describe, expect, it } from 'vitest'
import { cleanIpcError, stripIpcPrefix } from './ipcError'

describe('errors from the main process', () => {
  it('lose the IPC prefix, keeping the message as main wrote it', () => {
    expect(stripIpcPrefix("Error invoking remote method 'project:open': Error: «plan.json» в папке проекта — ссылка")).toBe('«plan.json» в папке проекта — ссылка')
    expect(stripIpcPrefix("Error invoking remote method 'project:save': TypeError: x is not a function")).toBe('x is not a function')
    expect(stripIpcPrefix("Error invoking remote method 'ai:run': no prefix of a type")).toBe('no prefix of a type')
    // a message without the prefix, or one that only mentions it later, stays as it is
    expect(stripIpcPrefix('Файл повреждён: Error: x')).toBe('Файл повреждён: Error: x')
    expect(stripIpcPrefix("see Error invoking remote method 'a': Error: b")).toBe("see Error invoking remote method 'a': Error: b")
  })

  it('are rethrown as a plain Error with the clean message; anything else passes through', () => {
    const e = cleanIpcError(new Error("Error invoking remote method 'project:open': Error: В папке нет plan.json"))
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).message).toBe('В папке нет plan.json')
    const plain = new Error('plain')
    expect(cleanIpcError(plain)).toBe(plain)
    expect(cleanIpcError('text')).toBe('text')
  })
})
