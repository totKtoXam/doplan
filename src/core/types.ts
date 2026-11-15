/**
 * doplan core document schema — THE shared contract. Pure data, JSON-serialisable.
 *
 * Units & axes (binding):
 *  - Plan coordinates: float millimetres, x → right, y → DOWN (screen-like).
 *  - Heights / elevations: millimetres above the level's floor.
 *  - Angles: degrees, clockwise on the plan (because y is down), 0 = +x.
 *  - 3D world: metres, Y-up. The ONLY conversion is `toWorld()` in core/geom.ts:
 *      toWorld(x, y, elev) = [x / 1000, elev / 1000, y / 1000]
 *  - Wall sides: looking from node `a` to node `b`, `left` is the side on the left hand
 *    (normal = rotate direction by -90° in y-down coords: (dy, -dx)), `right` is the other.
 */

export type Id = string

export interface Vec2 {
  x: number
  y: number
}

// ───────────────────────────── Layers (outliner) ─────────────────────────────

/**
 * Outliner state every plan object may carry (layers panel, see core/layers):
 * own visibility / lock, a user name and the user layer the object is on.
 * The effective state also depends on the kind's group flags (`Doc.groupFlags`) and the layer's flags.
 */
export interface LayerFlags {
  /** user name shown in the layers panel (absent = generated from the object) */
  name?: string
  /** hidden everywhere: 2D plan, 3D, exports */
  hidden?: boolean
  /** not pickable on the plan / in 3D, protected from delete */
  locked?: boolean
  /** user layer (`Doc.layers`) the object is on; absent = no layer */
  layerId?: Id
}

/** A flat user layer (like an AutoCAD layer / SketchUp tag): objects reference it by `layerId`. */
export interface UserLayer {
  id: Id
  name: string
  hidden?: boolean
  locked?: boolean
}

/** visibility / lock of a whole kind of objects (all walls, all furniture…) */
export interface GroupFlags {
  hidden?: boolean
  locked?: boolean
}

// ───────────────────────────── Levels ─────────────────────────────

export interface Level {
  id: Id
  name: string
  /** elevation of the floor surface above project zero, mm */
  elevation: number
  /** default wall height for new walls on this level, mm */
  height: number
  visible: boolean
}

// ───────────────────────────── Walls ─────────────────────────────

export interface PlanNode {
  id: Id
  levelId: Id
  x: number
  y: number
}

/** A horizontal band of finish on one wall face (e.g. tile apron 0–1200 mm). */
export interface FinishZone {
  /** mm above floor */
  from: number
  to: number
  materialId: Id
  /** laying pattern of the band (default: the material's own) */
  pattern?: TilePattern
  /** e.g. 'Фартук', 'Панель' (estimate / drawings) */
  label?: string
}

export interface WallSide {
  materialId: Id
  /** laying pattern of the face outside zones (default: the material's own) */
  pattern?: TilePattern
  /** optional bands overriding `materialId` between heights */
  zones?: FinishZone[]
}

export type WallKind = 'wall' | 'partition' | 'parapet' | 'glazing' | 'virtual'

/**
 * Where a dimension comes from (how far it can be trusted):
 *  - `plan`      printed on the source plan (BTI / developer), ±10 mm
 *  - `derived`   computed from a printed area or a chain of printed dimensions, ±20 mm
 *  - `estimated` measured in photo pixels (not printed), ±50 mm
 *  - `measured`  tape / laser measurement on site, with the date and tolerance
 *  - `drawn`     drawn by hand in the app (default; accuracy unknown)
 */
export type DimSource = 'plan' | 'derived' | 'estimated' | 'measured' | 'drawn'

/** Provenance of one dimension: the clear length of a wall face inside a room. */
export interface DimProvenance {
  source: DimSource
  /** ± mm; default per source (core/provenance DIM_SOURCE_TOL) */
  tol?: number
  /**
   * the clear face length (mm) this provenance was recorded for. When the geometry no longer matches
   * it (the wall was moved later) the provenance is stale and the dimension counts as `drawn`.
   */
  value?: number
  /** ISO date (YYYY-MM-DD) of a tape / laser measurement */
  date?: string
  note?: string
}

/** provenance of the clear face length on each side of a wall */
export interface WallDims {
  left?: DimProvenance
  right?: DimProvenance
}

export interface Wall extends LayerFlags {
  id: Id
  levelId: Id
  a: Id
  b: Id
  /** mm */
  thickness: number
  /** mm; parapets are low (e.g. 1000) */
  height: number
  /** `virtual` = room separator with no geometry; `glazing` = full-height balcony glazing */
  kind: WallKind
  left: WallSide
  right: WallSide
  /** provenance of the face lengths (absent = drawn in the app) */
  dims?: WallDims
}

export type OpeningKind =
  | 'door'
  | 'doubleDoor'
  | 'slidingDoor'
  | 'entranceDoor'
  | 'arch'
  | 'opening'
  | 'window'
  | 'frenchWindow'
  | 'balconyDoor'
  | 'balconyBlock'

export type CurtainKind = 'none' | 'drapes' | 'sheer' | 'drapesAndSheer' | 'roman' | 'roller' | 'blinds'

export interface CurtainSpec {
  kind: CurtainKind
  materialId?: Id
  sheerMaterialId?: Id
  /** 0 = fully open, 1 = fully closed */
  closed: number
  /** which wall side the curtain hangs on */
  side: 'left' | 'right'
  /** extra width beyond the opening on each side, mm */
  overhang: number
  /** if true curtain goes floor-to-ceiling, else to sill */
  fullHeight: boolean
}

/** flush slab, raised panels, wood leaf with glass lites, rail-and-stile (царговая) with inserts, all-glass */
export type DoorLeafStyle = 'flush' | 'panel' | 'glazed' | 'insert' | 'glass'
export const DOOR_LEAF_STYLES: readonly DoorLeafStyle[] = ['flush', 'panel', 'glazed', 'insert', 'glass']
/** surface track, pocket (leaf hides inside the wall), barn (exposed rail with rollers), folding (accordion) */
export type DoorSlide = 'surface' | 'pocket' | 'barn' | 'folding'
export const DOOR_SLIDES: readonly DoorSlide[] = ['surface', 'pocket', 'barn', 'folding']

export interface Opening extends LayerFlags {
  id: Id
  wallId: Id
  kind: OpeningKind
  /** distance of the opening CENTRE from node `a`, along the wall axis, mm */
  offset: number
  width: number
  height: number
  /** bottom of the opening above floor, mm (0 for doors) */
  sill: number
  /** hinge side as seen walking a→b */
  hinge: 'a' | 'b'
  /** side the leaf swings into */
  swing: 'left' | 'right'
  frameMaterialId?: Id
  leafMaterialId?: Id
  /** doors: look of the leaf; default panel (glass when the leaf material is transparent) */
  style?: DoorLeafStyle
  /** sliding doors: how the leaf moves; default surface (track on the wall face) */
  slide?: DoorSlide
  /** window: number of sashes; door: ignored */
  sashes?: number
  /** window sill board depth mm (0 = none) */
  sillBoard?: number
  curtain?: CurtainSpec
}

// ───────────────────────────── Rooms ─────────────────────────────

export type RoomType =
  | 'living'
  | 'bedroom'
  | 'kitchen'
  | 'kitchenLiving'
  | 'bathroom'
  | 'toilet'
  | 'hallway'
  | 'corridor'
  | 'balcony'
  | 'loggia'
  | 'wardrobe'
  | 'office'
  | 'kids'
  | 'storage'
  | 'other'

export type TilePatternType =
  | 'none'
  | 'grid'
  | 'brick'
  | 'brickThird'
  | 'herringbone'
  | 'chevron'
  | 'hex'
  | 'basket'
  | 'diagonal'
  | 'planks'

/** Procedural laying pattern applied on top of a material. */
export interface TilePattern {
  type: TilePatternType
  /** tile/plank size, mm */
  tileW: number
  tileH: number
  /** grout/joint width mm */
  grout: number
  groutColor: string
  /** degrees */
  rotation: number
  /** optional tint variation 0..1 between tiles */
  variation?: number
  /** optional second colour for checkerboard, '#rrggbb' */
  altColor?: string
  /** shift of the layout origin along the surface, mm (where the first full tile starts) */
  offsetX?: number
  offsetY?: number
  /** waste allowance 0..1 for the estimate (default by type: straight 10 %, diagonal 15 %, herringbone / chevron 20 %) */
  waste?: number
}

export interface SurfaceFinish {
  materialId: Id
  pattern?: TilePattern
  /** tint multiplied with the material colour, '#rrggbb' */
  tint?: string
}

export type CeilingKind = 'flat' | 'stretch' | 'multilevel' | 'coffered' | 'beams'

export interface CeilingSpec extends SurfaceFinish {
  kind: CeilingKind
  /** ceiling height above floor, mm; undefined = wall height */
  height?: number
  /** multilevel: width of lowered perimeter border mm, drop mm, with optional cove LED */
  borderWidth?: number
  borderDrop?: number
  coveLight?: boolean
  /** cornice (ceiling moulding) profile height mm, 0 = none */
  cornice?: number
}

/**
 * Persistent room record. Geometry is DERIVED (see DerivedRoom in core/rooms) —
 * a record is matched to the detected face that contains `anchor`.
 */
export interface Room extends LayerFlags {
  id: Id
  levelId: Id
  anchor: Vec2
  name: string
  type: RoomType
  floor: SurfaceFinish
  ceiling: CeilingSpec
  /** skirting board height mm (0 = none) and material */
  skirting: number
  skirtingMaterialId?: Id
  /** area printed on the source plan, m² (computed-vs-labelled report) */
  labelledArea?: number
  /** design layer: style the room was dressed in (core/styles) */
  design?: RoomDesign
}

/** Per-room design choices. */
export interface RoomDesign {
  /** id of the style preset last applied to the room (BUILTIN_STYLES or a project style) */
  styleId?: Id
  /**
   * the wall face (`wallId:side`) the style made the accent wall, so a later apply can move it.
   * Missing when the style gave the room no accent wall, the wall was not copied with the room, or
   * the style was applied by 0.8.0 (no way to tell these apart: accent-material walls are then the
   * user's and are never reset)
   */
  accentFace?: string
}

// ───────────────────────────── Items (furniture etc.) ─────────────────────────────

/**
 * floor: stands on the floor · wall: hangs on a wall face · ceiling: hangs from the ceiling ·
 * surface: stands on another item (worktop, table, stand) · free: anywhere in the air at `elevation`
 */
export type MountKind = 'floor' | 'wall' | 'ceiling' | 'surface' | 'free'

export interface Item extends LayerFlags {
  id: Id
  levelId: Id
  assetId: Id
  name?: string
  /** centre of the footprint on the plan, mm */
  x: number
  y: number
  /** bottom of the item above the level floor, mm */
  elevation: number
  /** degrees clockwise on plan */
  rotation: number
  /** final size in mm (w = local X, d = local depth on plan, h = height). Model is scaled to fit. */
  size: { w: number; d: number; h: number }
  mirrored?: boolean
  mount: MountKind
  /** material slot name → material id */
  overrides?: Record<string, Id>
  /** tint multiplied with all un-overridden slots */
  tint?: string
  /** parameters for procedural assets */
  params?: Record<string, number | string | boolean>
  locked?: boolean
  hidden?: boolean
  groupId?: Id
}

// ───────────────────────────── Lights ─────────────────────────────

export type LightKind = 'ceiling' | 'spot' | 'pendant' | 'point' | 'strip' | 'area'

export interface Light extends LayerFlags {
  id: Id
  levelId: Id
  kind: LightKind
  x: number
  y: number
  /** mm above floor */
  elevation: number
  /** Kelvin */
  temperature: number
  /** lumens */
  lumens: number
  on: boolean
  /** spot: target direction degrees on plan + tilt; strip/area: size */
  rotation?: number
  size?: { w: number; d: number }
}

// ───────────────────────────── Annotations ─────────────────────────────

export interface Dimension extends LayerFlags {
  id: Id
  levelId: Id
  a: Vec2
  b: Vec2
  /** perpendicular offset of the dimension line from a–b, mm (signed) */
  offset: number
}

export interface Label extends LayerFlags {
  id: Id
  levelId: Id
  x: number
  y: number
  text: string
  size: number
}

/**
 * «Карандаш»: a freehand mark drawn over the plan to point at a zone in the AI chat
 * («в ① ширина 180 см»). Editor-only: not exported, not shown in 3D.
 */
export interface Annotation extends LayerFlags {
  id: Id
  levelId: Id
  /** badge number shown as ①, ② … */
  n: number
  /** stroke = open freehand line; zone = closed lasso / rectangle */
  shape: 'stroke' | 'zone'
  /** plan points, mm */
  points: Vec2[]
  /** the measurements given for this mark were applied */
  done?: boolean
}

/** Background image for tracing. */
export interface Underlay {
  id: Id
  levelId: Id
  /** asset url (doplan-asset://project/<hash>.<ext>) or data URL */
  src: string
  /** position of the image top-left corner, mm */
  x: number
  y: number
  /** mm per image pixel */
  scale: number
  rotation: number
  opacity: number
  visible: boolean
  locked: boolean
  widthPx: number
  heightPx: number
  /** user name shown in the layers panel */
  name?: string
  /** user layer (`Doc.layers`) the image is on */
  layerId?: Id
}

// ───────────────────────────── Catalog: materials & assets ─────────────────────────────

export type MaterialCategory =
  | 'paint'
  | 'wallpaper'
  | 'plaster'
  | 'wood'
  | 'parquet'
  | 'laminate'
  | 'tile'
  | 'stone'
  | 'marble'
  | 'concrete'
  | 'brick'
  | 'fabric'
  | 'carpet'
  | 'leather'
  | 'metal'
  | 'glass'
  | 'plastic'
  | 'ceiling'
  | 'outdoor'
  | 'other'

export interface MaterialMaps {
  color?: string
  normal?: string
  roughness?: string
  metalness?: string
  ao?: string
  /** packed AO(R) Roughness(G) Metalness(B) */
  arm?: string
  displacement?: string
}

/** Colour from a colour system (paints): the hex in `Material.color` is an on-screen approximation. */
export interface ColorCode {
  /** 'NCS' | 'RAL' | a paint brand name | 'custom' */
  system: string
  /** e.g. 'S 1002-Y', '9010' */
  code: string
}

export interface WallpaperSpec {
  /** roll width and length, mm (default 530 × 10050) */
  rollW: number
  rollL: number
  /** vertical pattern repeat, mm (0 = free match) */
  repeat?: number
  /** straight / offset (half-drop) / free match */
  match?: 'straight' | 'offset' | 'free'
}

export interface PaintSpec {
  /** m² per litre per coat (default 10) */
  coverage?: number
  /** coats (default 2) */
  coats?: number
}

/** Price unit of a product = the estimate unit it is bought in. */
export type PriceUnit = 'м²' | 'м' | 'шт' | 'л' | 'рул.' | 'уп.'

/**
 * A product the user buys for a material or an item. `price` is in the project currency
 * (`DocDesign.currency`), per `priceUnit`.
 */
export interface ProductRef {
  vendor?: string
  sku?: string
  url?: string
  price?: number
  priceUnit?: PriceUnit
  /** amount in one pack, in the estimate unit: m² per pack, litres per can, metres per plank */
  pack?: number
  /** ISO date of the price */
  updatedAt?: string
  /** where the price came from */
  source?: 'manual' | 'csv' | 'link' | 'feed'
  note?: string
  /** project price list only: the material card's price is not used (the price was erased in the estimate) */
  noPrice?: boolean
}

export interface Material {
  id: Id
  name: string
  nameRu?: string
  category: MaterialCategory
  /** base colour '#rrggbb' (multiplied with color map if present) */
  color: string
  /** colour-system code of a paint (NCS / RAL / brand) */
  colorCode?: ColorCode
  /** wallpaper roll and pattern repeat (estimate) */
  wallpaper?: WallpaperSpec
  /** paint coverage (estimate) */
  paint?: PaintSpec
  /** the product to buy: vendor, article, link, price */
  product?: ProductRef
  roughness: number
  metalness: number
  /** texture URLs (doplan-asset://… or relative to catalog root) */
  maps?: MaterialMaps
  /** real-world size covered by one texture repeat, mm */
  sizeMm?: [number, number]
  /** default laying pattern suggested for this material */
  pattern?: TilePattern
  /** glass etc. */
  transmission?: number
  opacity?: number
  ior?: number
  sheen?: number
  clearcoat?: number
  emissive?: string
  emissiveIntensity?: number
  normalScale?: number
  tags?: string[]
  source?: string
  licence?: string
  /** true if not yet downloaded (maps point to remote URLs listed in `remote`) */
  remote?: boolean
  thumb?: string
  custom?: boolean
}

export type AssetCategory =
  | 'sofa'
  | 'armchair'
  | 'chair'
  | 'table'
  | 'bed'
  | 'storage'
  | 'kitchen'
  | 'appliance'
  | 'bathroom'
  | 'lighting'
  | 'decor'
  | 'plant'
  | 'textile'
  | 'electronics'
  | 'outdoor'
  | 'kids'
  | 'office'
  | 'structure'
  | 'other'

export type ProceduralKind =
  | 'box'
  | 'kitchenBase'
  | 'kitchenWall'
  | 'kitchenTall'
  | 'worktop'
  | 'wardrobe'
  | 'shelf'
  | 'bed'
  | 'sofa'
  | 'table'
  | 'chair'
  | 'fridge'
  | 'stove'
  | 'oven'
  | 'hood'
  | 'dishwasher'
  | 'washingMachine'
  | 'tv'
  | 'sink'
  | 'toilet'
  | 'bathtub'
  | 'shower'
  | 'washbasin'
  | 'radiator'
  | 'rug'
  | 'mirror'
  | 'picture'
  | 'column'
  | 'stairs'
  | 'airConditioner'
  | 'plantPot'

export interface Asset {
  id: Id
  name: string
  nameRu?: string
  category: AssetCategory
  kind: 'model' | 'procedural'
  /** model: URL of .glb/.gltf (doplan-asset://… or relative to catalog root) */
  src?: string
  procedural?: ProceduralKind
  /** default size mm */
  size: { w: number; d: number; h: number }
  mount: MountKind
  /** default elevation for wall/surface mounted items, mm */
  elevation?: number
  /** named material slots that can be overridden + default material ids */
  slots?: Record<string, Id>
  defaultParams?: Record<string, number | string | boolean>
  thumb?: string
  tags?: string[]
  source?: string
  licence?: string
  author?: string
  remote?: boolean
  custom?: boolean
}

export interface Hdri {
  id: Id
  name: string
  src: string
  kind: 'exterior' | 'interior'
  thumb?: string
  source?: string
  licence?: string
}

export interface Catalog {
  version: number
  materials: Material[]
  assets: Asset[]
  hdris: Hdri[]
}

// ───────────────────────────── Cameras & render ─────────────────────────────

export interface CameraBookmark {
  id: Id
  name: string
  /** world metres */
  position: [number, number, number]
  target: [number, number, number]
  fov: number
  mode: 'orbit' | 'walk'
}

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'

export interface RenderSettings {
  quality: QualityPreset
  /** sun azimuth degrees clockwise from plan "up" (−y), elevation degrees above horizon */
  sunAzimuth: number
  sunElevation: number
  sunIntensity: number
  /** hours 0..24, drives sun if `sunAuto` */
  timeOfDay: number
  sunAuto: boolean
  /** plan rotation of north, degrees */
  north: number
  hdriId?: Id
  hdriIntensity: number
  hdriRotation: number
  exposure: number
  toneMapping: 'agx' | 'aces' | 'neutral'
  ao: boolean
  ssgi: boolean
  ssr: boolean
  bloom: boolean
  /** auto-hide walls facing the camera in orbit mode */
  wallCutaway: boolean
  ceilingVisible: boolean
  lightsOn: boolean
}

// ───────────────────────────── Document ─────────────────────────────

export interface DocSettings {
  gridMm: number
  snapGrid: boolean
  snapObjects: boolean
  snapAngle: boolean
  wallThickness: number
  wallHeight: number
  showDimensions: boolean
  showAreas: boolean
  showFurniture2d: boolean
  /** "W × D" under item names and the clearances of the selected item (default true) */
  showItemSizes: boolean
  units: 'mm' | 'cm' | 'm'
}

/** What the source plan the project was traced from (BTI / developer plan) states. */
export interface DocSource {
  /** e.g. 'bti', 'developer', 'photo', 'sketch' */
  kind?: string
  /** общая площадь as printed, m² */
  labelledTotalArea?: number
  /** жилая площадь as printed, m² */
  labelledLivingArea?: number
}

export interface DocMeta {
  name: string
  /**
   * Stable project identity (keys its AI chats): survives renaming or moving the file and crash
   * recovery; Save As and imports give a new one. Missing in files from before 0.6.
   */
  id?: string
  createdAt: string
  modifiedAt: string
  app: 'doplan'
}

export const DOC_VERSION = 1

export interface Doc {
  version: number
  meta: DocMeta
  settings: DocSettings
  render: RenderSettings
  /** ordered */
  levelOrder: Id[]
  levels: Record<Id, Level>
  nodes: Record<Id, PlanNode>
  walls: Record<Id, Wall>
  openings: Record<Id, Opening>
  rooms: Record<Id, Room>
  items: Record<Id, Item>
  lights: Record<Id, Light>
  dimensions: Record<Id, Dimension>
  labels: Record<Id, Label>
  /** pencil marks (editor-only, see Annotation) */
  annotations?: Record<Id, Annotation>
  underlays: Record<Id, Underlay>
  cameras: Record<Id, CameraBookmark>
  /** project-local (custom / embedded) materials and assets; builtin ones live in the Catalog */
  materials: Record<Id, Material>
  assets: Record<Id, Asset>
  /** what the traced source plan states (labelled areas) */
  source?: DocSource
  /** design layer: apartment style, currency and the user's price list */
  design?: DocDesign
  /** flat user layers (layers panel); objects reference them by `layerId` */
  layers?: Record<Id, UserLayer>
  /** panel order of `layers` */
  layerOrder?: Id[]
  /** visibility / lock of whole kinds, keyed by the kind (`EntityRef.kind`, e.g. 'wall', 'item') */
  groupFlags?: Record<string, GroupFlags>
}

/** Project-wide design settings. */
export interface DocDesign {
  /** style applied to the whole apartment last (default for new rooms) */
  styleId?: Id
  /** ISO 4217 currency of prices in this project ('KZT', 'RUB', 'USD', 'EUR'…); absent = not chosen */
  currency?: string
  /** the user's own price list: material / asset id → product (wins over `Material.product`) */
  priceList?: Record<Id, ProductRef>
}

export type EntityKind =
  | 'node'
  | 'wall'
  | 'opening'
  | 'room'
  | 'item'
  | 'light'
  | 'dimension'
  | 'label'
  | 'underlay'

export interface EntityRef {
  kind: EntityKind
  id: Id
}

// ───────────────────────────── Derived geometry (computed, never stored) ─────────────────────────────

/** Outline of a wall after mitring at its junctions. */
export interface WallGeom {
  wallId: Id
  /** closed CCW-on-screen polygon of the wall footprint, mm */
  polygon: Vec2[]
  /** face segment on the left side (from a-end to b-end) and right side */
  left: [Vec2, Vec2]
  right: [Vec2, Vec2]
  /** centreline */
  a: Vec2
  b: Vec2
  length: number
  /** radians, atan2(dy, dx) */
  angle: number
}

export interface RoomBoundaryEdge {
  wallId: Id
  side: 'left' | 'right'
  /** segment of the inner face along this room, mm */
  from: Vec2
  to: Vec2
}

export interface DerivedRoom {
  /** id of the matched Room record, or a deterministic temp id `auto_<hash>` if none */
  roomId: Id
  levelId: Id
  /** inner boundary (wall faces), clockwise on screen, mm */
  polygon: Vec2[]
  /** inner islands (free-standing wall loops / columns) */
  holes: Vec2[][]
  /** centreline polygon (through nodes) */
  centerline: Vec2[]
  edges: RoomBoundaryEdge[]
  /** m² measured by inner faces */
  area: number
  /** m */
  perimeter: number
  /** good position for a label (pole of inaccessibility), mm */
  labelPoint: Vec2
}

export interface DerivedPlan {
  wallGeoms: Record<Id, WallGeom>
  rooms: DerivedRoom[]
  /** plan bounding box mm */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}
