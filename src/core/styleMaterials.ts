/**
 * Materials the built-in interior styles (core/styles.ts) need on top of the base palette:
 * paints with NCS / RAL codes and a few finishes and fabrics (travertine, terrazzo, zellige, bouclé…).
 * Plain data, appended to BUILTIN_MATERIALS. The hex of a coded paint is an on-screen approximation.
 */
import type { ColorCode, Material, MaterialCategory, TilePattern, TilePatternType } from './types'

const APPROX_TAG = 'приближённый цвет'

function pat(type: TilePatternType, tileW: number, tileH: number, grout: number, groutColor: string, extra?: Partial<TilePattern>): TilePattern {
  return { type, tileW, tileH, grout, groutColor, rotation: 0, ...extra }
}

function mat(id: string, name: string, nameRu: string, category: MaterialCategory, color: string, roughness: number, metalness = 0, extra?: Partial<Material>): Material {
  return { id: `mat_${id}`, name, nameRu, category, color, roughness, metalness, source: 'builtin', licence: 'CC0', ...extra }
}

/** a paint with a colour-system code; the name carries the code so plain pickers show it */
function coded(system: 'NCS' | 'RAL', code: string, name: string, nameRu: string, color: string): Material {
  const slug = code.replace(/^S\s+/, '').replace(/[^0-9A-Za-z]+/g, '_').toLowerCase()
  const colorCode: ColorCode = { system, code }
  const label = system === 'NCS' ? `NCS ${code}` : `RAL ${code}`
  return mat(`${system.toLowerCase()}_${slug}`, `${name} (${label})`, `${nameRu} (${label})`, 'paint', color, 0.9, 0, {
    colorCode,
    tags: ['краска', 'paint', system, APPROX_TAG],
  })
}

export const STYLE_MATERIALS: Material[] = [
  // ── NCS paints ──
  coded('NCS', 'S 0500-N', 'Pure white', 'Чистый белый', '#f4f4f1'),
  coded('NCS', 'S 0502-Y', 'Warm white', 'Тёплый белый', '#f0ede3'),
  coded('NCS', 'S 1002-Y', 'Light greige', 'Светлый грейдж', '#e0ddd2'),
  coded('NCS', 'S 1505-Y40R', 'Linen beige', 'Льняной бежевый', '#ddd2c3'),
  coded('NCS', 'S 2005-Y20R', 'Greige', 'Грейдж', '#cac2b3'),
  coded('NCS', 'S 2020-Y30R', 'Sand', 'Песочный', '#cdb79b'),
  coded('NCS', 'S 3005-Y20R', 'Clay grey', 'Глиняный серый', '#b1a99b'),
  coded('NCS', 'S 4005-Y20R', 'Taupe', 'Тауп', '#9b9385'),
  coded('NCS', 'S 2010-G30Y', 'Sage', 'Шалфей', '#b9c0a6'),
  coded('NCS', 'S 3010-G50Y', 'Olive grey', 'Оливково-серый', '#a8a98d'),
  coded('NCS', 'S 2010-R90B', 'Dusty blue', 'Пыльно-голубой', '#b5c1cb'),
  coded('NCS', 'S 5020-B50G', 'Teal', 'Бирюзово-петроль', '#4e706d'),
  coded('NCS', 'S 6020-B', 'Deep blue', 'Глубокий синий', '#3e5469'),
  coded('NCS', 'S 2060-Y20R', 'Mustard', 'Горчичный', '#d0a04b'),
  coded('NCS', 'S 4040-Y70R', 'Terracotta', 'Терракота', '#a1613f'),
  coded('NCS', 'S 7502-B', 'Graphite', 'Графит', '#3e4145'),
  // ── RAL Classic paints ──
  coded('RAL', '9010', 'Pure white', 'Белый', '#f1ece1'),
  coded('RAL', '9016', 'Traffic white', 'Транспортный белый', '#f1f0ea'),
  coded('RAL', '9001', 'Cream', 'Кремово-белый', '#e9e0d2'),
  coded('RAL', '1013', 'Oyster white', 'Жемчужно-белый', '#e3d9c6'),
  coded('RAL', '1015', 'Light ivory', 'Светлая слоновая кость', '#e6d2b5'),
  coded('RAL', '7044', 'Silk grey', 'Шёлковисто-серый', '#b7b3a8'),
  coded('RAL', '7035', 'Light grey', 'Светло-серый', '#c5c7c4'),
  coded('RAL', '7016', 'Anthracite grey', 'Антрацит', '#383e42'),
  coded('RAL', '9005', 'Jet black', 'Чёрный', '#141416'),
  coded('RAL', '6011', 'Reseda green', 'Резедово-зелёный', '#68825b'),
  coded('RAL', '5014', 'Pigeon blue', 'Голубино-синий', '#6c7c98'),
  coded('RAL', '8017', 'Chocolate brown', 'Шоколадный', '#45322e'),

  // ── finishes ──
  mat('st_travertine', 'Travertine', 'Травертин', 'stone', '#d8c8ac', 0.6, 0, {
    pattern: pat('brick', 600, 300, 2, '#c6b597', { variation: 0.15 }),
  }),
  mat('st_terrazzo', 'Terrazzo tile', 'Плитка терраццо', 'tile', '#d9d4cb', 0.45, 0, {
    pattern: pat('grid', 600, 600, 2, '#c4beb3', { variation: 0.1 }),
  }),
  mat('st_tile_concrete', 'Porcelain tile, concrete look', 'Керамогранит под бетон', 'tile', '#8f8e8a', 0.7, 0, {
    pattern: pat('grid', 600, 600, 2, '#777673', { variation: 0.12 }),
  }),
  mat('st_tile_zellige_white', 'Zellige tile, white', 'Плитка зеллиж белая', 'tile', '#eeeae0', 0.2, 0, {
    pattern: pat('grid', 100, 100, 2, '#d9d4c8', { variation: 0.25 }),
  }),
  mat('st_tile_zellige_green', 'Zellige tile, green', 'Плитка зеллиж зелёная', 'tile', '#4f6f5f', 0.2, 0, {
    pattern: pat('grid', 100, 100, 2, '#d9d4c8', { variation: 0.3 }),
  }),
  mat('st_microcement_warm', 'Microcement, warm', 'Микроцемент тёплый', 'concrete', '#b9b0a3', 0.6),
  mat('st_parquet_oak_chevron', 'Parquet, oak chevron', 'Паркет дуб «французская ёлка»', 'parquet', '#c49a6c', 0.5, 0, {
    pattern: pat('chevron', 90, 540, 0.5, '#8a6a48', { variation: 0.25 }),
  }),
  mat('st_parquet_oak_smoked', 'Parquet, smoked oak herringbone', 'Паркет дуб копчёный «ёлочка»', 'parquet', '#7a5c44', 0.5, 0, {
    pattern: pat('herringbone', 90, 540, 0.5, '#4a3626', { variation: 0.25 }),
  }),
  mat('st_wood_oak_smoked', 'Oak, smoked', 'Дуб копчёный', 'wood', '#6e5341', 0.55),
  mat('st_wood_rattan', 'Rattan', 'Ротанг', 'wood', '#c9a874', 0.7),

  // ── fabrics & carpets ──
  mat('st_fabric_boucle_ivory', 'Bouclé, ivory', 'Букле молочное', 'fabric', '#ece6da', 1, 0, { sheen: 0.4 }),
  mat('st_fabric_boucle_taupe', 'Bouclé, taupe', 'Букле тауп', 'fabric', '#b5a898', 1, 0, { sheen: 0.4 }),
  mat('st_fabric_linen_olive', 'Linen, olive', 'Лён оливковый', 'fabric', '#8b8c63', 0.95, 0, { sheen: 0.3 }),
  mat('st_fabric_linen_terracotta', 'Linen, terracotta', 'Лён терракотовый', 'fabric', '#b46e52', 0.95, 0, { sheen: 0.3 }),
  mat('st_fabric_velvet_navy', 'Velvet, navy', 'Велюр тёмно-синий', 'fabric', '#2e3d57', 0.8, 0, { sheen: 0.9 }),
  mat('st_fabric_velvet_teal', 'Velvet, teal', 'Велюр бирюзовый', 'fabric', '#2f5f5f', 0.8, 0, { sheen: 0.9 }),
  mat('st_carpet_wool_cream', 'Wool rug, cream', 'Ковёр шерстяной кремовый', 'carpet', '#e3d9c6', 1, 0, { sheen: 0.5 }),
  mat('st_carpet_jute', 'Jute rug', 'Ковёр джутовый', 'carpet', '#b89c72', 1, 0, { sheen: 0.2 }),
]
