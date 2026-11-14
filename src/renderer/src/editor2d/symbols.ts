/**
 * Simple top-view sketches of furniture / equipment, drawn inside the item footprint.
 * Local frame: x ∈ [-w/2, w/2], y ∈ [-d/2, d/2]; the back of the item is at -y, the front at +y.
 */
import type { Asset, AssetCategory } from '@core/types'

export interface Sketch {
  line(x1: number, y1: number, x2: number, y2: number): void
  rect(x: number, y: number, w: number, h: number): void
  ellipse(cx: number, cy: number, rx: number, ry: number): void
}

const CATEGORY_KIND: Record<AssetCategory, string> = {
  sofa: 'sofa',
  armchair: 'armchair',
  chair: 'chair',
  table: 'table',
  bed: 'bed',
  storage: 'wardrobe',
  kitchen: 'kitchenBase',
  appliance: 'appliance',
  bathroom: 'washbasin',
  lighting: 'lamp',
  decor: 'box',
  plant: 'plantPot',
  textile: 'rug',
  electronics: 'tv',
  outdoor: 'box',
  kids: 'box',
  office: 'table',
  structure: 'column',
  other: 'box',
}

export function sketchKind(asset: Asset | undefined): string {
  if (!asset) return 'unknown'
  return asset.procedural ?? CATEGORY_KIND[asset.category] ?? 'box'
}

export function drawItemSketch(kind: string, w: number, d: number, sk: Sketch): void {
  const hw = w / 2
  const hd = d / 2
  const m = Math.min(w, d)
  switch (kind) {
    case 'sofa':
    case 'armchair': {
      const back = Math.min(d * 0.28, 260)
      const arm = Math.min(w * 0.14, 220)
      sk.line(-hw, -hd + back, hw, -hd + back)
      sk.line(-hw + arm, -hd + back, -hw + arm, hd)
      sk.line(hw - arm, -hd + back, hw - arm, hd)
      const inner = w - arm * 2
      const n = kind === 'armchair' ? 1 : Math.max(1, Math.round(inner / 750))
      for (let i = 1; i < n; i++) {
        const x = -hw + arm + (inner * i) / n
        sk.line(x, -hd + back, x, hd)
      }
      break
    }
    case 'chair': {
      const back = Math.min(d * 0.18, 90)
      sk.line(-hw, -hd + back, hw, -hd + back)
      sk.rect(-hw + w * 0.08, -hd + back + d * 0.06, w * 0.84, d - back - d * 0.12)
      break
    }
    case 'table': {
      const inset = Math.min(60, m * 0.08)
      sk.rect(-hw + inset, -hd + inset, w - inset * 2, d - inset * 2)
      break
    }
    case 'bed': {
      const head = Math.min(80, d * 0.05)
      sk.line(-hw, -hd + head, hw, -hd + head)
      const pillowD = Math.min(420, d * 0.2)
      const n = w >= 1300 ? 2 : 1
      const gap = Math.min(80, w * 0.05)
      const pw = (w - gap * (n + 1)) / n
      for (let i = 0; i < n; i++) {
        sk.rect(-hw + gap + i * (pw + gap), -hd + head + gap, pw, pillowD)
      }
      const fold = -hd + head + gap + pillowD + Math.min(160, d * 0.08)
      sk.line(-hw, fold, hw, fold)
      sk.line(hw - Math.min(w * 0.3, 450), fold, hw, fold + Math.min(d * 0.2, 400))
      break
    }
    case 'wardrobe':
    case 'kitchenTall':
    case 'fridge': {
      sk.line(-hw, -hd, hw, hd)
      sk.line(-hw, hd, hw, -hd)
      if (kind === 'fridge') sk.line(-hw, hd - Math.min(60, d * 0.1), hw, hd - Math.min(60, d * 0.1))
      break
    }
    case 'shelf': {
      sk.line(-hw, -hd, hw, hd)
      break
    }
    case 'kitchenBase':
    case 'worktop': {
      const front = Math.min(40, d * 0.08)
      sk.line(-hw, hd - front, hw, hd - front)
      break
    }
    case 'kitchenWall': {
      sk.line(-hw, -hd, hw, hd)
      break
    }
    case 'stove': {
      const r = Math.min(w, d) * 0.16
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) sk.ellipse(sx * w * 0.24, sy * d * 0.24, r, r)
      }
      break
    }
    case 'oven':
    case 'dishwasher':
    case 'appliance': {
      const inset = m * 0.12
      sk.rect(-hw + inset, -hd + inset, w - inset * 2, d - inset * 2)
      sk.line(-hw + inset, hd - inset * 1.8, hw - inset, hd - inset * 1.8)
      break
    }
    case 'hood': {
      sk.line(-hw, hd, -hw * 0.45, -hd)
      sk.line(hw, hd, hw * 0.45, -hd)
      break
    }
    case 'washingMachine': {
      const r = m * 0.3
      sk.ellipse(0, 0, r, r)
      sk.ellipse(0, 0, r * 0.6, r * 0.6)
      break
    }
    case 'tv': {
      const t = Math.min(d * 0.35, 60)
      sk.line(-hw, -hd + t, hw, -hd + t)
      sk.line(-hw * 0.3, -hd + t, -hw * 0.45, hd)
      sk.line(hw * 0.3, -hd + t, hw * 0.45, hd)
      break
    }
    case 'sink': {
      const inset = m * 0.12
      sk.rect(-hw + inset, -hd + inset * 1.6, w - inset * 2, d - inset * 2.6)
      sk.ellipse(0, -hd + inset * 0.8, inset * 0.35, inset * 0.35)
      sk.ellipse(0, 0, m * 0.05, m * 0.05)
      break
    }
    case 'toilet': {
      const tank = d * 0.27
      sk.rect(-hw * 0.95, -hd, w * 0.95, tank)
      sk.ellipse(0, -hd + tank + (d - tank) / 2, hw * 0.82, (d - tank) / 2)
      sk.ellipse(0, -hd + tank + (d - tank) * 0.55, hw * 0.5, (d - tank) * 0.3)
      break
    }
    case 'bathtub': {
      const inset = Math.min(70, m * 0.1)
      // oval inner basin + drain at one end
      sk.ellipse(0, 0, hw - inset, hd - inset)
      if (w >= d) sk.ellipse(-hw + inset * 2.4, 0, 30, 30)
      else sk.ellipse(0, -hd + inset * 2.4, 30, 30)
      break
    }
    case 'shower': {
      sk.line(-hw, -hd, hw, hd)
      sk.line(-hw, hd, hw, -hd)
      sk.ellipse(0, 0, 45, 45)
      break
    }
    case 'washbasin': {
      sk.ellipse(0, d * 0.06, hw * 0.78, hd * 0.7)
      sk.ellipse(0, -hd + d * 0.12, m * 0.04, m * 0.04)
      break
    }
    case 'radiator': {
      const n = Math.max(2, Math.min(40, Math.round(w / 80)))
      for (let i = 1; i < n; i++) {
        const x = -hw + (w * i) / n
        sk.line(x, -hd, x, hd)
      }
      break
    }
    case 'rug': {
      const inset = Math.min(120, m * 0.08)
      sk.rect(-hw + inset, -hd + inset, w - inset * 2, d - inset * 2)
      break
    }
    case 'mirror':
    case 'picture': {
      sk.line(-hw, 0, hw, 0)
      break
    }
    case 'column': {
      sk.line(-hw, -hd, hw, hd)
      sk.line(-hw, hd, hw, -hd)
      break
    }
    case 'stairs': {
      const n = Math.max(3, Math.min(40, Math.round(d / 270)))
      for (let i = 1; i < n; i++) {
        const y = -hd + (d * i) / n
        sk.line(-hw, y, hw, y)
      }
      // arrow pointing up the flight (towards the back)
      sk.line(0, hd - d * 0.08, 0, -hd + d * 0.08)
      sk.line(0, -hd + d * 0.08, -w * 0.12, -hd + d * 0.08 + w * 0.14)
      sk.line(0, -hd + d * 0.08, w * 0.12, -hd + d * 0.08 + w * 0.14)
      break
    }
    case 'airConditioner': {
      sk.line(-hw, 0, hw, 0)
      sk.line(-hw * 0.8, hd * 0.5, hw * 0.8, hd * 0.5)
      break
    }
    case 'plantPot': {
      const r = m * 0.3
      sk.ellipse(0, 0, r, r)
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3
        sk.line(0, 0, Math.cos(a) * m * 0.48, Math.sin(a) * m * 0.48)
      }
      break
    }
    case 'lamp': {
      const r = m * 0.42
      sk.ellipse(0, 0, r, r)
      sk.line(-r * 0.7, -r * 0.7, r * 0.7, r * 0.7)
      sk.line(-r * 0.7, r * 0.7, r * 0.7, -r * 0.7)
      break
    }
    case 'unknown': {
      sk.line(-hw, -hd, hw, hd)
      break
    }
    default: {
      // generic box: a small tick marking the front edge
      const t = Math.min(80, d * 0.15)
      sk.line(-w * 0.12, hd - t, 0, hd)
      sk.line(w * 0.12, hd - t, 0, hd)
      break
    }
  }
}

/** Sketch backend that transforms local coordinates and collects flat line segments. */
export class SegmentSketch implements Sketch {
  cx = 0
  cy = 0
  cos = 1
  sin = 0
  mirror = 1

  constructor(public out: number[]) {}

  setTransform(cx: number, cy: number, rotationRad: number, mirrored: boolean): void {
    this.cx = cx
    this.cy = cy
    this.cos = Math.cos(rotationRad)
    this.sin = Math.sin(rotationRad)
    this.mirror = mirrored ? -1 : 1
  }

  private px(x: number, y: number): number {
    return this.cx + x * this.mirror * this.cos - y * this.sin
  }

  private py(x: number, y: number): number {
    return this.cy + x * this.mirror * this.sin + y * this.cos
  }

  line(x1: number, y1: number, x2: number, y2: number): void {
    this.out.push(this.px(x1, y1), this.py(x1, y1), this.px(x2, y2), this.py(x2, y2))
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.line(x, y, x + w, y)
    this.line(x + w, y, x + w, y + h)
    this.line(x + w, y + h, x, y + h)
    this.line(x, y + h, x, y)
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): void {
    const n = 20
    let px = cx + rx
    let py = cy
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = cx + Math.cos(a) * rx
      const y = cy + Math.sin(a) * ry
      this.line(px, py, x, y)
      px = x
      py = y
    }
  }
}
