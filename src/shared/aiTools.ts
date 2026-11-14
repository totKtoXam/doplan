/**
 * doplan AI chat: the document tools exposed to agents (MCP server, Anthropic API provider) and
 * executed in the renderer against the open document. Single source of truth for names,
 * descriptions and argument schemas (zod 4). Pure: no DOM / Node / Electron imports.
 *
 * Coordinates are plan millimetres: x → right, y → DOWN; angles in degrees clockwise.
 */
import { z } from 'zod'

const finite = () => z.number().finite()
const mm = (what: string) => finite().describe(`${what}, мм`)
const id = (what: string) => z.string().min(1).max(64).describe(what)

const point = z.object({ x: mm('X'), y: mm('Y') }).strict()

/** a node id or a free point */
const endpoint = z.union([id('id узла (n_…)'), point]).describe('id узла (n_…) или точка {x, y} в мм')

export const WALL_KINDS = ['wall', 'partition', 'parapet', 'glazing', 'virtual'] as const
export const OPENING_KINDS = [
  'door',
  'doubleDoor',
  'slidingDoor',
  'entranceDoor',
  'arch',
  'opening',
  'window',
  'frenchWindow',
  'balconyDoor',
  'balconyBlock',
] as const
export const ROOM_TYPES = [
  'living',
  'bedroom',
  'kitchen',
  'kitchenLiving',
  'bathroom',
  'toilet',
  'hallway',
  'corridor',
  'balcony',
  'loggia',
  'wardrobe',
  'office',
  'kids',
  'storage',
  'other',
] as const

const levelId = id('id уровня (lv_…); по умолчанию активный уровень').optional()

/** Shapes of the tool arguments (zod raw shapes: the MCP SDK takes these directly). */
export const AI_TOOL_SHAPES = {
  get_plan: {
    levelId,
    detail: z.enum(['brief', 'full']).optional().describe('brief — без узлов и материалов (по умолчанию full)'),
  },
  get_selection: {},
  get_entity: { id: id('id сущности: n_/w_/o_/r_/i_/l_/…') },
  add_wall: {
    from: endpoint,
    to: endpoint,
    thickness: mm('Толщина').min(0).max(2000).optional(),
    height: mm('Высота').min(100).max(20000).optional(),
    kind: z.enum(WALL_KINDS).optional().describe('wall | partition | parapet | glazing | virtual (разделитель зон без геометрии)'),
    levelId,
  },
  add_rect_room: {
    x: mm('Левый верхний угол X (по осям стен)'),
    y: mm('Левый верхний угол Y (по осям стен)'),
    w: mm('Ширина').min(300).max(100000),
    h: mm('Глубина').min(300).max(100000),
    thickness: mm('Толщина стен').min(0).max(2000).optional(),
    name: z.string().max(80).optional().describe('Название комнаты'),
    type: z.enum(ROOM_TYPES).optional(),
    levelId,
  },
  move_node: { nodeId: id('id узла (n_…)'), x: mm('Новый X'), y: mm('Новый Y') },
  set_wall: {
    wallId: id('id стены (w_…)'),
    thickness: mm('Толщина').min(0).max(2000).optional(),
    height: mm('Высота').min(100).max(20000).optional(),
    kind: z.enum(WALL_KINDS).optional(),
    length: mm('Новая длина').min(10).max(100000).optional(),
    anchor: z.enum(['a', 'b', 'center']).optional().describe('Что остаётся на месте при смене длины (по умолчанию a)'),
  },
  delete: { ids: z.array(id('id')).min(1).max(500).describe('id удаляемых сущностей (стены удаляются вместе с проёмами)') },
  add_opening: {
    wallId: id('id стены (w_…)'),
    kind: z.enum(OPENING_KINDS),
    offset: mm('Расстояние от узла a стены до центра проёма').min(0).optional(),
    at: point.optional().describe('Альтернатива offset: точка, проецируемая на стену'),
    width: mm('Ширина').min(100).max(10000).optional(),
    height: mm('Высота').min(100).max(10000).optional(),
    sill: mm('Высота подоконника / низа проёма').min(0).max(5000).optional(),
  },
  set_room: {
    roomId: id('id комнаты (r_…)'),
    name: z.string().min(1).max(80).optional(),
    type: z.enum(ROOM_TYPES).optional(),
    floorMaterialId: id('материал пола').optional(),
    ceilingMaterialId: id('материал потолка').optional(),
    wallMaterialId: id('материал всех стен комнаты (внутренние стороны)').optional(),
    ceilingHeight: mm('Высота потолка').min(1500).max(10000).optional(),
    skirting: mm('Высота плинтуса, 0 — без плинтуса').min(0).max(300).optional(),
  },
  place_item: {
    assetId: id('id из list_catalog kind=asset'),
    x: mm('Центр X').optional(),
    y: mm('Центр Y').optional(),
    roomId: id('Поставить в центр этой комнаты, если x/y не заданы').optional(),
    rotation: finite().min(-360).max(360).optional().describe('Поворот, градусы по часовой; 0 — фасад смотрит вниз по плану (+y)'),
    elevation: mm('Высота низа над полом').min(0).max(10000).optional(),
    size: z.object({ w: mm('Ширина').min(10).max(20000), d: mm('Глубина').min(10).max(20000), h: mm('Высота').min(10).max(10000) }).strict().optional(),
    name: z.string().max(80).optional(),
    levelId,
  },
  move_item: {
    itemId: id('id предмета (i_…)'),
    x: mm('Новый центр X').optional(),
    y: mm('Новый центр Y').optional(),
    rotation: finite().min(-360).max(360).optional(),
    elevation: mm('Высота низа над полом').min(0).max(10000).optional(),
    size: z.object({ w: mm('Ширина').min(10).max(20000), d: mm('Глубина').min(10).max(20000), h: mm('Высота').min(10).max(10000) }).strict().optional(),
  },
  list_catalog: {
    kind: z.enum(['asset', 'material']).describe('asset — мебель и оборудование, material — отделка'),
    category: z.string().max(40).optional().describe('Категория, например kitchen, appliance, sofa, tile, paint'),
    query: z.string().max(80).optional().describe('Поиск по названию / тегам (рус. или англ.)'),
    limit: z.number().int().min(1).max(200).optional(),
  },
  set_material: {
    targetId: id('id комнаты, стены или предмета'),
    surface: z
      .string()
      .max(40)
      .optional()
      .describe('Комната: floor | ceiling | walls. Стена: left | right | both. Предмет: имя слота (body, front, fabric…) или пусто — все слоты'),
    materialId: id('id материала из list_catalog kind=material'),
  },
  apply_planspec: {
    spec: z.record(z.string(), z.unknown()).describe('PlanSpec v1 (см. get_planspec_schema)'),
    mode: z.enum(['replace', 'newLevel']).optional().describe('replace — заменить план активного уровня (по умолчанию), newLevel — добавить этажом'),
  },
  get_planspec_schema: {},
  apply_measurement: {
    measurements: z
      .array(
        z
          .object({
            side: z
              .string()
              .regex(/^[^:\s]+:(left|right)$/)
              .optional()
              .describe('Чистый размер: ключ стороны стены wallId:left|right (из пометки или get_plan) — длина этой стороны внутри помещения'),
            moveEnd: z.enum(['a', 'b']).optional().describe('Для side: какой конец размера сдвигать (a/b, см. концы в пометке); по умолчанию b'),
            nodes: z
              .object({ fixed: id('узел, который остаётся на месте'), move: id('узел, который сдвигается') })
              .strict()
              .optional()
              .describe('Расстояние между двумя узлами (по осям стен)'),
            length: finite().min(10).max(100000).describe('Замеренное значение, мм'),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    annotationId: id('id пометки (pm_…), к которой относятся замеры').optional(),
    note: z.string().max(200).optional().describe('Комментарий к замеру (сохраняется в источнике размера)'),
    levelId,
  },
  render_snapshot: {
    view: z.enum(['2d', '3d']).describe('2d — чертёж уровня, 3d — текущая камера 3D'),
    width: z.number().int().min(256).max(1600).optional(),
    levelId,
  },
} as const

export type AiToolName = keyof typeof AI_TOOL_SHAPES

export const AI_TOOL_NAMES = Object.keys(AI_TOOL_SHAPES) as AiToolName[]

/** Tools that change the document (approval / plan-mode apply to these). */
export const MUTATING_TOOLS: ReadonlySet<AiToolName> = new Set<AiToolName>([
  'add_wall',
  'add_rect_room',
  'move_node',
  'set_wall',
  'delete',
  'add_opening',
  'set_room',
  'place_item',
  'move_item',
  'set_material',
  'apply_planspec',
  'apply_measurement',
])

export const AI_TOOL_DESCRIPTIONS: Record<AiToolName, string> = {
  get_plan:
    'Сводка открытого плана: уровни, комнаты (площадь, тип, отделка), узлы и стены с координатами и толщиной, проёмы, предметы. Вызывай первым делом, чтобы знать id.',
  get_selection: 'Что пользователь сейчас выделил в редакторе (id и краткие данные).',
  get_entity: 'Полные данные одной сущности по id (стена, узел, проём, комната, предмет, свет…).',
  add_wall:
    'Добавить стену между двумя узлами или точками (мм). Концы прилипают к существующим узлам, пересечённые стены разбиваются. Возвращает id новых стен.',
  add_rect_room: 'Добавить прямоугольную комнату из четырёх стен (координаты по осям стен) и, по желанию, задать её имя и тип.',
  move_node: 'Переместить узел стен (концы всех присоединённых стен двигаются вместе с ним).',
  set_wall: 'Изменить толщину, высоту, тип или длину стены.',
  delete: 'Удалить сущности по id (стены, проёмы, предметы, свет, подписи…).',
  add_opening: 'Добавить дверь, окно или проём в стену: по offset от узла a или по точке at.',
  set_room: 'Изменить комнату: название, тип, материал пола/потолка/стен, высоту потолка, плинтус.',
  place_item:
    'Поставить предмет из каталога (id из list_catalog). Укажи x/y или roomId (центр комнаты). Предмет прижимай к стене сам, исходя из get_plan.',
  move_item: 'Переместить, повернуть или изменить размер предмета.',
  list_catalog: 'Поиск по каталогу мебели (asset) или материалов (material) по категории и тексту.',
  set_material: 'Назначить материал поверхности комнаты, стороне стены или слоту предмета.',
  apply_planspec:
    'Построить план из PlanSpec v1 (как импорт «План по фото»): replace — заменить план активного уровня, newLevel — добавить новым этажом.',
  get_planspec_schema: 'Описание формата PlanSpec v1 и правил распознавания планов (для apply_planspec).',
  render_snapshot: 'Снимок 2D-плана или 3D-вида в PNG, чтобы посмотреть результат.',
  apply_measurement:
    'Внести замеры рулеткой: выставить чистую длину стороны стены (side = wallId:left|right, включая глубину и ширину ниши) или расстояние между узлами. Двигается конец moveEnd (по умолчанию b), соседние стены следуют за ним; размер помечается как «замерено». Все замеры вызова — один шаг отмены. Если неясно, к какой стороне или размеру относится число (чистый или по оси), сначала спроси пользователя.',
}

export const AI_TOOL_TITLES: Record<AiToolName, string> = {
  get_plan: 'Чтение плана',
  get_selection: 'Выделение',
  get_entity: 'Данные объекта',
  add_wall: 'Добавить стену',
  add_rect_room: 'Добавить комнату',
  move_node: 'Переместить узел',
  set_wall: 'Изменить стену',
  delete: 'Удалить',
  add_opening: 'Добавить проём',
  set_room: 'Изменить комнату',
  place_item: 'Поставить предмет',
  move_item: 'Переместить предмет',
  list_catalog: 'Каталог',
  set_material: 'Назначить материал',
  apply_planspec: 'Построить план',
  get_planspec_schema: 'Формат PlanSpec',
  render_snapshot: 'Снимок',
  apply_measurement: 'Обмер',
}

const OBJECTS = Object.fromEntries(
  (Object.keys(AI_TOOL_SHAPES) as AiToolName[]).map((n) => [n, z.object(AI_TOOL_SHAPES[n]).strict()]),
) as { [K in AiToolName]: z.ZodObject<(typeof AI_TOOL_SHAPES)[K]> }

export type AiToolArgs<K extends AiToolName> = z.infer<(typeof OBJECTS)[K]>

export function isAiToolName(name: string): name is AiToolName {
  return Object.prototype.hasOwnProperty.call(AI_TOOL_SHAPES, name)
}

/** Validates tool arguments; returns parsed args or a readable Russian error. */
export function parseToolArgs<K extends AiToolName>(
  name: K,
  args: unknown,
): { ok: true; args: AiToolArgs<K> } | { ok: false; error: string } {
  const res = OBJECTS[name].safeParse(args ?? {})
  if (res.success) return { ok: true, args: res.data as AiToolArgs<K> }
  const lines = res.error.issues.slice(0, 6).map((i) => {
    const path = i.path.length ? i.path.join('.') : '(аргументы)'
    return `${path}: ${i.message}`
  })
  return { ok: false, error: `Неверные аргументы ${name}: ${lines.join('; ')}` }
}

/** JSON Schema of a tool's input (for the Anthropic Messages API). */
export function toolJsonSchema(name: AiToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(OBJECTS[name], { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>
  delete schema.$schema
  return schema
}
