/**
 * Picking for the published viewer, which has no editing interaction: what is under a screen point
 * (the plan object and the exact surface point) and the point snapped to a vertex or an edge of the
 * hit face, for the measure tool. Also projects world points back to the screen for overlays.
 *
 * Coordinates: world metres (x = plan x / 1000, z = plan y / 1000, y up).
 */
import * as THREE from 'three'
import type { EngineContext, EntityPick } from '@/contracts'
import type { EntityKind, EntityRef } from '@core/types'
import { layerIndex } from '@core/layers'
import { docStore } from '@/store/document'

const KINDS: ReadonlySet<string> = new Set<EntityKind>(['wall', 'opening', 'room', 'item', 'light', 'electric'])
const ROOTS = ['items', 'lights', 'electrical', 'architecture'] as const

/** screen distance (CSS px) within which a vertex / an edge catches the cursor */
const VERTEX_PX = 14
const EDGE_PX = 10

export interface ViewerPick {
  pick(clientX: number, clientY: number): EntityPick | null
  project(p: readonly [number, number, number]): [number, number] | null
}

export function createViewerPick(ctx: EngineContext): ViewerPick {
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const tmp = new THREE.Vector3()
  const hits: THREE.Intersection[] = []

  const collect = (o: THREE.Object3D): void => {
    if (!o.visible || o.userData?.noPick === true) return
    if (o.layers.test(raycaster.layers)) o.raycast(raycaster, hits)
    for (const c of o.children) collect(c)
  }

  const rect = () => ctx.canvas.getBoundingClientRect()

  function toClient(p: THREE.Vector3, r: DOMRect): [number, number] | null {
    tmp.copy(p).project(ctx.camera)
    if (tmp.z < -1 || tmp.z > 1) return null
    return [r.left + ((tmp.x + 1) / 2) * r.width, r.top + ((1 - tmp.y) / 2) * r.height]
  }

  function refOf(hit: THREE.Intersection): { ref: EntityRef | null; surface?: string } {
    let surface: string | undefined
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
      const ud = o.userData
      if (surface === undefined && typeof ud?.surface === 'string') surface = ud.surface
      if (ud?.ref && typeof ud.ref.id === 'string' && KINDS.has(ud.ref.kind)) {
        const ref = { kind: ud.ref.kind as EntityKind, id: ud.ref.id as string }
        return { ref: layerIndex(docStore.getState().doc).pickable(ref.kind, ref.id) ? ref : null, surface }
      }
    }
    return { ref: null, surface }
  }

  /** the hit triangle's corners in world space */
  function triangle(hit: THREE.Intersection): THREE.Vector3[] | null {
    const mesh = hit.object as THREE.Mesh
    if (!hit.face || !(mesh as { isMesh?: boolean }).isMesh || !mesh.geometry?.attributes?.position) return null
    const out: THREE.Vector3[] = []
    const inst = new THREE.Matrix4()
    const instanced = hit.instanceId !== undefined && (mesh as THREE.InstancedMesh).isInstancedMesh
    if (instanced) (mesh as THREE.InstancedMesh).getMatrixAt(hit.instanceId as number, inst)
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const v = new THREE.Vector3()
      mesh.getVertexPosition(i, v)
      if (instanced) v.applyMatrix4(inst)
      out.push(v.applyMatrix4(mesh.matrixWorld))
    }
    return out
  }

  /** a quad's diagonal is not an edge of the object: the long side of a right triangle */
  function realEdges(t: THREE.Vector3[]): [THREE.Vector3, THREE.Vector3][] {
    const edges: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
      [t[0], t[1], t[2]],
      [t[1], t[2], t[0]],
      [t[2], t[0], t[1]],
    ]
    return edges
      .filter(([a, b, c]) => {
        const u = new THREE.Vector3().subVectors(a, c).normalize()
        const w = new THREE.Vector3().subVectors(b, c).normalize()
        return Math.abs(u.dot(w)) > 0.035 // the angle opposite this edge is not ~90°
      })
      .map(([a, b]) => [a, b])
  }

  function snap(hit: THREE.Intersection, cx: number, cy: number, r: DOMRect): Pick<EntityPick, 'point' | 'snap'> {
    const point = hit.point.clone()
    const tri = triangle(hit)
    if (!tri) return { point: [point.x, point.y, point.z], snap: 'face' }
    let best: THREE.Vector3 | null = null
    let bestD = VERTEX_PX
    for (const v of tri) {
      const s = toClient(v, r)
      const d = s ? Math.hypot(s[0] - cx, s[1] - cy) : Infinity
      if (d < bestD) {
        bestD = d
        best = v
      }
    }
    if (best) return { point: [best.x, best.y, best.z], snap: 'vertex' }
    bestD = EDGE_PX
    for (const [a, b] of realEdges(tri)) {
      const sa = toClient(a, r)
      const sb = toClient(b, r)
      if (!sa || !sb) continue
      const ex = sb[0] - sa[0]
      const ey = sb[1] - sa[1]
      const len2 = ex * ex + ey * ey
      if (len2 < 1) continue
      const t = Math.max(0, Math.min(1, ((cx - sa[0]) * ex + (cy - sa[1]) * ey) / len2))
      const d = Math.hypot(sa[0] + ex * t - cx, sa[1] + ey * t - cy)
      if (d < bestD) {
        bestD = d
        // the 3D point under the cursor on that edge: the closest point of the edge to the ray
        const ray = raycaster.ray
        const onEdge = new THREE.Vector3()
        ray.distanceSqToSegment(a, b, undefined, onEdge)
        best = onEdge
      }
    }
    if (best) return { point: [best.x, best.y, best.z], snap: 'edge' }
    return { point: [point.x, point.y, point.z], snap: 'face' }
  }

  return {
    pick(clientX, clientY) {
      const r = rect()
      if (r.width < 1 || r.height < 1) return null
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
      ctx.camera.updateMatrixWorld()
      raycaster.setFromCamera(ndc, ctx.camera)
      hits.length = 0
      for (const name of ROOTS) collect(ctx.roots[name])
      if (!hits.length) return null
      hits.sort((a, b) => a.distance - b.distance)
      const hit = hits[0]
      const { ref, surface } = refOf(hit)
      return { ref, surface, ...snap(hit, clientX, clientY, r) }
    },
    project(p) {
      return toClient(tmp.set(p[0], p[1], p[2]).clone(), rect())
    },
  }
}
