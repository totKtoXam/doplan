import { getApiKey } from './settings'
import { toBytes } from './fsutil'

const API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5-5'
const API_VERSION = '2026-10-21'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 15 * 60 * 1000
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * System prompt: stable text first so prompt caching can apply. Describes PlanSpec v1
 * (docs/research/photo-to-plan.md §4) and the accuracy playbook (§11).
 */
export const PLAN_EXTRACTION_SYSTEM = `You convert an image of an apartment floor plan (brochure plan, BTI plan, hand sketch, photo of a plan, CAD screenshot) into a PlanSpec v1 JSON document for the doplan floor-plan editor.

OUTPUT RULES
- Reply with ONE JSON object and nothing else: no prose, no markdown, no code fences, no comments.
- The object must follow the PlanSpec v1 schema below exactly. Omit optional fields you do not know; never invent fields.
- Use "units": "mm". Convert image measurements to millimetres yourself (see CALIBRATION).
- Coordinates: x grows to the RIGHT, y grows DOWN (image convention). Put the origin (0,0) at the top-left inner corner of the apartment's outer walls, so most coordinates are positive.
- Points are [x, y] arrays of two numbers. Rectangles are [x, y, w, h] where (x, y) is the top-left corner.

PLANSPEC V1 SCHEMA (TypeScript notation, "?" = optional)
type Pt = [number, number]
type WallKind = "exterior" | "loadBearing" | "partition" | "parapet" | "railing" | "glass" | "separator"   // separator = zero-thickness divider of open-plan spaces
type RoomType = "living" | "bedroom" | "kids" | "study" | "kitchen" | "kitchenLiving" | "dining" | "hall" | "corridor" | "bathroom" | "toilet" | "combinedBathroom" | "laundry" | "wardrobe" | "storage" | "balcony" | "loggia" | "terrace" | "utility" | "other"
type OpeningType = "door" | "doubleDoor" | "opening" | "frenchWindow" | "slidingDoor" | "pocketDoor" | "foldingDoor" | "entranceDoor" | "balconyDoor" | "balconyBlock" | "arch" | "passage" | "window" | "panoramicWindow"
type FixtureType = "column" | "riser" | "ventShaft" | "chimney" | "radiator" | "bathtub" | "shower" | "toilet" | "washbasin" | "kitchenSink" | "stove" | "fridge" | "washer" | "boiler" | "electricPanel"
interface PlanSpec {
  version: 1
  units: "mm"
  name?: string                         // e.g. "2-комн. квартира 57,4 м²"
  source?: {
    image: string                       // use "input"
    size: [number, number]              // image width, height in px
    kind: "brochure" | "bti" | "sketch" | "photo" | "screenshot" | "cad" | "other"
    mmPerPx?: number                    // your scale estimate
    originPx?: Pt                       // pixel position of mm (0,0)
    labelledTotalArea?: number          // m², as printed
    labelledLivingArea?: number
    toScale?: boolean                   // false for sketches / marketing plans
  }
  defaults?: { ceilingHeight?: number; exteriorThickness?: number; loadBearingThickness?: number; partitionThickness?: number; doorHeight?: number; windowSill?: number; windowHeight?: number }
  snap?: { orthogonal?: boolean; orthoToleranceDeg?: number; gridMm?: number; mergeMm?: number }
  walls?: { id: string; path: Pt[]; closed?: boolean; align?: "center" | "inner" | "outer"; thickness?: number; kind?: WallKind; height?: number; confidence?: number }[]
  rooms: {
    id: string                          // short slug referenced by openings: "kitchen", "bed1"
    name: string                        // as printed on the plan, e.g. "Кухня-гостиная"
    type: RoomType
    number?: string
    rect?: [number, number, number, number]   // CLEAR INTERIOR rectangle (wall faces, not centre-lines)
    polygon?: Pt[]                      // clear interior outline for non-rectangular rooms
    at?: Pt                             // label point inside the room (walls-mode)
    labelledArea?: number               // m² as printed ("17,94" → 17.94)
    ceilingHeight?: number
    edgeWall?: { kind: WallKind; thickness?: number; height?: number }   // for edges NOT facing another room (balcony railing, glazed loggia)
    confidence?: number                 // 0..1
  }[]
  openings: {
    id?: string
    type: OpeningType
    at?: Pt                             // centre of the opening on the wall
    wall?: string; offset?: number      // alternative to "at": wall id + distance from the wall path start to the opening centre
    width: number                       // clear width
    height?: number
    sill?: number                       // windows: floor to sill
    between?: [string, string]          // [roomId, roomId | "outside"]
    opensInto?: string                  // roomId or "outside" (swing side)
    hinge?: "left" | "right"            // hinge side seen from the room the door opens INTO, facing the door
    confidence?: number
  }[]
  fixtures?: { type: FixtureType; rect?: [number, number, number, number]; at?: Pt; rotation?: number }[]
  notes?: string[]                      // uncertainties the user must confirm, in Russian
}

AUTHORING MODE
- Prefer ROOMS-MODE: give every room as its clear interior "rect" (or "polygon"). Leave a GAP between neighbouring rooms equal to the wall thickness between them; the compiler turns gaps into walls (gap 80-120 → partition, ≥160 → load-bearing, next to balcony/loggia → exterior). Edges with no neighbour get exterior walls automatically (use "defaults.exteriorThickness").
- Use WALLS-MODE ("walls" + rooms with "at") only for clearly irregular geometry (diagonal or curved walls). If "walls" is present it is authoritative.
- Balconies/loggias are rooms of type "balcony"/"loggia" with "edgeWall" (e.g. railing 100 mm, height 1100, or glass).
- Place every opening with "at" = its centre point lying on the wall between the two rooms (in the middle of the gap). Fill "between" and, for doors, "opensInto" and "hinge" from the door-swing arc.

CALIBRATION AND ACCURACY
1. Read all text first: room names, room numbers, areas (m²), printed dimensions (mm or m, "3,25" means 3.25 m = 3250 mm), ceiling height, total/living area.
2. Derive the scale (mm per pixel) from at least two long printed dimensions, in both axes if possible; cross-check with labelled room areas. If the plan is not to scale (disagreement > 3 %), trust printed numbers over pixels and set source.toScale = false.
3. Snap to an orthogonal layout and a 10 mm grid; use standard thicknesses (partitions 80-120, load-bearing 160-250, exterior 300-640 mm).
4. Priors (sanity checks only): ceiling 2500-3000; doors: WC/bath 600-700, rooms 800, entrance 860-960; window sill 800-900, window height ~1500; balcony depth 900-1500.
5. Zoom mentally on every opening: door arcs and window triple-lines are small; count windows per room carefully.
6. Do not fabricate. Record every uncertain dimension, assumed thickness or unreadable label in "notes" (Russian) and lower "confidence" on the affected items.
7. Computed room areas (rect w × h / 1e6) should match labelled areas within ~3 %; adjust room sizes to the printed dimensions and areas.

Return only the JSON object.`

function readU32BE(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
}

/** Image size from PNG/JPEG/GIF/WebP headers (null if unknown). */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: readU32BE(b, 16), h: readU32BE(b, 20) }
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) }
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (chunk === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
    if (chunk === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++
        continue
      }
      const marker = b[o + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2
        continue
      }
      const len = (b[o + 2] << 8) | b[o + 3]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: (b[o + 5] << 8) | b[o + 6], w: (b[o + 7] << 8) | b[o + 8] }
      }
      o += 2 + len
    }
  }
  return null
}

/** Extracts the first complete top-level JSON object from model text. */
export function extractJsonObject(text: string): unknown {
  let t = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  if (start < 0) throw new Error('Ответ модели не содержит JSON')
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return JSON.parse(t.slice(start, i + 1))
    }
  }
  throw new Error('Ответ модели содержит неполный JSON')
}

interface ApiResponse {
  stop_reason?: string | null
  stop_details?: { category?: string | null; explanation?: string | null } | null
  content?: { type: string; text?: string }[]
  error?: { type?: string; message?: string }
}

export async function planFromImage(imageArg: unknown, mimeArg: unknown, hintArg?: unknown): Promise<string> {
  const key = await getApiKey()
  if (!key) throw new Error('Не задан API-ключ Anthropic. Укажите его в настройках (раздел «ИИ»).')
  const bytes = toBytes(imageArg)
  if (!bytes.length) throw new Error('Пустое изображение')
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Изображение больше 5 МБ. Уменьшите его (например, до 2000 px по длинной стороне) и повторите.')
  }
  const mime = typeof mimeArg === 'string' ? mimeArg.toLowerCase() : ''
  if (!ALLOWED_MIME.has(mime)) throw new Error('Поддерживаются изображения PNG, JPEG, WebP и GIF')
  const hint = typeof hintArg === 'string' ? hintArg.trim().slice(0, 4000) : ''
  const size = imageSize(bytes)

  const userText = [
    size ? `Image size: ${size.w} x ${size.h} px.` : 'Image size: unknown.',
    hint ? `User hint (may contain dimensions, plan kind or corrections): ${hint}` : '',
    'Return the PlanSpec v1 JSON object for this plan.',
  ]
    .filter(Boolean)
    .join('\n')

  const body = {
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'high' },
    fallbacks: 'default',
    system: [{ type: 'text', text: PLAN_EXTRACTION_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: Buffer.from(bytes).toString('base64') } },
          { type: 'text', text: userText },
        ],
      },
    ],
  }

  let res: Response
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'user-agent': 'doplan/0.1',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    const e = err as Error
    if (e.name === 'TimeoutError') throw new Error('Превышено время ожидания ответа Anthropic API')
    throw new Error(`Нет связи с Anthropic API: ${e.message}`)
  }

  let json: ApiResponse
  try {
    json = (await res.json()) as ApiResponse
  } catch {
    throw new Error(`Anthropic API вернул некорректный ответ (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const msg = json.error?.message ?? res.statusText
    if (res.status === 401) throw new Error('Неверный API-ключ Anthropic')
    if (res.status === 403) throw new Error(`Доступ запрещён: ${msg}`)
    if (res.status === 429) throw new Error('Превышен лимит запросов Anthropic API, попробуйте позже')
    if (res.status === 529 || res.status >= 500) throw new Error(`Сервис Anthropic перегружен или недоступен (${res.status}), попробуйте позже`)
    throw new Error(`Ошибка Anthropic API (${res.status}): ${msg}`)
  }
  if (json.stop_reason === 'refusal') {
    const why = json.stop_details?.explanation ? `: ${json.stop_details.explanation}` : ''
    throw new Error(`Модель отказалась обрабатывать изображение${why}`)
  }
  if (json.stop_reason === 'max_tokens') {
    throw new Error('Ответ модели оборвался (превышен лимит длины). Попробуйте обрезать изображение до одной квартиры.')
  }
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
  if (!text.trim()) throw new Error('Модель вернула пустой ответ')
  const parsed = extractJsonObject(text)
  return JSON.stringify(parsed, null, 2)
}
