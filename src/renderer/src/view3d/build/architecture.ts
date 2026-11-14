/**
 * Keeps `roots.architecture` in sync with the document: walls, openings and rooms of the
 * active level. Every entity carries a content signature, so a commit only rebuilds what it
 * actually touched. Also owns the orbit-mode wall cut-away and ceiling auto-hide.
 */
import * as THREE from 'three'
import { defaultRoom } from '@core'
import type { DerivedPlan, DerivedRoom, Doc, EntityRef, Id, Opening, RenderSettings, Room, Wall } from '@core/types'
import type { ProceduralFactory } from '@/contracts'
import type { MaterialLibraryEx } from '../materials'
import { buildOpening } from './openings'
import { type RoomBuild, buildRoom } from './rooms'
import { MM, disposeGeometries } from './util'
import { type WallInput, buildWall } from './walls'

/** height walls are lowered to in cut-away mode, mm */
const CUT_HEIGHT = 1000

interface WallRec {
  sig: string
  group: THREE.Group
  full: THREE.Group
  low: THREE.Group | null
  lowered: boolean
  input: WallInput
  mid: THREE.Vector3
  /** left normal in world space */
  nl: THREE.Vector3
  hasLeft: boolean
  hasRight: boolean
}

interface OpeningRec {
  sig: string
  group: THREE.Group
  wallId: Id
}

interface RoomRec {
  sig: string
  build: RoomBuild
}

export interface ArchSyncInput {
  doc: Doc
  plan: DerivedPlan | undefined
  levelId: Id
  /** changes whenever cached materials became stale → forces a full rebuild */
  epoch: number
}

const r1 = (_k: string, v: unknown): unknown => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)

export class Architecture {
  private walls = new Map<Id, WallRec>()
  private openings = new Map<Id, OpeningRec>()
  private rooms = new Map<Id, RoomRec>()
  private autoRooms = new Map<Id, Room>()
  private exportMode = false

  constructor(
    private readonly root: THREE.Group,
    private readonly lib: MaterialLibraryEx,
    private readonly factory: ProceduralFactory,
  ) {}

  /** returns true when the scene graph changed */
  sync(input: ArchSyncInput): boolean {
    const { doc, plan, levelId, epoch } = input
    let changed = false
    const level = doc.levels[levelId]
    if (!plan || !level) {
      if (this.walls.size || this.openings.size || this.rooms.size) changed = true
      this.clear()
      return changed
    }

    const walls: Wall[] = []
    for (const id in doc.walls) if (doc.walls[id].levelId === levelId) walls.push(doc.walls[id])
    const openingsByWall = new Map<Id, Opening[]>()
    for (const id in doc.openings) {
      const o = doc.openings[id]
      const w = doc.walls[o.wallId]
      if (!w || w.levelId !== levelId) continue
      let list = openingsByWall.get(o.wallId)
      if (!list) openingsByWall.set(o.wallId, (list = []))
      list.push(o)
    }
    for (const list of openingsByWall.values()) list.sort((p, q) => p.offset - q.offset)

    // which room lies on which side of every wall
    const adjacent = new Map<Id, { left?: DerivedRoom; right?: DerivedRoom }>()
    for (const room of plan.rooms) {
      for (const e of room.edges) {
        let a = adjacent.get(e.wallId)
        if (!a) adjacent.set(e.wallId, (a = {}))
        a[e.side] = room
      }
    }
    const recOf = (room: DerivedRoom): Room => {
      const rec = doc.rooms[room.roomId]
      if (rec) return rec
      let auto = this.autoRooms.get(room.roomId)
      if (!auto) {
        auto = { ...defaultRoom(levelId, room.labelPoint), id: room.roomId }
        this.autoRooms.set(room.roomId, auto)
      }
      return auto
    }
    const ceilingOf = (room: DerivedRoom): number => {
      const rec = recOf(room)
      if (rec.ceiling.height && rec.ceiling.height > 0) return rec.ceiling.height
      let h = Infinity
      for (const e of room.edges) {
        const w = doc.walls[e.wallId]
        if (w && (w.kind === 'wall' || w.kind === 'partition')) h = Math.min(h, w.height)
      }
      return Number.isFinite(h) ? h : level.height
    }

    // ── walls ──
    const seenWalls = new Set<Id>()
    for (const wall of walls) {
      const geom = plan.wallGeoms[wall.id]
      if (!geom) continue
      seenWalls.add(wall.id)
      const ops = openingsByWall.get(wall.id) ?? []
      const adj = adjacent.get(wall.id) ?? {}
      const floorRoom = adj.left ?? adj.right
      const threshold = floorRoom ? recOf(floorRoom).floor : null
      const sig = JSON.stringify([epoch, wall, geom.polygon, geom.left, geom.right, geom.a, geom.b, ops, threshold], r1)
      const old = this.walls.get(wall.id)
      if (old && old.sig === sig) {
        old.hasLeft = !!adj.left
        old.hasRight = !!adj.right
        continue
      }
      const wallInput: WallInput = { wall, geom, openings: ops, heightMm: wall.height, lowered: false, threshold }
      const group = new THREE.Group()
      group.name = `wall-set:${wall.id}`
      group.userData.ref = { kind: 'wall', id: wall.id } satisfies EntityRef
      const full = buildWall(wallInput, this.lib)
      group.add(full)
      const L = geom.length || 1
      const dx = (geom.b.x - geom.a.x) / L
      const dy = (geom.b.y - geom.a.y) / L
      const rec: WallRec = {
        sig,
        group,
        full,
        low: null,
        lowered: false,
        input: wallInput,
        mid: new THREE.Vector3(((geom.a.x + geom.b.x) / 2) * MM, 0, ((geom.a.y + geom.b.y) / 2) * MM),
        nl: new THREE.Vector3(dy, 0, -dx),
        hasLeft: !!adj.left,
        hasRight: !!adj.right,
      }
      if (old) {
        if (old.lowered && !this.exportMode) this.setLowered(rec, true)
        this.dropGroup(old.group)
      }
      this.walls.set(wall.id, rec)
      this.root.add(group)
      changed = true
    }
    for (const [id, rec] of Array.from(this.walls)) {
      if (seenWalls.has(id)) continue
      this.dropGroup(rec.group)
      this.walls.delete(id)
      changed = true
    }

    // ── openings ──
    const seenOpenings = new Set<Id>()
    for (const [wallId, ops] of openingsByWall) {
      const wall = doc.walls[wallId]
      const geom = plan.wallGeoms[wallId]
      if (!wall || !geom || wall.kind === 'virtual') continue
      const adj = adjacent.get(wallId) ?? {}
      for (const o of ops) {
        seenOpenings.add(o.id)
        const interior: 'left' | 'right' = adj.left && !adj.right ? 'left' : adj.right && !adj.left ? 'right' : o.swing
        const curtainRoom = o.curtain ? adj[o.curtain.side] : undefined
        const ceilingMm = curtainRoom ? ceilingOf(curtainRoom) : wall.height
        const sig = JSON.stringify(
          [epoch, o, wall.thickness, wall.height, wall.kind, geom.a, geom.b, geom.left[0], geom.right[0], interior, ceilingMm],
          r1,
        )
        const old = this.openings.get(o.id)
        if (old && old.sig === sig) continue
        const group = buildOpening({ opening: o, wall, geom, interior, ceilingMm }, this.lib, this.factory)
        if (old) this.dropGroup(old.group)
        this.openings.set(o.id, { sig, group, wallId })
        this.root.add(group)
        changed = true
      }
    }
    for (const [id, rec] of Array.from(this.openings)) {
      if (seenOpenings.has(id)) continue
      this.dropGroup(rec.group)
      this.openings.delete(id)
      changed = true
    }

    // ── rooms ──
    const seenRooms = new Set<Id>()
    for (const room of plan.rooms) {
      seenRooms.add(room.roomId)
      const rec = recOf(room)
      const ceilingMm = ceilingOf(room)
      const edgeInfo = room.edges.map((e) => {
        const w = doc.walls[e.wallId]
        return [e, w?.kind, w?.height, openingsByWall.get(e.wallId) ?? null]
      })
      const sig = JSON.stringify([epoch, room.polygon, room.holes, rec, ceilingMm, edgeInfo], r1)
      const old = this.rooms.get(room.roomId)
      if (old && old.sig === sig) continue
      const build = buildRoom(
        { room, rec, ceilingMm, walls: doc.walls, wallGeoms: plan.wallGeoms, openingsByWall },
        this.lib,
      )
      if (old) {
        build.ceiling.visible = old.build.ceiling.visible
        this.dropGroup(old.build.group)
      }
      this.rooms.set(room.roomId, { sig, build })
      this.root.add(build.group)
      changed = true
    }
    for (const [id, rec] of Array.from(this.rooms)) {
      if (seenRooms.has(id)) continue
      this.dropGroup(rec.build.group)
      this.rooms.delete(id)
      this.autoRooms.delete(id)
      changed = true
    }

    if (changed) this.applyOpeningVisibility()
    return changed
  }

  private dropGroup(group: THREE.Object3D): void {
    group.removeFromParent()
    disposeGeometries(group)
  }

  private setLowered(rec: WallRec, lowered: boolean): void {
    if (lowered && !rec.low) {
      rec.low = buildWall(
        { ...rec.input, heightMm: Math.min(CUT_HEIGHT, rec.input.wall.height), lowered: true },
        this.lib,
      )
      rec.low.userData.lowered = true
      rec.group.add(rec.low)
    }
    rec.lowered = lowered
    rec.full.visible = !lowered
    if (rec.low) rec.low.visible = lowered
  }

  private applyOpeningVisibility(): void {
    for (const rec of this.openings.values()) {
      const wall = this.walls.get(rec.wallId)
      rec.group.visible = this.exportMode || !wall || !wall.lowered
    }
  }

  /**
   * Wall cut-away + ceiling visibility for the current camera. Returns true when anything
   * was shown / hidden.
   */
  updateVisibility(
    camera: THREE.Camera,
    mode: 'orbit' | 'walk' | 'top',
    render: RenderSettings,
    bounds: THREE.Box3,
  ): boolean {
    let changed = false
    const cam = camera.position
    const forward = camera.getWorldDirection(new THREE.Vector3())
    const cutaway = !this.exportMode && render.wallCutaway && mode === 'orbit' && forward.y > -0.96
    const outside =
      cam.x < bounds.min.x - 0.05 || cam.x > bounds.max.x + 0.05 || cam.z < bounds.min.z - 0.05 || cam.z > bounds.max.z + 0.05

    for (const rec of this.walls.values()) {
      let want = false
      const wall = rec.input.wall
      if (cutaway && wall.kind !== 'virtual' && wall.height > CUT_HEIGHT + 150) {
        const tx = cam.x - rec.mid.x
        const tz = cam.z - rec.mid.z
        const tl = Math.hypot(tx, tz)
        if (tl > 1e-4) {
          const d = (rec.nl.x * tx + rec.nl.z * tz) / tl
          if (rec.hasLeft !== rec.hasRight) {
            // exterior wall: the side without a room is the outside
            const out = rec.hasLeft ? -d : d
            want = out > (rec.lowered ? 0.02 : 0.12)
          } else if (rec.hasLeft && rec.hasRight) {
            // partition between two rooms: lower it when seen face-on from outside / above
            if (outside || cam.y > wall.height * MM) want = Math.abs(d) > (rec.lowered ? 0.3 : 0.42)
          }
        }
      }
      if (want !== rec.lowered) {
        this.setLowered(rec, want)
        changed = true
      }
    }
    if (changed) this.applyOpeningVisibility()

    for (const rec of this.rooms.values()) {
      const below = cam.y < rec.build.ceilingY - 0.02
      const visible = this.exportMode || (below && (render.ceilingVisible || mode === 'walk'))
      if (rec.build.ceiling.visible !== visible) {
        rec.build.ceiling.visible = visible
        changed = true
      }
    }
    return changed
  }

  /** export / still helpers: full-height walls and ceilings regardless of the camera */
  setExportMode(on: boolean): void {
    this.exportMode = on
    if (on) {
      for (const rec of this.walls.values()) if (rec.lowered) this.setLowered(rec, false)
      for (const rec of this.rooms.values()) rec.build.ceiling.visible = true
      this.applyOpeningVisibility()
    }
  }

  objectsFor(ref: EntityRef): THREE.Object3D[] {
    if (ref.kind === 'wall') {
      const rec = this.walls.get(ref.id)
      if (!rec) return []
      return [rec.lowered && rec.low ? rec.low : rec.full]
    }
    if (ref.kind === 'opening') {
      const rec = this.openings.get(ref.id)
      return rec && rec.group.visible ? [rec.group] : []
    }
    if (ref.kind === 'room') {
      const rec = this.rooms.get(ref.id)
      if (!rec) return []
      return [rec.build.floor ?? rec.build.group]
    }
    return []
  }

  /** highest wall top of the level, metres */
  maxHeight(): number {
    let h = 0
    for (const rec of this.walls.values()) h = Math.max(h, rec.input.wall.height * MM)
    return h
  }

  clear(): void {
    for (const rec of this.walls.values()) this.dropGroup(rec.group)
    for (const rec of this.openings.values()) this.dropGroup(rec.group)
    for (const rec of this.rooms.values()) this.dropGroup(rec.build.group)
    this.walls.clear()
    this.openings.clear()
    this.rooms.clear()
    this.autoRooms.clear()
  }
}
