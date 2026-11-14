/**
 * Entry of the lazily loaded 3D chunk: `const { createEngine3D } = await import('@/view3d')`.
 */
import type { CreateEngine3D } from '@/contracts'
import { createEngine } from './engine'

export const createEngine3D: CreateEngine3D = (container) => createEngine(container)

export type { MaterialLibraryEx, PlainSpec } from './materials'
