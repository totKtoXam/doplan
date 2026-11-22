/**
 * AI tools of the technical project album («вид и экспорт»): read the album composition and set it up.
 * Kept apart from aiTools.ts so the modular tool registry can take them over as they are.
 */
import { z } from 'zod'

export const TECH_SHEET_KINDS = [
  'title',
  'general',
  'measure',
  'demolition',
  'construction',
  'furniture',
  'floors',
  'ceilings',
  'lighting',
  'sockets',
  'plumbing',
  'underfloor',
  'elevations',
  'specOpenings',
  'specPlumbing',
  'specLights',
  'finishes',
] as const

const ids = (what: string) => z.array(z.string().min(1).max(64)).max(200).describe(what)

export const TECH_PROJECT_SHAPES = {
  get_tech_project: {
    sheet: z.number().int().min(1).max(500).optional().describe('номер листа: вернуть ещё и его изображение (PNG), чтобы посмотреть'),
    width: z.number().int().min(512).max(2000).optional().describe('ширина изображения листа, px'),
  },
  build_tech_project: {
    sheets: z
      .array(z.enum(TECH_SHEET_KINDS))
      .min(1)
      .max(TECH_SHEET_KINDS.length)
      .optional()
      .describe('листы альбома по порядку (остальные выключаются); без поля — состав не меняется'),
    format: z.enum(['A4', 'A3', 'A2']).optional(),
    orientation: z.enum(['landscape', 'portrait']).optional(),
    stage: z.enum(['ЭП', 'П', 'РП', 'Р']).optional().describe('стадия: ЭП эскизный, П проект, РП рабочий проект, Р рабочая документация'),
    code: z.string().max(60).optional().describe('шифр (обозначение) альбома'),
    object: z.string().max(200).optional().describe('название объекта в штампе и на титуле'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('дата альбома, ГГГГ-ММ-ДД'),
    levels: ids('этажи, которые рисовать (пусто — все)').optional(),
    elevationRooms: ids('помещения с развёртками стен (по умолчанию санузлы и кухни)').optional(),
    variantId: z.string().min(1).max(64).optional().describe('вариант обстановки'),
    scales: z
      .partialRecord(z.enum(TECH_SHEET_KINDS), z.number().int().min(1).max(1000).nullable())
      .optional()
      .describe('масштаб 1:S по видам листов; null — подобрать автоматически'),
    fixSurvey: z.boolean().optional().describe('зафиксировать текущий план как обмер «до ремонта» (для планов демонтажа и монтажа)'),
  },
} as const

export type TechProjectToolName = keyof typeof TECH_PROJECT_SHAPES

export const TECH_PROJECT_MUTATING: readonly TechProjectToolName[] = ['build_tech_project']

export const TECH_PROJECT_DESCRIPTIONS: Record<TechProjectToolName, string> = {
  get_tech_project:
    'Технический проект (альбом рабочих чертежей): настройки штампа, листы по порядку с номерами и масштабами, какие пусты и почему, помещения развёрток, зафиксирован ли обмер, каталог видов листов. sheet=N — ещё изображение листа N.',
  build_tech_project:
    'Собрать технический проект: задать состав и порядок листов, формат, стадию, шифр, объект, дату, этажи, помещения развёрток, масштабы; fixSurvey — зафиксировать обмер. Сохраняет настройки в проекте и возвращает состав альбома. Файлы PDF/DXF пользователь выгружает сам: Экспорт → «Технический проект…». Личные данные в штамп не вписывай.',
}

export const TECH_PROJECT_TITLES: Record<TechProjectToolName, string> = {
  get_tech_project: 'Технический проект',
  build_tech_project: 'Собрать технический проект',
}
