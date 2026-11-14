/**
 * Defaults and the built-in (colour-only, zero-download) catalogue.
 * Everything here is plain data; ids are stable (`mat_*`, `asset_*`) because documents reference them.
 */
import { newId } from './ids'
import {
  DOC_VERSION,
  type Asset,
  type AssetCategory,
  type CurtainSpec,
  type Doc,
  type DocSettings,
  type Id,
  type Level,
  type Material,
  type MaterialCategory,
  type MountKind,
  type OpeningKind,
  type ProceduralKind,
  type RenderSettings,
  type Room,
  type RoomType,
  type TilePattern,
  type TilePatternType,
  type Vec2,
  type WallSide,
} from './types'

// ───────────────────────────── default material ids ─────────────────────────────

export const DEFAULT_MATERIALS = {
  wall: 'mat_paint_white_warm',
  floor: 'mat_laminate_oak',
  ceiling: 'mat_ceiling_white',
  skirting: 'mat_plastic_white',
  door: 'mat_wood_white',
  frame: 'mat_plastic_window_white',
  glass: 'mat_glass_clear',
  curtain: 'mat_fabric_linen_beige',
  sheer: 'mat_fabric_sheer_white',
} satisfies Record<string, Id>

// ───────────────────────────── built-in materials ─────────────────────────────

function pat(
  type: TilePatternType,
  tileW: number,
  tileH: number,
  grout: number,
  groutColor: string,
  extra?: Partial<TilePattern>,
): TilePattern {
  return { type, tileW, tileH, grout, groutColor, rotation: 0, ...extra }
}

function mat(
  id: string,
  name: string,
  nameRu: string,
  category: MaterialCategory,
  color: string,
  roughness: number,
  metalness = 0,
  extra?: Partial<Material>,
): Material {
  return { id: `mat_${id}`, name, nameRu, category, color, roughness, metalness, source: 'builtin', licence: 'CC0', ...extra }
}

const paint = (id: string, name: string, nameRu: string, color: string): Material =>
  mat(`paint_${id}`, name, nameRu, 'paint', color, 0.9, 0, { tags: ['краска', 'paint'] })

export const BUILTIN_MATERIALS: Material[] = [
  // ── paints: designer palette ──
  paint('white', 'Pure white', 'Белый', '#f5f5f2'),
  paint('white_warm', 'Warm white', 'Тёплый белый', '#f2efe6'),
  paint('ivory', 'Ivory', 'Слоновая кость', '#efe6d3'),
  paint('cream', 'Cream', 'Кремовый', '#eadfc8'),
  paint('beige', 'Beige', 'Бежевый', '#d9c8ad'),
  paint('sand', 'Sand', 'Песочный', '#cdb994'),
  paint('greige', 'Greige', 'Грейдж', '#c9c1b4'),
  paint('taupe', 'Taupe', 'Тауп', '#9a8b7c'),
  paint('light_grey', 'Light grey', 'Светло-серый', '#d5d6d4'),
  paint('grey', 'Grey', 'Серый', '#a9abab'),
  paint('graphite', 'Graphite', 'Графит', '#4a4d50'),
  paint('anthracite', 'Anthracite', 'Антрацит', '#2f3235'),
  paint('black', 'Black', 'Чёрный', '#1b1b1c'),
  paint('blush', 'Dusty pink', 'Пыльная роза', '#d9b8b0'),
  paint('peach', 'Peach', 'Персиковый', '#ecc7a8'),
  paint('terracotta', 'Terracotta', 'Терракота', '#b8674a'),
  paint('ochre', 'Ochre', 'Охра', '#c99a3e'),
  paint('mustard', 'Mustard', 'Горчичный', '#b8902f'),
  paint('olive', 'Olive', 'Оливковый', '#8a8b5c'),
  paint('sage', 'Sage', 'Шалфей', '#a9b5a0'),
  paint('mint', 'Mint', 'Мятный', '#bfdccf'),
  paint('forest', 'Forest green', 'Тёмно-зелёный', '#2f4a3c'),
  paint('emerald', 'Emerald', 'Изумрудный', '#1f6b57'),
  paint('sky', 'Sky blue', 'Небесно-голубой', '#bcd5e4'),
  paint('dusty_blue', 'Dusty blue', 'Пыльно-голубой', '#8fa7b8'),
  paint('petrol', 'Petrol', 'Петроль', '#2c5a6b'),
  paint('navy', 'Navy', 'Тёмно-синий', '#24344d'),
  paint('lavender', 'Lavender', 'Лавандовый', '#c2bcd8'),
  paint('plum', 'Plum', 'Сливовый', '#5d3b52'),
  paint('burgundy', 'Burgundy', 'Бордовый', '#6e2530'),
  paint('chocolate', 'Chocolate', 'Шоколадный', '#4d382c'),

  // ── wallpaper ──
  mat('wallpaper_white', 'Paintable wallpaper, white', 'Обои под покраску белые', 'wallpaper', '#eeece6', 0.85),
  mat('wallpaper_beige', 'Wallpaper, beige', 'Обои бежевые', 'wallpaper', '#d8ccb8', 0.85),
  mat('wallpaper_grey_blue', 'Wallpaper, grey-blue', 'Обои серо-голубые', 'wallpaper', '#a9b6bf', 0.85),
  mat('wallpaper_green', 'Wallpaper, green', 'Обои зелёные', 'wallpaper', '#8f9f8a', 0.85),

  // ── plaster ──
  mat('plaster_white', 'Plaster, white', 'Штукатурка белая', 'plaster', '#e9e6df', 0.95),
  mat('plaster_venetian_beige', 'Venetian plaster, beige', 'Венецианская штукатурка бежевая', 'plaster', '#d8cbb5', 0.35, 0, {
    clearcoat: 0.3,
  }),
  mat('plaster_grey', 'Decorative plaster, grey', 'Декоративная штукатурка серая', 'plaster', '#9c9c98', 0.9),

  // ── wood (furniture, doors, veneers) ──
  mat('wood_oak_natural', 'Oak, natural', 'Дуб натуральный', 'wood', '#c19a6b', 0.55),
  mat('wood_oak_bleached', 'Oak, bleached', 'Дуб белёный', 'wood', '#d9c7a8', 0.55),
  mat('wood_walnut', 'Walnut', 'Орех', 'wood', '#6b4a32', 0.5),
  mat('wood_wenge', 'Wenge', 'Венге', 'wood', '#3b2a22', 0.5),
  mat('wood_ash_grey', 'Ash, grey', 'Ясень серый', 'wood', '#a59a8c', 0.55),
  mat('wood_pine', 'Pine', 'Сосна', 'wood', '#d8b57c', 0.6),
  mat('wood_white', 'White enamel on wood', 'Белая эмаль (МДФ)', 'wood', '#efede8', 0.4),

  // ── parquet ──
  mat('parquet_oak', 'Parquet, oak herringbone', 'Паркет дуб «ёлочка»', 'parquet', '#b98d5e', 0.5, 0, {
    pattern: pat('herringbone', 70, 420, 0.5, '#7a5a3a', { variation: 0.25 }),
  }),
  mat('parquet_walnut', 'Parquet, walnut herringbone', 'Паркет орех «ёлочка»', 'parquet', '#70503a', 0.5, 0, {
    pattern: pat('herringbone', 70, 420, 0.5, '#402c1e', { variation: 0.25 }),
  }),
  mat('parquet_light', 'Engineered board, light oak', 'Инженерная доска светлый дуб', 'parquet', '#d2b78f', 0.5, 0, {
    pattern: pat('planks', 180, 1800, 0.5, '#9c8463', { variation: 0.2 }),
  }),

  // ── laminate ──
  mat('laminate_oak', 'Laminate, oak', 'Ламинат дуб', 'laminate', '#c4a077', 0.55, 0, {
    pattern: pat('planks', 193, 1380, 0.5, '#8f7352', { variation: 0.2 }),
  }),
  mat('laminate_grey', 'Laminate, grey oak', 'Ламинат серый дуб', 'laminate', '#a8a198', 0.55, 0, {
    pattern: pat('planks', 193, 1380, 0.5, '#7b756d', { variation: 0.2 }),
  }),
  mat('laminate_dark', 'Laminate, dark walnut', 'Ламинат тёмный орех', 'laminate', '#5a4435', 0.55, 0, {
    pattern: pat('planks', 193, 1380, 0.5, '#33261d', { variation: 0.2 }),
  }),

  // ── tile ──
  mat('tile_white_gloss', 'Wall tile, glossy white', 'Плитка белая глянцевая', 'tile', '#f4f4f2', 0.15, 0, {
    pattern: pat('grid', 200, 300, 2, '#d8d8d6'),
  }),
  mat('tile_white_matt', 'Porcelain tile, matt white', 'Керамогранит белый матовый', 'tile', '#ecebe7', 0.5, 0, {
    pattern: pat('grid', 600, 600, 2, '#cfcfcb'),
  }),
  mat('tile_grey', 'Porcelain tile, grey', 'Керамогранит серый', 'tile', '#9a9c9c', 0.45, 0, {
    pattern: pat('grid', 600, 600, 2, '#7d7f7f'),
  }),
  mat('tile_beige', 'Porcelain tile, beige', 'Керамогранит бежевый', 'tile', '#d6c7b0', 0.4, 0, {
    pattern: pat('grid', 600, 600, 2, '#b8aa94'),
  }),
  mat('tile_graphite', 'Porcelain tile, graphite', 'Керамогранит графит', 'tile', '#3d4043', 0.4, 0, {
    pattern: pat('brick', 1200, 600, 2, '#2a2c2e'),
  }),
  mat('tile_black', 'Tile, glossy black', 'Плитка чёрная глянцевая', 'tile', '#1f2022', 0.15, 0, {
    pattern: pat('grid', 300, 300, 2, '#3a3b3d'),
  }),
  mat('tile_metro_white', 'Metro tile, white', 'Плитка «кабанчик» белая', 'tile', '#f3f3f0', 0.12, 0, {
    pattern: pat('brick', 200, 100, 2, '#cfcfcc'),
  }),
  mat('tile_green', 'Metro tile, green', 'Плитка «кабанчик» зелёная', 'tile', '#4d7a66', 0.15, 0, {
    pattern: pat('brick', 300, 75, 2, '#e4e4e0', { variation: 0.15 }),
  }),
  mat('tile_blue', 'Tile, blue', 'Плитка голубая', 'tile', '#5f8fa8', 0.2, 0, {
    pattern: pat('grid', 150, 150, 2, '#e8e8e6', { variation: 0.15 }),
  }),
  mat('tile_terracotta', 'Hexagon tile, terracotta', 'Плитка «соты» терракота', 'tile', '#b5694a', 0.6, 0, {
    pattern: pat('hex', 200, 230, 3, '#8d8377', { variation: 0.2 }),
  }),
  mat('tile_checker', 'Checkerboard tile', 'Плитка «шахматка»', 'tile', '#efefec', 0.25, 0, {
    pattern: pat('diagonal', 300, 300, 2, '#8a8a88', { altColor: '#1f2022' }),
  }),

  // ── stone ──
  mat('stone_grey', 'Stone, grey', 'Камень серый', 'stone', '#8c8a85', 0.7),
  mat('stone_sandstone', 'Sandstone', 'Песчаник', 'stone', '#c8b28c', 0.8),
  mat('stone_slate', 'Slate', 'Сланец', 'stone', '#45484b', 0.65),
  mat('stone_quartz_white', 'Quartz worktop, white', 'Кварц белый (столешница)', 'stone', '#eceae6', 0.25),

  // ── marble ──
  mat('marble_white', 'Marble, white', 'Мрамор белый', 'marble', '#ecebe8', 0.15, 0, { clearcoat: 0.4 }),
  mat('marble_beige', 'Marble, beige', 'Мрамор бежевый', 'marble', '#d9c9b2', 0.2, 0, { clearcoat: 0.4 }),
  mat('marble_black', 'Marble, black', 'Мрамор чёрный', 'marble', '#232325', 0.15, 0, { clearcoat: 0.4 }),

  // ── concrete ──
  mat('concrete_light', 'Concrete, light', 'Бетон светлый', 'concrete', '#b5b4af', 0.85),
  mat('concrete_dark', 'Concrete, dark', 'Бетон тёмный', 'concrete', '#77777a', 0.85),
  mat('concrete_microcement', 'Microcement', 'Микроцемент', 'concrete', '#a8a59e', 0.6),

  // ── brick ──
  mat('brick_red', 'Brick, red', 'Кирпич красный', 'brick', '#9a4f3a', 0.9, 0, {
    pattern: pat('brick', 250, 65, 10, '#b9b2a6', { variation: 0.3 }),
  }),
  mat('brick_white', 'Brick, white painted', 'Кирпич белый', 'brick', '#e6e2da', 0.9, 0, {
    pattern: pat('brick', 250, 65, 10, '#d3cfc7', { variation: 0.08 }),
  }),
  mat('brick_grey', 'Brick, grey', 'Кирпич серый', 'brick', '#8d8a86', 0.9, 0, {
    pattern: pat('brick', 250, 65, 10, '#a9a6a1', { variation: 0.2 }),
  }),

  // ── fabric ──
  mat('fabric_linen_beige', 'Linen, beige', 'Лён бежевый', 'fabric', '#d5c8b2', 0.95, 0, { sheen: 0.3 }),
  mat('fabric_white', 'Cotton, white', 'Хлопок белый (постельное)', 'fabric', '#f1efea', 0.95, 0, { sheen: 0.2 }),
  mat('fabric_grey', 'Upholstery, grey', 'Ткань серая', 'fabric', '#8e9092', 0.95, 0, { sheen: 0.3 }),
  mat('fabric_graphite', 'Upholstery, graphite', 'Ткань графит', 'fabric', '#44474b', 0.95, 0, { sheen: 0.3 }),
  mat('fabric_blue', 'Upholstery, blue', 'Ткань синяя', 'fabric', '#3f5873', 0.95, 0, { sheen: 0.3 }),
  mat('fabric_mustard', 'Upholstery, mustard', 'Ткань горчичная', 'fabric', '#c29a3a', 0.95, 0, { sheen: 0.3 }),
  mat('fabric_velvet_green', 'Velvet, green', 'Велюр зелёный', 'fabric', '#3c5a4a', 0.8, 0, { sheen: 0.9 }),
  mat('fabric_velvet_pink', 'Velvet, powder pink', 'Велюр пудровый', 'fabric', '#d4a9a2', 0.8, 0, { sheen: 0.9 }),
  mat('fabric_blackout_grey', 'Blackout curtain, grey', 'Блэкаут серый', 'fabric', '#6f7175', 0.9, 0, { sheen: 0.2 }),
  mat('fabric_sheer_white', 'Sheer voile, white', 'Тюль белый', 'fabric', '#ffffff', 0.9, 0, {
    opacity: 0.45,
    transmission: 0.5,
    sheen: 0.2,
  }),

  // ── carpet ──
  mat('carpet_beige', 'Carpet, beige', 'Ковёр бежевый', 'carpet', '#cdbfa8', 1, 0, { sheen: 0.5 }),
  mat('carpet_grey', 'Carpet, grey', 'Ковёр серый', 'carpet', '#8b8d8f', 1, 0, { sheen: 0.5 }),
  mat('carpet_blue', 'Carpet, blue', 'Ковёр синий', 'carpet', '#4a6078', 1, 0, { sheen: 0.5 }),

  // ── leather ──
  mat('leather_brown', 'Leather, brown', 'Кожа коричневая', 'leather', '#6b4630', 0.45),
  mat('leather_cognac', 'Leather, cognac', 'Кожа коньячная', 'leather', '#a5673f', 0.45),
  mat('leather_black', 'Leather, black', 'Кожа чёрная', 'leather', '#1e1e1f', 0.4),
  mat('leather_white', 'Leather, off-white', 'Кожа молочная', 'leather', '#e8e3d9', 0.45),

  // ── metal ──
  mat('metal_steel', 'Stainless steel', 'Нержавеющая сталь', 'metal', '#c2c5c7', 0.3, 1),
  mat('metal_chrome', 'Chrome', 'Хром', 'metal', '#e3e5e6', 0.05, 1),
  mat('metal_aluminium', 'Aluminium', 'Алюминий', 'metal', '#b8babc', 0.4, 1),
  mat('metal_brass', 'Brass', 'Латунь', 'metal', '#c9a55a', 0.25, 1),
  mat('metal_gold', 'Gold', 'Золото', 'metal', '#d9b25f', 0.2, 1),
  mat('metal_copper', 'Copper', 'Медь', 'metal', '#b87348', 0.25, 1),
  mat('metal_black', 'Black metal', 'Чёрный металл', 'metal', '#1c1c1e', 0.45, 1),
  mat('metal_white', 'White enamelled metal', 'Металл белый (эмаль)', 'metal', '#f0f0ee', 0.35, 0.1, { clearcoat: 0.5 }),

  // ── glass ──
  mat('glass_clear', 'Clear glass', 'Стекло прозрачное', 'glass', '#ffffff', 0.02, 0, {
    transmission: 1,
    opacity: 0.25,
    ior: 1.5,
  }),
  mat('glass_frosted', 'Frosted glass', 'Стекло матовое', 'glass', '#f2f6f6', 0.45, 0, {
    transmission: 0.85,
    opacity: 0.6,
    ior: 1.5,
  }),
  mat('glass_tinted', 'Tinted glass', 'Стекло тонированное', 'glass', '#6f7b80', 0.03, 0, {
    transmission: 0.8,
    opacity: 0.5,
    ior: 1.5,
  }),
  mat('glass_black', 'Black glass', 'Чёрное стекло', 'glass', '#0c0c0e', 0.08, 0, { clearcoat: 1 }),
  mat('glass_mirror', 'Mirror', 'Зеркало', 'glass', '#f2f4f5', 0.02, 1),

  // ── plastic ──
  mat('plastic_white', 'Plastic, white', 'Пластик белый', 'plastic', '#f2f2f0', 0.4),
  mat('plastic_grey', 'Plastic, grey', 'Пластик серый', 'plastic', '#9a9c9e', 0.45),
  mat('plastic_black', 'Plastic, black', 'Пластик чёрный', 'plastic', '#1d1d1f', 0.45),
  mat('plastic_window_white', 'PVC profile, white', 'ПВХ-профиль белый', 'plastic', '#f6f6f4', 0.35),
  mat('plastic_acrylic_white', 'Sanitary acrylic, white', 'Акрил белый (ванна)', 'plastic', '#fbfbf9', 0.15, 0, { clearcoat: 0.8 }),

  // ── ceiling ──
  mat('ceiling_white', 'Ceiling, matt white', 'Потолок белый матовый', 'ceiling', '#f8f8f6', 0.95),
  mat('ceiling_stretch_satin', 'Stretch ceiling, satin', 'Натяжной потолок сатиновый', 'ceiling', '#f4f4f2', 0.35),
  mat('ceiling_stretch_gloss', 'Stretch ceiling, glossy white', 'Натяжной потолок глянцевый', 'ceiling', '#f6f6f6', 0.08, 0, {
    clearcoat: 1,
  }),
  mat('ceiling_stretch_black', 'Stretch ceiling, glossy black', 'Натяжной потолок чёрный глянец', 'ceiling', '#141416', 0.06, 0, {
    clearcoat: 1,
  }),

  // ── outdoor ──
  mat('outdoor_decking', 'Decking board', 'Террасная доска', 'outdoor', '#8a6b4e', 0.7, 0, {
    pattern: pat('planks', 140, 2000, 5, '#3a2c20', { variation: 0.15 }),
  }),
  mat('outdoor_paving', 'Paving, grey', 'Тротуарная плитка серая', 'outdoor', '#9d9b96', 0.9, 0, {
    pattern: pat('brick', 200, 100, 4, '#6f6d69', { variation: 0.15 }),
  }),
  mat('outdoor_grass', 'Lawn', 'Газон', 'outdoor', '#5d8a3c', 1),
  mat('outdoor_siding', 'Facade panel, light', 'Фасадная панель светлая', 'outdoor', '#d8d5cc', 0.8),

  // ── other ──
  mat('other_ceramic_white', 'Sanitary ceramic, white', 'Санфаянс белый', 'other', '#fbfbf9', 0.08, 0, { clearcoat: 1 }),
  mat('other_rubber_black', 'Rubber, black', 'Резина чёрная', 'other', '#151515', 0.9),
  mat('other_cork', 'Cork', 'Пробка', 'other', '#b08a5e', 0.9),
  mat('other_soil', 'Soil', 'Грунт', 'other', '#3d2e22', 1),
  mat('other_foliage', 'Foliage, green', 'Листва зелёная', 'other', '#3f6b34', 0.7),
  mat('other_led_warm', 'Luminous, warm white', 'Светящийся тёплый белый', 'other', '#fff1d6', 0.5, 0, {
    emissive: '#ffe2b0',
    emissiveIntensity: 3,
  }),
]

// ───────────────────────────── built-in procedural assets ─────────────────────────────

type Params = Record<string, number | string | boolean>

function asset(
  id: string,
  name: string,
  nameRu: string,
  category: AssetCategory,
  procedural: ProceduralKind,
  size: [number, number, number],
  slots: Record<string, Id>,
  opts?: { mount?: MountKind; elevation?: number; params?: Params; tags?: string[] },
): Asset {
  const a: Asset = {
    id: `asset_${id}`,
    name,
    nameRu,
    category,
    kind: 'procedural',
    procedural,
    size: { w: size[0], d: size[1], h: size[2] },
    mount: opts?.mount ?? 'floor',
    slots,
    source: 'builtin',
    licence: 'CC0',
  }
  if (opts?.elevation !== undefined) a.elevation = opts.elevation
  if (opts?.params) a.defaultParams = opts.params
  if (opts?.tags) a.tags = opts.tags
  return a
}

const M = {
  white: 'mat_wood_white',
  oak: 'mat_wood_oak_natural',
  oakLight: 'mat_wood_oak_bleached',
  walnut: 'mat_wood_walnut',
  quartz: 'mat_stone_quartz_white',
  steel: 'mat_metal_steel',
  chrome: 'mat_metal_chrome',
  blackMetal: 'mat_metal_black',
  whiteMetal: 'mat_metal_white',
  glass: 'mat_glass_clear',
  glassTinted: 'mat_glass_tinted',
  glassBlack: 'mat_glass_black',
  mirror: 'mat_glass_mirror',
  fabricGrey: 'mat_fabric_grey',
  fabricBeige: 'mat_fabric_linen_beige',
  fabricWhite: 'mat_fabric_white',
  plasticWhite: 'mat_plastic_white',
  plasticBlack: 'mat_plastic_black',
  ceramic: 'mat_other_ceramic_white',
  acrylic: 'mat_plastic_acrylic_white',
  paintWhite: 'mat_paint_white',
} as const

const KITCHEN = { body: M.white, front: M.white, worktop: M.quartz, metal: M.steel }
const WARDROBE = { body: M.oakLight, front: M.white, metal: M.steel, glass: M.mirror }
const SOFA = { fabric: M.fabricGrey, legs: M.walnut }
const BED = { body: M.oak, fabric: M.fabricGrey, linen: M.fabricWhite, legs: M.oak }
const TABLE = { body: M.oak, worktop: M.oak, legs: M.blackMetal }
const CHAIR = { body: M.oak, fabric: M.fabricBeige, legs: M.oak }
const APPLIANCE = { body: M.whiteMetal, front: M.whiteMetal, glass: M.glassTinted, metal: M.chrome }
const APPLIANCE_STEEL = { body: M.steel, front: M.steel, glass: M.glassBlack, metal: M.chrome }

export const BUILTIN_ASSETS: Asset[] = [
  // ── structure ──
  asset('box', 'Box', 'Короб', 'structure', 'box', [400, 300, 2700], { body: M.paintWhite }, { tags: ['короб', 'ниша'] }),
  asset('box_podium', 'Podium', 'Подиум', 'structure', 'box', [2000, 1500, 150], { body: M.oak }, { tags: ['подиум'] }),
  asset('box_cube', 'Cube', 'Куб 500', 'other', 'box', [500, 500, 500], { body: M.paintWhite }),
  asset('column_square', 'Column, square', 'Колонна квадратная', 'structure', 'column', [400, 400, 2700], { body: M.paintWhite }, {
    params: { shape: 'square' },
  }),
  asset('column_round', 'Column, round', 'Колонна круглая', 'structure', 'column', [400, 400, 2700], { body: M.paintWhite }, {
    params: { shape: 'round' },
  }),
  asset('stairs_straight', 'Stairs, straight', 'Лестница прямая', 'structure', 'stairs', [1000, 3600, 2700], { body: M.oak, metal: M.blackMetal }, {
    params: { type: 'straight', steps: 16, railing: true },
  }),
  asset('stairs_l', 'Stairs, L-shaped', 'Лестница Г-образная', 'structure', 'stairs', [2000, 2800, 2700], { body: M.oak, metal: M.blackMetal }, {
    params: { type: 'L', steps: 16, railing: true },
  }),
  asset('stairs_u', 'Stairs, U-shaped', 'Лестница П-образная', 'structure', 'stairs', [2100, 2600, 2700], { body: M.oak, metal: M.blackMetal }, {
    params: { type: 'U', steps: 16, railing: true },
  }),

  // ── kitchen: base units (height incl. 100 mm plinth and 40 mm worktop) ──
  asset('kitchen_base_400', 'Base unit 400', 'Кухонная тумба 400', 'kitchen', 'kitchenBase', [400, 600, 900], KITCHEN, {
    params: { doors: 1, drawers: 0, plinth: 100, worktop: true },
    tags: ['кухня', 'нижний модуль'],
  }),
  asset('kitchen_base_600', 'Base unit 600', 'Кухонная тумба 600', 'kitchen', 'kitchenBase', [600, 600, 900], KITCHEN, {
    params: { doors: 1, drawers: 0, plinth: 100, worktop: true },
    tags: ['кухня', 'нижний модуль'],
  }),
  asset('kitchen_base_800', 'Base unit 800', 'Кухонная тумба 800', 'kitchen', 'kitchenBase', [800, 600, 900], KITCHEN, {
    params: { doors: 2, drawers: 0, plinth: 100, worktop: true },
    tags: ['кухня', 'нижний модуль'],
  }),
  asset('kitchen_base_drawers_600', 'Drawer unit 600', 'Тумба с ящиками 600', 'kitchen', 'kitchenBase', [600, 600, 900], KITCHEN, {
    params: { doors: 0, drawers: 3, plinth: 100, worktop: true },
    tags: ['кухня', 'ящики'],
  }),
  asset('kitchen_base_drawers_800', 'Drawer unit 800', 'Тумба с ящиками 800', 'kitchen', 'kitchenBase', [800, 600, 900], KITCHEN, {
    params: { doors: 0, drawers: 3, plinth: 100, worktop: true },
    tags: ['кухня', 'ящики'],
  }),
  asset('kitchen_base_sink_800', 'Sink unit 800', 'Тумба под мойку 800', 'kitchen', 'kitchenBase', [800, 600, 900], KITCHEN, {
    params: { doors: 2, drawers: 0, plinth: 100, worktop: true, sink: true },
    tags: ['кухня', 'мойка'],
  }),
  asset('kitchen_base_corner_900', 'Corner base unit 900', 'Угловая тумба 900', 'kitchen', 'kitchenBase', [900, 900, 900], KITCHEN, {
    params: { doors: 1, drawers: 0, plinth: 100, worktop: true, corner: true },
    tags: ['кухня', 'угловой модуль'],
  }),
  asset('kitchen_island', 'Kitchen island', 'Кухонный остров', 'kitchen', 'kitchenBase', [1800, 900, 900], KITCHEN, {
    params: { doors: 3, drawers: 0, plinth: 100, worktop: true, island: true },
    tags: ['кухня', 'остров'],
  }),

  // ── kitchen: wall units ──
  asset('kitchen_wall_400', 'Wall unit 400', 'Навесной шкаф 400', 'kitchen', 'kitchenWall', [400, 320, 720], KITCHEN, {
    mount: 'wall',
    elevation: 1400,
    params: { doors: 1 },
    tags: ['кухня', 'верхний модуль'],
  }),
  asset('kitchen_wall_600', 'Wall unit 600', 'Навесной шкаф 600', 'kitchen', 'kitchenWall', [600, 320, 720], KITCHEN, {
    mount: 'wall',
    elevation: 1400,
    params: { doors: 1 },
    tags: ['кухня', 'верхний модуль'],
  }),
  asset('kitchen_wall_800', 'Wall unit 800', 'Навесной шкаф 800', 'kitchen', 'kitchenWall', [800, 320, 720], KITCHEN, {
    mount: 'wall',
    elevation: 1400,
    params: { doors: 2 },
    tags: ['кухня', 'верхний модуль'],
  }),
  asset('kitchen_wall_glass_600', 'Glazed wall unit 600', 'Навесной шкаф со стеклом 600', 'kitchen', 'kitchenWall', [600, 320, 720], { ...KITCHEN, glass: M.glass }, {
    mount: 'wall',
    elevation: 1400,
    params: { doors: 1, glass: true },
    tags: ['кухня', 'витрина'],
  }),
  asset('kitchen_wall_hood_600', 'Wall unit over hood 600', 'Шкаф над вытяжкой 600', 'kitchen', 'kitchenWall', [600, 320, 360], KITCHEN, {
    mount: 'wall',
    elevation: 1760,
    params: { doors: 1, horizontal: true },
    tags: ['кухня', 'верхний модуль'],
  }),

  // ── kitchen: tall units & worktops ──
  asset('kitchen_tall_600', 'Tall unit 600', 'Шкаф-пенал 600', 'kitchen', 'kitchenTall', [600, 600, 2120], KITCHEN, {
    params: { doors: 2, plinth: 100 },
    tags: ['кухня', 'пенал'],
  }),
  asset('kitchen_tall_oven_600', 'Tall unit for oven 600', 'Пенал под духовой шкаф 600', 'kitchen', 'kitchenTall', [600, 600, 2120], { ...KITCHEN, glass: M.glassBlack }, {
    params: { doors: 2, plinth: 100, oven: true, microwave: true },
    tags: ['кухня', 'пенал', 'духовка'],
  }),
  asset('kitchen_tall_fridge_600', 'Tall unit for built-in fridge', 'Пенал под встроенный холодильник', 'kitchen', 'kitchenTall', [600, 600, 2120], KITCHEN, {
    params: { doors: 2, plinth: 100, fridge: true },
    tags: ['кухня', 'пенал', 'холодильник'],
  }),
  asset('worktop_2000', 'Worktop 2000', 'Столешница 2000', 'kitchen', 'worktop', [2000, 600, 40], { worktop: M.quartz }, {
    mount: 'surface',
    elevation: 860,
    tags: ['кухня', 'столешница'],
  }),
  asset('worktop_3000', 'Worktop 3000', 'Столешница 3000', 'kitchen', 'worktop', [3000, 600, 40], { worktop: M.oak }, {
    mount: 'surface',
    elevation: 860,
    tags: ['кухня', 'столешница'],
  }),
  asset('worktop_bar', 'Bar counter', 'Барная стойка', 'kitchen', 'worktop', [1600, 450, 60], { worktop: M.oak, legs: M.blackMetal }, {
    mount: 'surface',
    elevation: 1040,
    params: { legs: true },
    tags: ['барная стойка'],
  }),

  // ── storage ──
  asset('wardrobe_2door', 'Wardrobe, 2 doors', 'Шкаф двухдверный', 'storage', 'wardrobe', [1000, 600, 2200], WARDROBE, {
    params: { doors: 2, sliding: false, drawers: 0 },
    tags: ['шкаф'],
  }),
  asset('wardrobe_3door', 'Wardrobe, 3 doors', 'Шкаф трёхдверный', 'storage', 'wardrobe', [1500, 600, 2200], WARDROBE, {
    params: { doors: 3, sliding: false, drawers: 0 },
    tags: ['шкаф'],
  }),
  asset('wardrobe_sliding_1800', 'Sliding wardrobe 1800', 'Шкаф-купе 1800', 'storage', 'wardrobe', [1800, 650, 2400], WARDROBE, {
    params: { doors: 2, sliding: true, mirror: true, drawers: 0 },
    tags: ['шкаф-купе'],
  }),
  asset('wardrobe_sliding_2400', 'Sliding wardrobe 2400', 'Шкаф-купе 2400', 'storage', 'wardrobe', [2400, 650, 2400], WARDROBE, {
    params: { doors: 3, sliding: true, mirror: true, drawers: 0 },
    tags: ['шкаф-купе'],
  }),
  asset('chest_of_drawers', 'Chest of drawers', 'Комод', 'storage', 'wardrobe', [1000, 450, 850], { ...WARDROBE, front: M.oakLight }, {
    params: { doors: 0, sliding: false, drawers: 4 },
    tags: ['комод'],
  }),
  asset('nightstand', 'Nightstand', 'Прикроватная тумба', 'storage', 'wardrobe', [450, 400, 500], { ...WARDROBE, front: M.oakLight }, {
    params: { doors: 0, sliding: false, drawers: 2 },
    tags: ['тумба', 'спальня'],
  }),
  asset('tv_stand', 'TV stand', 'ТВ-тумба', 'storage', 'wardrobe', [1600, 400, 450], { ...WARDROBE, front: M.oakLight }, {
    params: { doors: 2, sliding: false, drawers: 0, legs: true },
    tags: ['тумба', 'гостиная'],
  }),
  asset('shoe_cabinet', 'Shoe cabinet', 'Обувница', 'storage', 'wardrobe', [800, 350, 1100], WARDROBE, {
    params: { doors: 2, sliding: false, drawers: 0 },
    tags: ['прихожая'],
  }),
  asset('shelf_bookcase', 'Bookcase', 'Стеллаж', 'storage', 'shelf', [800, 300, 2000], { body: M.oakLight }, {
    params: { shelves: 5, back: true },
    tags: ['стеллаж', 'книги'],
  }),
  asset('shelf_low', 'Low shelving unit', 'Стеллаж низкий', 'storage', 'shelf', [1200, 350, 800], { body: M.oakLight }, {
    params: { shelves: 2, back: true },
    tags: ['стеллаж'],
  }),
  asset('shelf_wall', 'Wall shelf', 'Полка настенная', 'storage', 'shelf', [800, 220, 40], { body: M.oak }, {
    mount: 'wall',
    elevation: 1500,
    params: { shelves: 1, back: false },
    tags: ['полка'],
  }),

  // ── beds ──
  asset('bed_single', 'Single bed 90×200', 'Кровать односпальная 90×200', 'bed', 'bed', [1000, 2100, 950], BED, {
    params: { pillows: 1, headboard: true, mattress: 220 },
    tags: ['кровать', 'спальня'],
  }),
  asset('bed_double_140', 'Double bed 140×200', 'Кровать полутораспальная 140×200', 'bed', 'bed', [1500, 2100, 1000], BED, {
    params: { pillows: 2, headboard: true, mattress: 220 },
    tags: ['кровать', 'спальня'],
  }),
  asset('bed_double_160', 'Double bed 160×200', 'Кровать двуспальная 160×200', 'bed', 'bed', [1700, 2100, 1000], BED, {
    params: { pillows: 2, headboard: true, mattress: 240 },
    tags: ['кровать', 'спальня'],
  }),
  asset('bed_double_180', 'King bed 180×200', 'Кровать двуспальная 180×200', 'bed', 'bed', [1900, 2100, 1050], BED, {
    params: { pillows: 2, headboard: true, mattress: 240 },
    tags: ['кровать', 'спальня'],
  }),
  asset('bed_kids', 'Kids bed 80×160', 'Кровать детская 80×160', 'kids', 'bed', [900, 1700, 700], { ...BED, body: M.white, legs: M.white }, {
    params: { pillows: 1, headboard: true, mattress: 140 },
    tags: ['детская'],
  }),

  // ── sofas & armchairs ──
  asset('sofa_2seat', 'Sofa, 2 seats', 'Диван двухместный', 'sofa', 'sofa', [1600, 900, 850], SOFA, {
    params: { seats: 2, corner: 'none', arms: true, back: true },
    tags: ['диван'],
  }),
  asset('sofa_3seat', 'Sofa, 3 seats', 'Диван трёхместный', 'sofa', 'sofa', [2200, 950, 850], SOFA, {
    params: { seats: 3, corner: 'none', arms: true, back: true },
    tags: ['диван'],
  }),
  asset('sofa_corner_left', 'Corner sofa, left', 'Диван угловой левый', 'sofa', 'sofa', [2600, 1700, 850], SOFA, {
    params: { seats: 3, corner: 'left', chaise: 1700, arms: true, back: true },
    tags: ['диван', 'угловой'],
  }),
  asset('sofa_corner_right', 'Corner sofa, right', 'Диван угловой правый', 'sofa', 'sofa', [2600, 1700, 850], SOFA, {
    params: { seats: 3, corner: 'right', chaise: 1700, arms: true, back: true },
    tags: ['диван', 'угловой'],
  }),
  asset('armchair', 'Armchair', 'Кресло', 'armchair', 'sofa', [850, 850, 850], { fabric: M.fabricBeige, legs: M.walnut }, {
    params: { seats: 1, corner: 'none', arms: true, back: true },
    tags: ['кресло'],
  }),
  asset('pouf', 'Pouf', 'Пуф', 'armchair', 'sofa', [500, 500, 420], { fabric: 'mat_fabric_velvet_green', legs: M.walnut }, {
    params: { seats: 1, corner: 'none', arms: false, back: false },
    tags: ['пуф'],
  }),
  asset('bench_hallway', 'Hallway bench', 'Банкетка', 'armchair', 'sofa', [1000, 400, 450], { fabric: M.fabricGrey, legs: M.blackMetal }, {
    params: { seats: 2, corner: 'none', arms: false, back: false },
    tags: ['банкетка', 'прихожая'],
  }),

  // ── tables ──
  asset('table_dining_4', 'Dining table, 4 seats', 'Стол обеденный на 4 персоны', 'table', 'table', [1200, 800, 750], TABLE, {
    params: { shape: 'rect', legs: 4 },
    tags: ['стол', 'обеденный'],
  }),
  asset('table_dining_6', 'Dining table, 6 seats', 'Стол обеденный на 6 персон', 'table', 'table', [1600, 900, 750], TABLE, {
    params: { shape: 'rect', legs: 4 },
    tags: ['стол', 'обеденный'],
  }),
  asset('table_round', 'Round table Ø1000', 'Стол круглый Ø1000', 'table', 'table', [1000, 1000, 750], TABLE, {
    params: { shape: 'round', legs: 1 },
    tags: ['стол', 'круглый'],
  }),
  asset('table_coffee', 'Coffee table', 'Журнальный столик', 'table', 'table', [1000, 600, 420], TABLE, {
    params: { shape: 'rect', legs: 4 },
    tags: ['столик', 'гостиная'],
  }),
  asset('table_coffee_round', 'Round coffee table', 'Журнальный столик круглый', 'table', 'table', [700, 700, 400], { ...TABLE, worktop: 'mat_marble_white', body: 'mat_marble_white', legs: 'mat_metal_brass' }, {
    params: { shape: 'round', legs: 3 },
    tags: ['столик', 'гостиная'],
  }),
  asset('table_console', 'Console table', 'Консоль', 'table', 'table', [1100, 350, 800], TABLE, {
    params: { shape: 'rect', legs: 4 },
    tags: ['консоль', 'прихожая'],
  }),
  asset('desk', 'Desk', 'Письменный стол', 'office', 'table', [1400, 700, 750], { body: M.oakLight, worktop: M.oakLight, legs: M.whiteMetal }, {
    params: { shape: 'rect', legs: 4 },
    tags: ['стол', 'кабинет'],
  }),
  asset('table_bar', 'Bar table', 'Барный стол', 'table', 'table', [1200, 600, 1050], TABLE, {
    params: { shape: 'rect', legs: 4 },
    tags: ['стол', 'барный'],
  }),

  // ── chairs ──
  asset('chair_dining', 'Dining chair', 'Стул', 'chair', 'chair', [450, 520, 850], CHAIR, {
    params: { seatHeight: 460, arms: false, back: true },
    tags: ['стул'],
  }),
  asset('chair_bar', 'Bar stool', 'Барный стул', 'chair', 'chair', [420, 450, 1050], { ...CHAIR, legs: M.blackMetal }, {
    params: { seatHeight: 750, arms: false, back: true },
    tags: ['стул', 'барный'],
  }),
  asset('chair_office', 'Office chair', 'Офисное кресло', 'office', 'chair', [620, 620, 1150], { body: M.plasticBlack, fabric: 'mat_fabric_graphite', legs: M.chrome }, {
    params: { seatHeight: 480, arms: true, back: true, type: 'office' },
    tags: ['кресло', 'кабинет'],
  }),
  asset('stool', 'Stool', 'Табурет', 'chair', 'chair', [380, 380, 450], CHAIR, {
    params: { seatHeight: 450, arms: false, back: false },
    tags: ['табурет'],
  }),

  // ── appliances ──
  asset('fridge', 'Fridge-freezer', 'Холодильник', 'appliance', 'fridge', [600, 650, 1900], APPLIANCE_STEEL, {
    params: { doors: 2, sideBySide: false },
    tags: ['кухня', 'холодильник'],
  }),
  asset('fridge_white', 'Fridge-freezer, white', 'Холодильник белый', 'appliance', 'fridge', [600, 650, 1850], APPLIANCE, {
    params: { doors: 2, sideBySide: false },
    tags: ['кухня', 'холодильник'],
  }),
  asset('fridge_side_by_side', 'Side-by-side fridge', 'Холодильник Side-by-Side', 'appliance', 'fridge', [910, 700, 1780], APPLIANCE_STEEL, {
    params: { doors: 2, sideBySide: true },
    tags: ['кухня', 'холодильник'],
  }),
  asset('stove', 'Freestanding cooker', 'Плита', 'appliance', 'stove', [600, 600, 850], { ...APPLIANCE, glass: M.glassBlack }, {
    params: { burners: 4, type: 'gas', builtIn: false },
    tags: ['кухня', 'плита'],
  }),
  asset('hob', 'Induction hob', 'Варочная панель', 'appliance', 'stove', [590, 520, 50], { body: M.glassBlack, glass: M.glassBlack, metal: M.steel }, {
    mount: 'surface',
    elevation: 900,
    params: { burners: 4, type: 'induction', builtIn: true },
    tags: ['кухня', 'варочная панель'],
  }),
  asset('oven', 'Built-in oven', 'Духовой шкаф', 'appliance', 'oven', [595, 560, 595], APPLIANCE_STEEL, {
    elevation: 150,
    params: { microwave: false },
    tags: ['кухня', 'духовка'],
  }),
  asset('microwave', 'Microwave oven', 'Микроволновая печь', 'appliance', 'oven', [480, 360, 280], APPLIANCE_STEEL, {
    mount: 'surface',
    elevation: 900,
    params: { microwave: true },
    tags: ['кухня', 'свч'],
  }),
  asset('hood', 'Chimney hood', 'Вытяжка купольная', 'appliance', 'hood', [600, 500, 800], { body: M.steel, metal: M.steel, glass: M.glassBlack }, {
    mount: 'wall',
    elevation: 1600,
    params: { type: 'chimney' },
    tags: ['кухня', 'вытяжка'],
  }),
  asset('hood_flat', 'Built-under hood', 'Вытяжка встраиваемая', 'appliance', 'hood', [600, 300, 150], { body: M.steel, metal: M.steel, glass: M.glassBlack }, {
    mount: 'wall',
    elevation: 1600,
    params: { type: 'flat' },
    tags: ['кухня', 'вытяжка'],
  }),
  asset('dishwasher_600', 'Dishwasher 600', 'Посудомоечная машина 600', 'appliance', 'dishwasher', [600, 600, 850], APPLIANCE, {
    tags: ['кухня', 'посудомойка'],
  }),
  asset('dishwasher_450', 'Dishwasher 450', 'Посудомоечная машина 450', 'appliance', 'dishwasher', [450, 600, 850], APPLIANCE, {
    tags: ['кухня', 'посудомойка'],
  }),
  asset('washing_machine', 'Washing machine', 'Стиральная машина', 'appliance', 'washingMachine', [600, 550, 850], APPLIANCE, {
    params: { dryer: false },
    tags: ['ванная', 'стиральная'],
  }),
  asset('washing_machine_slim', 'Washing machine, slim', 'Стиральная машина узкая', 'appliance', 'washingMachine', [600, 400, 850], APPLIANCE, {
    params: { dryer: false },
    tags: ['ванная', 'стиральная'],
  }),
  asset('dryer', 'Tumble dryer', 'Сушильная машина', 'appliance', 'washingMachine', [600, 600, 850], APPLIANCE, {
    params: { dryer: true },
    tags: ['ванная', 'сушильная'],
  }),
  asset('air_conditioner', 'Air conditioner, indoor unit', 'Кондиционер', 'appliance', 'airConditioner', [800, 200, 290], { body: M.plasticWhite }, {
    mount: 'wall',
    elevation: 2300,
    params: { outdoor: false },
    tags: ['кондиционер', 'сплит'],
  }),
  asset('air_conditioner_outdoor', 'Air conditioner, outdoor unit', 'Наружный блок кондиционера', 'outdoor', 'airConditioner', [800, 300, 550], { body: M.whiteMetal, metal: M.blackMetal }, {
    mount: 'wall',
    elevation: 500,
    params: { outdoor: true },
    tags: ['кондиционер', 'балкон'],
  }),
  asset('radiator_800', 'Radiator 800', 'Радиатор 800', 'appliance', 'radiator', [800, 90, 500], { body: M.whiteMetal }, {
    mount: 'wall',
    elevation: 150,
    params: { sections: 10, type: 'sectional' },
    tags: ['отопление', 'батарея'],
  }),
  asset('radiator_1200', 'Radiator 1200', 'Радиатор 1200', 'appliance', 'radiator', [1200, 90, 500], { body: M.whiteMetal }, {
    mount: 'wall',
    elevation: 150,
    params: { sections: 15, type: 'sectional' },
    tags: ['отопление', 'батарея'],
  }),
  asset('towel_rail', 'Heated towel rail', 'Полотенцесушитель', 'bathroom', 'radiator', [500, 100, 800], { body: M.chrome }, {
    mount: 'wall',
    elevation: 900,
    params: { sections: 8, type: 'ladder' },
    tags: ['ванная', 'полотенцесушитель'],
  }),

  // ── electronics ──
  asset('tv_43', 'TV 43"', 'Телевизор 43"', 'electronics', 'tv', [960, 60, 560], { body: M.plasticBlack, screen: M.glassBlack }, {
    mount: 'wall',
    elevation: 1000,
    params: { stand: false },
    tags: ['телевизор'],
  }),
  asset('tv_55', 'TV 55"', 'Телевизор 55"', 'electronics', 'tv', [1230, 60, 710], { body: M.plasticBlack, screen: M.glassBlack }, {
    mount: 'wall',
    elevation: 950,
    params: { stand: false },
    tags: ['телевизор'],
  }),
  asset('tv_65', 'TV 65"', 'Телевизор 65"', 'electronics', 'tv', [1450, 60, 830], { body: M.plasticBlack, screen: M.glassBlack }, {
    mount: 'wall',
    elevation: 900,
    params: { stand: false },
    tags: ['телевизор'],
  }),
  asset('monitor', 'Monitor 27"', 'Монитор 27"', 'electronics', 'tv', [610, 200, 450], { body: M.plasticBlack, screen: M.glassBlack }, {
    mount: 'surface',
    elevation: 750,
    params: { stand: true },
    tags: ['монитор', 'кабинет'],
  }),

  // ── kitchen sink ──
  asset('sink_kitchen', 'Kitchen sink', 'Мойка кухонная', 'kitchen', 'sink', [780, 500, 400], { body: M.steel, metal: M.chrome }, {
    mount: 'surface',
    elevation: 720,
    params: { bowls: 1, faucet: true, bowlDepth: 180 },
    tags: ['кухня', 'мойка'],
  }),
  asset('sink_kitchen_double', 'Kitchen sink, double bowl', 'Мойка кухонная двойная', 'kitchen', 'sink', [1160, 500, 400], { body: M.steel, metal: M.chrome }, {
    mount: 'surface',
    elevation: 720,
    params: { bowls: 2, faucet: true, bowlDepth: 180 },
    tags: ['кухня', 'мойка'],
  }),

  // ── bathroom ──
  asset('toilet', 'Toilet', 'Унитаз', 'bathroom', 'toilet', [370, 650, 780], { body: M.ceramic, metal: M.chrome }, {
    params: { type: 'floor', tank: true },
    tags: ['санузел', 'унитаз'],
  }),
  asset('toilet_wall_hung', 'Wall-hung toilet', 'Унитаз подвесной', 'bathroom', 'toilet', [360, 540, 420], { body: M.ceramic, metal: M.chrome }, {
    params: { type: 'wallHung', tank: false },
    tags: ['санузел', 'унитаз', 'инсталляция'],
  }),
  asset('bidet', 'Bidet', 'Биде', 'bathroom', 'toilet', [370, 560, 400], { body: M.ceramic, metal: M.chrome }, {
    params: { type: 'bidet', tank: false },
    tags: ['санузел', 'биде'],
  }),
  asset('bathtub_150', 'Bathtub 150×70', 'Ванна 150×70', 'bathroom', 'bathtub', [1500, 700, 600], { body: M.acrylic, metal: M.chrome }, {
    params: { freestanding: false, faucet: true },
    tags: ['ванная', 'ванна'],
  }),
  asset('bathtub_170', 'Bathtub 170×70', 'Ванна 170×70', 'bathroom', 'bathtub', [1700, 700, 600], { body: M.acrylic, metal: M.chrome }, {
    params: { freestanding: false, faucet: true },
    tags: ['ванная', 'ванна'],
  }),
  asset('bathtub_freestanding', 'Freestanding bathtub', 'Ванна отдельностоящая', 'bathroom', 'bathtub', [1700, 800, 600], { body: M.acrylic, metal: M.chrome }, {
    params: { freestanding: true, faucet: true },
    tags: ['ванная', 'ванна'],
  }),
  asset('shower_90', 'Shower enclosure 90×90', 'Душевая кабина 90×90', 'bathroom', 'shower', [900, 900, 2000], { body: M.acrylic, glass: M.glass, metal: M.chrome }, {
    params: { tray: true, doors: true },
    tags: ['ванная', 'душ'],
  }),
  asset('shower_120', 'Shower enclosure 120×80', 'Душевая кабина 120×80', 'bathroom', 'shower', [1200, 800, 2000], { body: M.acrylic, glass: M.glass, metal: M.chrome }, {
    params: { tray: true, doors: true },
    tags: ['ванная', 'душ'],
  }),
  asset('shower_walk_in', 'Walk-in shower screen', 'Душевая перегородка (walk-in)', 'bathroom', 'shower', [1200, 900, 2000], { body: M.acrylic, glass: M.glass, metal: M.blackMetal }, {
    params: { tray: false, doors: false },
    tags: ['ванная', 'душ'],
  }),
  asset('washbasin_60', 'Washbasin with vanity 60', 'Раковина с тумбой 60', 'bathroom', 'washbasin', [600, 460, 850], { body: M.ceramic, front: M.oakLight, metal: M.chrome }, {
    params: { vanity: true, pedestal: false, bowls: 1 },
    tags: ['ванная', 'раковина'],
  }),
  asset('washbasin_80', 'Washbasin with vanity 80', 'Раковина с тумбой 80', 'bathroom', 'washbasin', [800, 460, 850], { body: M.ceramic, front: M.oakLight, metal: M.chrome }, {
    params: { vanity: true, pedestal: false, bowls: 1 },
    tags: ['ванная', 'раковина'],
  }),
  asset('washbasin_double_120', 'Double washbasin 120', 'Раковина двойная 120', 'bathroom', 'washbasin', [1200, 480, 850], { body: M.ceramic, front: M.oakLight, metal: M.chrome }, {
    params: { vanity: true, pedestal: false, bowls: 2 },
    tags: ['ванная', 'раковина'],
  }),
  asset('washbasin_pedestal', 'Pedestal washbasin', 'Раковина «тюльпан»', 'bathroom', 'washbasin', [550, 450, 850], { body: M.ceramic, front: M.ceramic, metal: M.chrome }, {
    params: { vanity: false, pedestal: true, bowls: 1 },
    tags: ['ванная', 'раковина'],
  }),

  // ── textile & decor ──
  asset('rug_160x230', 'Rug 160×230', 'Ковёр 160×230', 'textile', 'rug', [2300, 1600, 12], { fabric: 'mat_carpet_beige' }, {
    params: { shape: 'rect' },
    tags: ['ковёр'],
  }),
  asset('rug_200x300', 'Rug 200×300', 'Ковёр 200×300', 'textile', 'rug', [3000, 2000, 12], { fabric: 'mat_carpet_grey' }, {
    params: { shape: 'rect' },
    tags: ['ковёр'],
  }),
  asset('rug_round', 'Round rug Ø160', 'Ковёр круглый Ø160', 'textile', 'rug', [1600, 1600, 12], { fabric: 'mat_carpet_beige' }, {
    params: { shape: 'round' },
    tags: ['ковёр'],
  }),
  asset('rug_runner', 'Runner 80×200', 'Ковровая дорожка 80×200', 'textile', 'rug', [2000, 800, 10], { fabric: 'mat_carpet_blue' }, {
    params: { shape: 'rect' },
    tags: ['ковёр', 'прихожая'],
  }),
  asset('mirror_wall', 'Wall mirror', 'Зеркало настенное', 'decor', 'mirror', [600, 30, 900], { glass: M.mirror, body: M.blackMetal }, {
    mount: 'wall',
    elevation: 1000,
    params: { shape: 'rect', frame: 20 },
    tags: ['зеркало'],
  }),
  asset('mirror_round', 'Round mirror Ø700', 'Зеркало круглое Ø700', 'decor', 'mirror', [700, 30, 700], { glass: M.mirror, body: 'mat_metal_brass' }, {
    mount: 'wall',
    elevation: 1150,
    params: { shape: 'round', frame: 15 },
    tags: ['зеркало'],
  }),
  asset('mirror_floor', 'Floor mirror', 'Зеркало напольное', 'decor', 'mirror', [600, 50, 1800], { glass: M.mirror, body: M.oak }, {
    params: { shape: 'rect', frame: 30 },
    tags: ['зеркало', 'прихожая'],
  }),
  asset('picture_50x70', 'Picture 50×70', 'Картина 50×70', 'decor', 'picture', [500, 30, 700], { body: M.blackMetal, canvas: 'mat_paint_sage', mat: M.paintWhite }, {
    mount: 'wall',
    elevation: 1250,
    params: { frame: 20, passepartout: 50 },
    tags: ['картина', 'постер'],
  }),
  asset('picture_landscape', 'Picture 100×70', 'Картина 100×70', 'decor', 'picture', [1000, 30, 700], { body: M.oak, canvas: 'mat_paint_dusty_blue', mat: M.paintWhite }, {
    mount: 'wall',
    elevation: 1300,
    params: { frame: 25, passepartout: 0 },
    tags: ['картина'],
  }),
  asset('picture_square', 'Picture 60×60', 'Картина 60×60', 'decor', 'picture', [600, 30, 600], { body: 'mat_metal_brass', canvas: 'mat_paint_terracotta', mat: M.paintWhite }, {
    mount: 'wall',
    elevation: 1300,
    params: { frame: 15, passepartout: 60 },
    tags: ['картина', 'постер'],
  }),

  // ── plants ──
  asset('plant_floor', 'Floor plant', 'Растение в кашпо', 'plant', 'plantPot', [500, 500, 1400], { body: M.ceramic, foliage: 'mat_other_foliage', soil: 'mat_other_soil' }, {
    params: { plant: 'ficus' },
    tags: ['растение', 'цветок'],
  }),
  asset('plant_palm', 'Palm', 'Пальма', 'plant', 'plantPot', [800, 800, 1800], { body: 'mat_concrete_light', foliage: 'mat_other_foliage', soil: 'mat_other_soil' }, {
    params: { plant: 'palm' },
    tags: ['растение', 'пальма'],
  }),
  asset('plant_small', 'Table plant', 'Растение настольное', 'plant', 'plantPot', [250, 250, 350], { body: 'mat_paint_terracotta', foliage: 'mat_other_foliage', soil: 'mat_other_soil' }, {
    mount: 'surface',
    elevation: 750,
    params: { plant: 'bush' },
    tags: ['растение', 'цветок'],
  }),
]

// ───────────────────────────── openings, rooms, curtains ─────────────────────────────

export const OPENING_DEFAULTS: Record<OpeningKind, { width: number; height: number; sill: number }> = {
  door: { width: 800, height: 2100, sill: 0 },
  doubleDoor: { width: 1300, height: 2100, sill: 0 },
  slidingDoor: { width: 900, height: 2100, sill: 0 },
  entranceDoor: { width: 900, height: 2100, sill: 0 },
  arch: { width: 1000, height: 2200, sill: 0 },
  opening: { width: 900, height: 2100, sill: 0 },
  window: { width: 1400, height: 1400, sill: 850 },
  frenchWindow: { width: 1600, height: 2200, sill: 50 },
  balconyDoor: { width: 750, height: 2150, sill: 50 },
  balconyBlock: { width: 2100, height: 2150, sill: 50 },
}

export const ROOM_TYPE_NAMES: Record<RoomType, { ru: string; en: string }> = {
  living: { ru: 'Гостиная', en: 'Living room' },
  bedroom: { ru: 'Спальня', en: 'Bedroom' },
  kitchen: { ru: 'Кухня', en: 'Kitchen' },
  kitchenLiving: { ru: 'Кухня-гостиная', en: 'Kitchen-living room' },
  bathroom: { ru: 'Ванная', en: 'Bathroom' },
  toilet: { ru: 'Туалет', en: 'Toilet' },
  hallway: { ru: 'Прихожая', en: 'Hallway' },
  corridor: { ru: 'Коридор', en: 'Corridor' },
  balcony: { ru: 'Балкон', en: 'Balcony' },
  loggia: { ru: 'Лоджия', en: 'Loggia' },
  wardrobe: { ru: 'Гардеробная', en: 'Walk-in wardrobe' },
  office: { ru: 'Кабинет', en: 'Office' },
  kids: { ru: 'Детская', en: 'Kids room' },
  storage: { ru: 'Кладовая', en: 'Storage' },
  other: { ru: 'Комната', en: 'Room' },
}

export function defaultCurtain(): CurtainSpec {
  return {
    kind: 'drapesAndSheer',
    materialId: DEFAULT_MATERIALS.curtain,
    sheerMaterialId: DEFAULT_MATERIALS.sheer,
    closed: 0.3,
    side: 'left',
    overhang: 200,
    fullHeight: true,
  }
}

export function defaultWallSide(): WallSide {
  return { materialId: DEFAULT_MATERIALS.wall }
}

export function defaultRoom(levelId: Id, anchor: Vec2): Room {
  return {
    id: newId('r'),
    levelId,
    anchor: { x: anchor.x, y: anchor.y },
    name: ROOM_TYPE_NAMES.other.ru,
    type: 'other',
    floor: { materialId: DEFAULT_MATERIALS.floor },
    ceiling: { materialId: DEFAULT_MATERIALS.ceiling, kind: 'flat' },
    skirting: 80,
    skirtingMaterialId: DEFAULT_MATERIALS.skirting,
  }
}

// ───────────────────────────── document ─────────────────────────────

export const DEFAULT_WALL_HEIGHT = 2700
export const DEFAULT_WALL_THICKNESS = 200

export function defaultSettings(): DocSettings {
  return {
    gridMm: 100,
    snapGrid: true,
    snapObjects: true,
    snapAngle: true,
    wallThickness: DEFAULT_WALL_THICKNESS,
    wallHeight: DEFAULT_WALL_HEIGHT,
    showDimensions: true,
    showAreas: true,
    showFurniture2d: true,
    showItemSizes: true,
    units: 'mm',
  }
}

export function defaultRenderSettings(): RenderSettings {
  return {
    quality: 'medium',
    sunAzimuth: 135,
    sunElevation: 40,
    sunIntensity: 1,
    timeOfDay: 14,
    sunAuto: false,
    north: 0,
    hdriIntensity: 1,
    hdriRotation: 0,
    exposure: 1,
    toneMapping: 'agx',
    ao: true,
    ssgi: false,
    ssr: false,
    bloom: false,
    wallCutaway: true,
    ceilingVisible: false,
    lightsOn: true,
  }
}

export function defaultLevel(name = 'Этаж 1', elevation = 0, height = DEFAULT_WALL_HEIGHT): Level {
  return { id: newId('lv'), name, elevation, height, visible: true }
}

/** New empty project: one level 'Этаж 1', default settings and render settings. */
export function createEmptyDoc(name = 'Новый проект'): Doc {
  const level = defaultLevel()
  const now = new Date().toISOString()
  return {
    version: DOC_VERSION,
    meta: { name, createdAt: now, modifiedAt: now, app: 'doplan' },
    settings: defaultSettings(),
    render: defaultRenderSettings(),
    levelOrder: [level.id],
    levels: { [level.id]: level },
    nodes: {},
    walls: {},
    openings: {},
    rooms: {},
    items: {},
    lights: {},
    dimensions: {},
    labels: {},
    underlays: {},
    cameras: {},
    materials: {},
    assets: {},
  }
}

/**
 * Catalog names that carry the default width in mm ("Тумба под мойку 800") follow the item's
 * current width ("Тумба под мойку 600"). Names without that number are returned unchanged.
 */
export function sizedCatalogName(name: string, defaultW: number, w: number): string {
  const dw = Math.round(defaultW)
  const cw = Math.round(w)
  if (!name || dw === cw) return name
  const re = new RegExp(`(^|\\s)${dw}(?=$|\\s)`)
  return re.test(name) ? name.replace(re, `$1${cw}`) : name
}
