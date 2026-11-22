# Room tour в doplan — исследование и предложение объёма

Дата: 2026-11-21. Основа: код doplan v0.16.2 (main, `0d1fde5`) и ветка облегчения 3D
`claude/light-3d-a18039` (трассировщик пути удалён, лёгкий режим 3D). Код не менялся.

## 1. Резюме

- В договоре «Roomtour» на рынке РФ/РК обычно означает одно из двух (часто оба): **видеооблёт
  квартиры 1–3 мин (MP4)** и **ссылку на интерактивный 360-тур** по точкам. Студии отдают это
  вместе со статичными рендерами; хронометраж и число точек фиксируют в договоре отдельно.
- У doplan уже есть почти вся основа: закладки камер, плавный переход между видами, прогулка с
  коллизиями и проходом через двери, растровые снимки высокого разрешения, опубликованный
  просмотрщик на GitHub Pages с запечённым светом, карточками элементов и 2D-планом.
- Не хватает: **маршрута** (упорядоченные остановки + путь через дверные проёмы), **покадрового
  экспорта видео**, **мини-плана с камерой**, **авторских точек интереса** (POI) и **панорам**.
- Рекомендация v1 (M–L): тур из остановок на базе `doc.cameras` → путь по центрам дверей →
  детерминированный офлайн-рендер кадров → WebCodecs + mediabunny → MP4 (H.264, запасной WebM/VP9);
  мини-план из существующего SVG-плана; POI с карточками; воспроизведение тура в просмотрщике.
- v2 (M–L): 360-панорамы 4096×2048 по остановкам, автоматические переходы (hotspots) между ними,
  «лёгкий» режим просмотрщика без загрузки 3D-сцены (удобно на слабых телефонах), экспорт ZIP
  equirect-JPEG для Kuula/3DVista/Pano2VR.
- v3 (L): озвучка и субтитры, день/ночь (второе запекание), «до/после» через варианты
  (`doc.variants` уже есть), VR только для панорам (WebXR на WebGL2-бэкенде).
- В `view3d/` нужен лишь узкий контракт «отрендерить кадр с заданной камеры в пиксели»
  (и 6 граней для панорамы); всё остальное (модель, планировщик пути, UI, мини-план, муксер,
  сшивка панорам, просмотрщик панорам) делается независимо от рефакторинга 3D.

## 2. Сравнение сервисов

Обозначения: ✓ есть; ~ частично/иначе; — нет; н/д — не удалось подтвердить источником.

| Сервис | Маршрут / видео | 360-точки + переходы | POI-карточки (медиа, ссылка, цена) | Мини-план / dollhouse | Озвучка / подписи | День/ночь | До/после | VR | Встраивание / форматы |
|---|---|---|---|---|---|---|---|---|---|
| Matterport | ~ guided tour / highlight reel в плеере, AI Auto-Tours (бета) | ✓ сканы, переходы | ✓ Tags: текст, ссылки, видео/картинки (Embedly), «магазин» | ✓ Dollhouse + Floor Plan, подписи комнат | ~ описания остановок, медиа в тегах | — | н/д | ~ | iframe, SDK |
| Kuula | — | ✓ hotspots | ✓ interactive cards, labels | ✓ floor plan с hotspots, в меню плеера | ✓ фоновое аудио | — | н/д | ✓ WebXR, гейз-навигация | iframe; equirect |
| 3DVista VT Pro | ~ автоповорот/последовательность | ✓ | ✓ hotspots: фото, окно покупки, 3D-модель | ✓ floorplan (не в VR) | ✓ звук | — | н/д | ✓ Quest/Pico/HTC | HTML5 self-hosted; live guided tours (видеозвонок) |
| Pano2VR 7–8 | — | ✓ | ✓ hotspots (в т.ч. PDF, web-элемент) | ✓ tour map, floor plan | ✓ | — | н/д | ✓ WebXR | HTML5 self-hosted |
| Marzipano (библ.) | — | ✓ API hotspots | своими силами | своими силами | своими силами | — | — | — | equirect, кубические multires-тайлы |
| Cupix | ~ 360-видео → тур | ✓ | ✓ 3D-аннотации | ✓ 3D-карта | — | — | ✓ split-screen по датам, BIM-оверлей | н/д | облачный SiteView |
| Planner 5D PRO | ~ «3D/VR walkthrough» | ✓ 360 Walkthrough, до 5 камер, авторасстановка | — | — | — | ~ выбор солнца | — | ~ | ссылка, e-mail |
| Roomtodo | н/д | ✓ 360-панорамы (сторонние обзоры) | — | — | — | н/д | — | н/д | ссылка; GLB/OBJ/FBX/DXF |
| Coohom | ✓ roaming video: до 3 путей камеры, облачный рендер (часы), токены | ✓ 720° тур, scene-hotspots, редактор порядка | ~ | ~ | — | ~ | — | ~ | ссылка |
| Enscape | ✓ video path по ключевым кадрам, время суток в ключе → MP4 | ✓ моно/стерео панорамы | — | — | — | ✓ в ключах видео | — | ✓ Cardboard/стерео | web standalone, EXE |
| Twinmotion | ✓ секвенсор, 360-видео (PNG/MP4/EXR) | ✓ Panorama Sets до 100 шт., 2K–16K | — | — | — | ✓ | — | ✓ | Twinmotion Cloud |
| Floorplanner | н/д | н/д | н/д | ✓ (сам продукт — план) | н/д | н/д | н/д | н/д | н/д |

Выводы для doplan:
1. **Видео** — сильная сторона десктопных рендереров (Enscape, Twinmotion) и облачного Coohom
   (часы ожидания, токены). Мы можем дать «мгновенное» видео на лёгком рендере с запечённым светом.
2. **360-тур с hotspots и планом** — стандарт веб-туров (Kuula, 3DVista, Pano2VR, Matterport).
   У нас 3D-модель есть, поэтому позиции точек и переходы между ними вычисляются автоматически,
   без ручной расстановки hotspots — то, что в этих сервисах делают руками.
3. **Карточки с ценой/ссылкой** есть у Matterport (Tags) и 3DVista; у нас данные о товарах уже
   лежат в `ProductRef`, но политика публикации их вырезает — нужна явная галочка автора.
4. **До/после** в чистом виде есть только у Cupix (сравнение по датам). Наши варианты отделки
   (`DocVariants`) дают это почти бесплатно для панорам.
5. **Как сдают заказчику (РФ/РК)**: статичные рендеры по комнатам на листах альбома + видеоролик
   (хронометраж оговаривается отдельно, часто это допуслуга) + ссылка на 360/«720»-тур,
   открываемый с телефона. Для договора стоит зафиксировать: длительность ролика, разрешение
   (1080p/4K), число 360-точек, формат передачи (MP4 + ссылка), число правок.

## 3. Что уже есть в doplan (проверено по коду)

| Возможность | Где | Заметки для тура |
|---|---|---|
| Режимы камеры orbit / walk / top | `src/renderer/src/view3d/controls.ts` | `EYE_HEIGHT = 1.6` м, `WALK_SPEED 1.4`, `RUN_SPEED 3.6` м/с; коллизия по 2D-стенам (`Solid`), проёмы `PASSABLE` (двери, арки, балконные блоки) проходимы |
| Плавный переход к виду | `controls.ts` `setView(pos, target, fov, animate)`, `Transition`, `easeInOut` (кубический), `TRANSITION_SEC 0.55` | Прямая интерполяция позиции + slerp кватерниона; через стены не обходит — для тура нужен путь |
| Закладки камер | `CameraBookmark` в `src/core/types.ts` (≈стр. 749): `id, name, position/target [м], fov, mode: 'orbit'|'walk'`; `Doc.cameras`; чтение в `src/core/io.ts` (≈1066) | Готовая основа «остановок»; общие для всех вариантов отделки |
| UI закладок | `src/renderer/src/ui/panels/RenderPanel.tsx` `BookmarksSection` (≈258–343): сохранить, применить, переименовать, перезаписать, удалить | Нет порядка, длительностей, подписей |
| Снимок | `actions/export.ts` `renderStill` → `engine.renderStill` → `renderRealtimeStill` (`view3d/engine.ts` ≈815): `post.renderToTarget` в `RenderTarget`, `readTarget`, суперсэмплинг ×2 до 4096, лимит 8192 | Именно этот путь нужен для кадров видео/граней панорамы, но без `toBlob` и `whenIdle` на каждый кадр |
| GLB | `actions/export.ts` `exportGlb`, `view3d/export.ts` | Для Kuula/Sketchfab не нужен; полезен как резерв |
| План в SVG | `src/core/display.ts` `buildDisplayList`, `src/core/export/svg.ts` `toSvg` | Мини-план: `furniture`, `dimensions`, `titleBlock` выключить |
| Геометрия плана | `src/core/derive.ts` `derivePlan` → `DerivedPlan {wallGeoms, rooms[], bounds}`; `DerivedRoom.polygon/roomId`; `Opening {wallId, kind, offset (центр от узла a), width}` | Граф «комната — дверь — комната» строится в core |
| Координаты | план (x, y) мм → мир (x/1000, h, y/1000) м | См. `controls.ts` ≈433, 554 |
| Освещение | `RenderSettings`: `timeOfDay`, `sunAuto`, `sunAzimuth/Elevation`, `lightsOn`; запекание `view3d/bake/*`, `publish/bake.ts` (WebP-страницы + `bake.json` по уровням) | Ночь = второе запекание; запечённый свет показывается, пока сцена «как запечена» |
| Варианты отделки | `Doc.variants`, `core/variants.ts`, `materializeVariant` | Основа «до/после»; публикация отдаёт только активный вариант |
| Просмотрщик (Pages) | `src/renderer/src/viewer/` | См. ниже |
| Публикация | `src/renderer/src/publish/` (`prepare.ts`, `optimize.ts` в воркере, `bake.ts`, `preview.ts`), `src/shared/pagesSite.ts` (`planSite`, `viewDoc`, `ViewerParams`) | `viewDoc` вырезает `product`, прайс-лист, заметки, неактивные варианты; `cameras` сохраняет |

Просмотрщик сегодня (`viewer/ViewerApp.tsx`, `ViewerTools.tsx`):
- виды 2D/3D, камеры `orbit | walk | top` (`?view=3d&cam=walk`), мобильный стик `WalkStick.tsx`,
  подсказка захвата мыши, качество с запоминанием (`viewer/quality.ts`), срез стен, потолок;
- **карточки элементов** (`viewer/elementInfo.ts`): клик по стене/проёму/комнате/предмету/свету/
  электроточке → имя, тип, размеры (мм, м², м), материал; **намеренно без цен, ссылок и заметок**;
- **линейка** и «расстояние до…» (`viewer/distance.ts`) с привязкой к углам и рёбрам;
- **фильтры** (`viewer/hideState.ts`): скрыть объект или категорию — мебель, освещение, двери и
  проёмы, окна, электрика; потолок; состояние в hash URL (`#hide=…&cats=…&ceil=0`);
- **экспорт посетителем** (`viewer/exporters.ts`): PNG/PDF плана, PNG 3D, GLB, сам план (если разрешено);
- **запечённый свет**: манифест `assets/bake/bake.json`, страницы WebP на уровень; живой свет,
  если посетитель изменил сцену (скрыл объекты и т.п.).
- Закладки камер в просмотрщике **не показываются**, маршрутов, видео и панорам нет.

## 4. Технические варианты

### 4.1 Видео: офлайн-рендер по кадрам против записи в реальном времени

| | WebCodecs `VideoEncoder` + mediabunny, офлайн | `MediaRecorder(canvas.captureStream())` |
|---|---|---|
| Детерминизм | ✓ время = `i / fps`, ни одного пропуска | — пропуски при просадке FPS, рывки |
| Качество | любое разрешение (1080p/4K) независимо от окна, суперсэмплинг | размер канваса, адаптивный DPR портит кадр |
| Скорость | медленнее реального времени на 4K, быстрее на 1080p при лёгкой сцене | ровно реальное время, окно нельзя трогать |
| Контейнер | MP4/WebM корректный (таймстемпы, keyframes) | WebM без длительности, нужна починка |
| Код | ~300 строк + зависимость ~20–40 КБ | ~50 строк |

Решение: **офлайн**. mp4-muxer/webm-muxer **устарели**, автор заменил их на **mediabunny**
(`Output` + `Mp4OutputFormat`/`WebMOutputFormat` + `BufferTarget`/`StreamTarget`,
`CanvasSource` или `VideoSampleSource`, `await source.add(t, dt)` — обратное давление,
`keyFrameInterval`, `hardwareAcceleration`). Поток в файл через `StreamTarget` → IPC
`api.files` (не держать 200 МБ в памяти).

Кодеки в Electron 45 (Chromium ~142):
- **H.264 (`avc1.640028`, MP4)** — лучший для заказчика (WhatsApp/Telegram/ТВ). Electron
  собирает ffmpeg с проприетарными кодеками, но **кодирование** H.264 в WebCodecs зависит от
  платформенного энкодера (Media Foundation/аппаратный на Windows) — обязательна проверка
  `VideoEncoder.isConfigSupported` при старте экспорта.
- **VP9 (WebM)** — libvpx есть всегда; запасной вариант. Минус: WebM хуже открывается на iPhone/ТВ.
- **AV1** — компактнее, но медленный софт-энкод и слабая поддержка у получателей; не по умолчанию.
- HEVC — не брать (лицензии, нестабильная поддержка).
- Битрейт: 1080p30 ≈ 8 Мбит/с → 2 мин ≈ 120 МБ; 4K30 ≈ 25–35 Мбит/с. Профиль High, GOP 2 с.

Конвейер кадра: установить камеру → `post.renderToTarget(target, w, h)` → `readTarget` (GPU→CPU)
→ `new VideoFrame(pixels, {timestamp})` или рисование в `OffscreenCanvas` (+ наложение мини-плана
и подписи 2D-канвасом) → `source.add`. Отключить адаптивный DPR, срез стен (или задать явно),
хелперы; не вызывать `whenIdle(5000)` на каждый кадр — один раз перед началом, плюс прогрев
шейдеров (на ветке light-3d уже есть `precompile.ts`).

### 4.2 Маршрут камеры

1. Остановки = закладки `walk` (для `orbit` — облёт над срезом, см. ниже).
2. Комната остановки — `pointInPolygon` по `DerivedRoom.polygon` на её уровне.
3. Граф: вершины — комнаты; рёбра — проёмы `PASSABLE` между двумя комнатами; точка прохода =
   центр проёма (`offset` вдоль оси стены от узла `a`) ± нормаль на (толщина/2 + 400 мм) с обеих
   сторон. Dijkstra по длине; внутри комнаты — прямой отрезок, при пересечении стены/мебели —
   доп. точка у центра комнаты (позже — visibility graph по полигону).
4. Кривая: `THREE.CatmullRomCurve3(points, false, 'centripetal')` (без петель на острых углах),
   высота 1600 мм, параметризация по длине дуги (`getSpacedPoints`/`getUtoTmapping`).
5. Скорость 0,6–0,9 м/с (медленнее прогулки 1,4 м/с: в видео 1,4 укачивает), разгон/торможение
   ease-in-out на 0,8 с у каждой остановки; в дверном проёме — замедление до 0,5 м/с.
6. Поворот: взгляд на точку кривой на 1,2–1,5 м впереди, сглаживание slerp с ограничением
   угловой скорости ≈ 40–60 °/с; за 1–1,5 с до остановки — переход к ориентации закладки; на
   остановке `holdSec` с лёгким панорамированием (±10°) по желанию.
7. `orbit`-закладки: дуга над квартирой (подъём на высоту обзора, вид со срезом стен) — «dollhouse»
   пролёт между этажами/вступление ролика.
8. Всё это — чистая функция `planTour(doc, plan, tour) → Pose(t)`; тестируется в vitest без GPU и
   одинаково работает в редакторе, просмотрщике и экспорте видео.

### 4.3 360-панорамы (v2)

- Рендер: 6 граней 90°, квадрат 1024–2048 px (для 4096×2048 equirect грань ≈ 1024–1365; для
  6144×3072 — ≈1536–2048, берём 2048 с запасом). Вариант A — `CubeCamera` + `CubeRenderTarget`
  из `three/webgpu`: быстро, но **мимо пост-обработки** (тонмаппинг/AO/bloom иначе, чем в снимках).
  Вариант B (рекомендуется) — 6 вызовов того же пути, что `renderRealtimeStill`, с квадратной
  камерой `fov = 90°` (или 96° с обрезкой, чтобы скрыть швы экранных эффектов): вид совпадает со
  снимками и видео.
- Сшивка в equirect: шейдер (полноэкранный TSL-проход по кубу) или **CPU в воркере**
  (8 Мпикс, билинейная выборка — доли секунды; не зависит от WebGPU/WebGL и рефакторинга).
  Учесть порядок строк WebGPU (сверху вниз) против WebGL2 (снизу вверх) при `readTarget`.
- Экранные эффекты (AO, bloom) дают швы → для панорам выключать, полагаться на запечённый свет.
- Формат хранения: equirect JPEG/WebP 2:1 (4096×2048 ≈ 1,5–3 МБ, 6144×3072 ≈ 4–6 МБ) + превью
  1024×512; для просмотрщика — по желанию 6 граней (быстрее первая отрисовка). Для внешних
  сервисов — JPEG с XMP GPano (`ProjectionType=equirectangular`), иначе Kuula/Facebook не узнают 360.
- Просмотр: `SphereGeometry` наизнанку + `MeshBasicMaterial` (или куб), FOV-зум, гироскоп на
  телефоне; переход = подлёт 0,3–0,6 с в сторону hotspot + кроссфейд двух сфер (два материала с
  `opacity`), как у Matterport. Hotspots считаются из 3D-позиций других точек → направление
  yaw/pitch, видимость — по графу дверей (не показывать точку за стеной).
- Лимиты GitHub Pages: сайт ≤ 1 ГБ, файл ≤ 100 МБ — 20 панорам по 4 МБ укладываются.

### 4.4 Мини-план

- Источник: `buildDisplayList(doc, levelId, {furniture: false, dimensions: false, grid: false,
  titleBlock: false})` → `toSvg` → `<img>`/инлайн SVG; поверх — свой `<svg>` того же viewBox:
  точка камеры + конус FOV (угол = горизонтальный FOV) + линия маршрута + номера остановок;
  клик по комнате/остановке → переход. В просмотрщике 2D-план уже есть (editor2d в режиме
  просмотра), но мини-план должен быть лёгким SVG, без PixiJS.
- В видео: тот же SVG растеризуется один раз (как `svgToPng` в `actions/export.ts`), конус
  рисуется 2D-канвасом поверх кадра в углу (опция).

## 5. Этапы

### v1 — маршрут, видео, POI, мини-план (рекомендуемый объём)

Что делает пользователь:
1. Расставляет закладки (уже умеет) → во вкладке «Тур» панели рендера собирает из них список
   остановок, перетаскивает порядок, задаёт паузу, длительность перехода (или «авто по скорости»),
   подпись («Гостиная», «Кухня — фасады МДФ эмаль»).
2. Жмёт «Просмотреть» — камера в окне 3D проезжает маршрут через двери; мини-план показывает
   положение.
3. Ставит точки интереса: клик по предмету/поверхности → карточка (заголовок, текст, фото
   товара из каталога, галочки «показывать цену/ссылку при публикации»).
4. «Экспорт видео»: 1080p/1440p/4K, 30/60 fps, MP4 (H.264) или WebM; опции: мини-план в углу,
   подписи остановок, титр с названием проекта. Прогресс-бар с отменой.
5. Публикует — в просмотрщике кнопка «Тур» (автопроигрывание с паузой/перемоткой по остановкам),
   мини-план, POI-маркеры с карточками.

Модель данных (в `src/core/types.ts`, общая для вариантов, как `cameras`):

```ts
export interface TourStop {
  id: Id
  cameraId: Id                // ссылка на CameraBookmark
  holdSec: number             // пауза на остановке, по умолчанию 3
  transitionSec?: number      // нет = по длине пути и speed
  caption?: string            // подпись (в видео и просмотрщике)
  look?: 'still' | 'pan'      // на остановке: стоять или медленно повести взгляд
}
export interface TourPoi {
  id: Id
  levelId: Id
  ref?: EntityRef             // к чему привязана (предмет, стена…); нет = свободная точка
  anchor: [number, number, number] // мир, м (точка на поверхности)
  title: string
  text?: string
  publishPrice?: boolean      // явное согласие автора: цена из ProductRef уйдёт на сайт
  publishLink?: boolean       // то же для ссылки на товар
}
export interface DocTour {
  stops: TourStop[]
  speed: number               // м/с, по умолчанию 0.75
  eyeHeight?: number          // мм, по умолчанию 1600
  route: 'doors' | 'direct'   // через дверные проёмы или напрямую
  pois?: Record<Id, TourPoi>
  video?: { width: number; height: number; fps: 24 | 30 | 60; codec: 'avc' | 'vp9' | 'av1'; minimap: boolean; captions: boolean }
}
// Doc: tour?: DocTour
```

Затронутые модули:
- `src/core/types.ts`, `src/core/io.ts` (чтение/валидация `tour`, удаление остановок с
  несуществующей камерой), `src/core/ops.ts` (удаление закладки → удалить её остановки);
- **новый** `src/core/tour.ts`: граф дверей, путь, кривая, `poseAt(t)`, длительность — чистый код
  с тестами (vitest);
- `src/shared/pagesSite.ts` `viewDoc`: пропускать `tour`, в POI подставлять цену/ссылку только
  при `publishPrice/publishLink` (сейчас `product` вырезается целиком — сохранить это правило
  по умолчанию);
- **новый** UI `src/renderer/src/ui/panels/TourSection.tsx` рядом с `BookmarksSection`
  (RenderPanel), POI-инструмент и карточка в инспекторе;
- **новый** `src/renderer/src/media/videoExport.ts` (mediabunny, проверка кодеков, поток в файл
  через `api.files`), `src/renderer/src/actions/export.ts` (`exportTourVideo`);
- **новый** `src/renderer/src/ui/tour/MiniPlan.tsx` (SVG плана + конус), переиспользуется
  в просмотрщике;
- `src/renderer/src/viewer/`: кнопка «Тур», плеер остановок, POI-маркеры (DOM поверх канваса,
  проекция позиции каждый кадр), карточка POI рядом с `ElementCard`;
- `view3d` — см. раздел 6.

Трудоёмкость: модель+io+viewDoc **S**; планировщик пути **M**; UI остановок **S**; мини-план **S**;
POI (инструмент, маркеры, карточки, публикация) **M**; экспорт видео **M**; плеер в просмотрщике
**S–M**. Итого v1 ≈ **M–L**.

Риски:
- **Кодеки**: H.264-энкодер может отсутствовать на части машин → автоматический откат на VP9/WebM
  с предупреждением; тест `isConfigSupported` в CI невозможен (нет GPU) — ручная проверка на
  Windows с iGPU и dGPU.
- **Производительность**: 4K60 × 2 мин = 7200 кадров; при 80–150 мс/кадр — 10–18 мин. По умолчанию
  1080p30 (3600 кадров ≈ 2–5 мин). Только лёгкий режим + запечённый свет, без тяжёлых эффектов.
- **Читка GPU→CPU** на каждом кадре — узкое место; держать 2–3 кадра в полёте, не ждать
  `onSubmittedWorkDone` синхронно.
- **Память**: потоковая запись, не `BufferTarget`, для роликов > 100 МБ.
- **Запечённый свет и вид**: ролик должен совпадать с запечённым состоянием (скрытые объекты и
  срез стен меняют свет) — фиксировать состояние на время экспорта.
- **Путь**: квартиры с проходными комнатами без дверей (проём `opening`/`arch` учтены), лоджии
  через балконный блок, двухуровневые — пока один уровень на маршрут (межэтажный переход —
  orbit-пролёт).
- **Укачивание**: ограничить угловую скорость и ускорения; предпросмотр в редакторе обязателен.

### v2 — 360-панорамы по точкам с переходами

Что делает пользователь: отмечает остановки «панорама» (или «все остановки»), жмёт «Рендер
панорам» (≈ 1–3 с на точку), при публикации выбирает «360-тур»: посетитель открывает ссылку,
видит первую панораму, стрелки/кружки на полу к соседним точкам, мини-план с точками и
направлением взгляда, POI-маркеры; кнопка «Открыть 3D» ведёт в полный просмотрщик.
Дополнительно: «Скачать панорамы (ZIP)» — equirect JPEG с GPano + `tour.json` для загрузки в
Kuula/3DVista/Pano2VR.

Модель данных:

```ts
export interface TourStop {           // + к v1
  // …
  pano?: boolean                      // делать панораму в этой точке
  panoYaw?: number                    // начальный азимут взгляда, град
}
export interface DocTour {            // + к v1
  // …
  pano?: { size: 4096 | 6144; format: 'jpeg' | 'webp'; quality: number }
}
// Рендеры панорам — не в документе, а в кэше проекта (рядом с .doplan) и в assets сайта:
// assets/tour/<stopId>.jpg, assets/tour/tour.json { stops: [{id, pos, yaw, links: [{to, yaw, pitch}]}] }
```

Модули: `view3d` — рендер 6 граней (раздел 6); **новый** `src/renderer/src/media/equirect.ts`
(сшивка в воркере, GPano XMP); `src/core/tour.ts` — соседи точек по графу дверей и видимости,
yaw/pitch hotspots; `src/renderer/src/publish/prepare.ts` — файлы панорам в сайт;
`src/shared/pagesSite.ts` — `ViewerParams.view: '2d' | '3d' | 'pano'`;
**новый** `src/renderer/src/viewer/pano/` — лёгкий three.js-плеер (сфера, кроссфейд, гироскоп,
hotspots, мини-план), грузится без 3D-сцены и GLB.

Трудоёмкость: рендер граней **S–M** (зависит от контракта view3d), сшивка **S**, плеер панорам
**M**, публикация и ZIP **S**. Итого **M–L**.

Риски: швы от экранных эффектов (выключать AO/bloom, обзор 96° с обрезкой); вид изнутри шкафов
и стен при точке у стены (сдвигать точку внутрь комнаты); размер сайта (превью + ленивая загрузка
полной панорамы); `maxTextureDimension2D` на слабых телефонах (6144 → грузить кубом по 1536 или
equirect 4096 по умолчанию); соответствие тонмаппинга панорам и 3D.

### v3 — озвучка/подписи, день-ночь, до/после, VR

- **Подписи**: из `caption` — вжигание в видео (2D-канвас) + `.vtt` рядом с MP4; в просмотрщике —
  текстом. **S**.
- **Озвучка**: запись с микрофона по остановке (`MediaRecorder` → Opus) или импорт файла;
  длительность остановки подстраивается под реплику; в видео — аудиодорожка через mediabunny
  (`AudioSampleSource`, AAC в MP4 при наличии энкодера, иначе Opus/WebM). Аудиофайлы — в папке
  проекта, не в JSON. **M**. Риск: AAC-энкодер в WebCodecs не везде.
- **День/ночь**: второе запекание уровня с `lightsOn: true` и солнцем ниже горизонта
  (манифест с режимами: `bake.json` → `{ day, night }`), переключатель в просмотрщике и кроссфейд
  в видео/панорамах; вдвое больше WebP-страниц. **M–L** (затрагивает `view3d/bake`, сейчас
  меняется другой сессией).
- **До/после**: «до» = вариант без отделки/мебели или «как есть» (`DocVariants`), «после» =
  дизайн-вариант. Панорамы в одной точке для двух вариантов → слайдер-шторка в плеере панорам
  (шейдер с границей по экранному x); в видео — шторка/кроссфейд на остановке. Публикация отдаёт
  только активный вариант — для панорам это не мешает (публикуются картинки), для 3D — нужна
  опция «опубликовать второй вариант». **M**.
- **VR**: только плеер панорам через WebXR (`immersive-vr`) на WebGL2 (`WebGPURenderer({forceWebGL})`
  или отдельный лёгкий `WebGLRenderer` в плеере панорам) — WebXR поверх WebGPU в 2026 г. ещё
  экспериментальный. Гейз/контроллер-переходы по hotspots. Полная 3D-прогулка в VR — нет.
  **M**.

Модель (дополнения): `TourStop.voice?: { file: string; sec: number }`,
`DocTour.light?: 'day' | 'night' | 'both'`, `DocTour.compare?: { beforeVariantId: Id; afterVariantId: Id }`.

## 6. Зависимость от рефакторинга `view3d/`

Другая сессия (`claude/light-3d-a18039`) меняет `engine.ts`, `post.ts`, `quality.ts`,
`lighting.ts`, `bake/*`, удаляет `pathtracer.ts`/`denoise.ts`, убирает `mode: 'pathtraced'` из
`StillOptions`. `controls.ts` и `walkInput.ts` в ней не меняются.

**Требует `view3d/` (делать после слияния, узким контрактом в `contracts.ts`):**

```ts
interface Engine3DHandle {
  // + v1: захват кадров с явной камерой, без анимаций/адаптивного DPR/хелперов
  beginCapture(o: { width: number; height: number; supersample?: 1 | 2 }): Promise<FrameCapture>
}
interface FrameCapture {
  frame(pose: { position: [number, number, number]; quaternion: [number, number, number, number]; fov: number }): Promise<ImageData | VideoFrame>
  cubeFaces?(position: [number, number, number], size: number): Promise<ImageData[]> // v2
  end(): void
}
```

- реализация через тот же путь, что `renderRealtimeStill` (`post.renderToTarget` + `readTarget`),
  с прогревом шейдеров один раз;
- проигрывание тура в живом окне: режим `controls.ts` «по сценарию» (отключить ввод, ставить
  позу каждый кадр, `invalidate` пока играет) — небольшая правка `controls.ts`;
- проекция POI в экран: `getCamera()` уже отдаёт позу; достаточно события «кадр отрисован» в
  `Engine3DHandle` (сейчас `onBeforeRender` есть только во внутреннем `EngineContext`);
- день/ночь — двойное запекание в `view3d/bake/*` и `publish/bake.ts`.

**Можно делать сейчас, независимо:**
- модель `DocTour`, чтение в `io.ts`, правила `viewDoc`, тесты;
- `core/tour.ts`: граф дверей, кривая, `poseAt(t)` (чистая математика, координаты как в
  `controls.ts`);
- UI списка остановок (`TourSection`), POI-данные и карточки (без 3D-маркеров);
- мини-план `MiniPlan.tsx` (SVG из `display.ts`/`svg.ts`) — в редакторе и просмотрщике;
- `media/videoExport.ts` с mediabunny (проверяется на синтетических кадрах 2D-канваса),
  выбор кодека, поток в файл через `api.files`;
- `media/equirect.ts` — сшивка 6 граней в воркере (тест на синтетическом кубе);
- плеер панорам в просмотрщике (на тестовых equirect-картинках) и формат `tour.json`.

## 7. Рекомендация по объёму v1

1. Тур = упорядоченные закладки `walk` с паузой, переходом и подписью; путь через центры дверей.
2. Предпросмотр тура в окне 3D + мини-план с конусом камеры.
3. Экспорт видео 1080p30 MP4/H.264 (запасной WebM/VP9), опционально 4K; вжигание подписей и
   мини-плана.
4. POI с карточками (цена/ссылка — только по галочке автора).
5. Плеер тура и POI в опубликованном просмотрщике.
Это закрывает «видеооблёт 1–3 мин» из договора; «ссылка на 360-тур» закрывается текущим
просмотрщиком (прогулка) уже сейчас и полноценно — в v2.

**Решение (2026-11-21):** объём v1 выбран — маршрут + видео + точки интереса + мини-план (пункты 1–5).
Реализация — после слияния ветки облегчения 3D (`light-3d`) в main; части вне `view3d/` (модель тура,
планировщик пути, мини-план, муксер, UI) можно начинать раньше.

## 8. Источники

- Matterport 3D Showcase 2.0 (highlight reel, guided tour): https://matterport.com/en-gb/blog/meet-3d-showcase-20
- Matterport Auto-Tours: https://matterport.com/blog/from-scan-to-story-auto-tours-in-matterport
- Matterport Dollhouse (подписи комнат, этажи): https://matterport.com/es/blog/dollhouse-view-just-got-upgrade
- Matterport Tags (ссылки, медиа): https://matterport.github.io/developer-docs/tutorials/creating-tags/ ;
  https://matterport.com/blog/multimedia-mattertagtm-posts-embed-video-audio-and-more-your-3d-spaces
- Kuula: https://kuula.co/ ; floor plan: https://europa.kuula.co/help/floor-plan ; WebXR: https://blog.kuula.co/webvr-kuula
- 3DVista Virtual Tour Pro: https://www.3dvista.com/en/products/virtualtour ; https://www.capterra.com/p/158776/3DVista-Virtual-Tour-Suite/
- Pano2VR: https://ggnome.com/doc/pano2vr/7_1/whats-new/ ; https://ggnome.com/doc/pano2vr/beta/whats-new/
- Marzipano: https://npmjs.com/package/marzipano ; обзор библиотек: https://portalzine.de/open-source-virtual-tour-360-panorama-libraries-in-javascript-2026/
- Cupix (split screen, BIM): https://www.cupix.com/features/ ; https://www.cupix.com/product/4d-documentation ;
  https://360rumors.com/cupix-virtual-tour-software-4d-comparison-view-construction-documentation/?amp=1
- Planner 5D 360 Walkthrough: https://support.planner5d.com/en/articles/10581383-360-walkthrough-feature ; https://planner5d.com/pro/360panorama
- Roomtodo (сторонние обзоры): https://www.goodfirms.co/company/roomtodo ; https://www.getapp.com/all-software/a/roomtodo/
- Coohom roaming video / 720 tour: https://www.coohom.com/helpcenter/render-generate-roaming-video ;
  https://www.coohom.com/helpcenter/how-to-generate-video-roaming ; https://helpcenter.coohom.com/en/articles/8314349-panorama-editor-available-to-all-users
- Enscape video/panorama: https://blog.enscape3d.com/best-practices-video-creation ; https://learn.enscape3d.com/blog/knowledgebase/panorama-cardboard/ ;
  https://blog.enscape3d.com/export-options-in-enscape
- Twinmotion: https://dev.epicgames.com/documentation/twinmotion/panorama-sets ;
  https://dev.epicgames.com/documentation/twinmotion/export-settings-for-images-and-panoramas-in-twinmotion
- Floorplanner/RoomSketcher в обзоре 360-туров: https://www.cloudpano.com/blog/floor-plans-software-with-360-camera
- mediabunny: https://mediabunny.dev/guide/introduction ; https://mediabunny.dev/guide/media-sources ; https://github.com/Vanilagy/mediabunny
- mp4-muxer устарел → mediabunny: https://github.com/Vanilagy/mp4-muxer ; https://vanilagy.github.io/mp4-muxer/MIGRATION-GUIDE.html
- WebCodecs и выбор кодека: https://developer.mozilla.org/docs/Web/API/WebCodecs_API ; https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection ;
  https://www.w3.org/TR/webcodecs-avc-codec-registration/
- H.264 в Chromium вне Chrome: https://groups.google.com/a/chromium.org/g/media-dev/c/WzBq6R0s68Y ;
  MediaRecorder H.26x: https://groups.google.com/a/chromium.org/g/blink-dev/c/YJ1QijNiHeM ; починка WebM от MediaRecorder: https://remotion.dev/docs/webcodecs/fix-mediarecorder-video
- three.js CubeRenderTarget: https://threejs.org/docs/pages/CubeRenderTarget.html ; cube→equirect: https://www.npmjs.org/package/three.cubemap-to-equirectangular
- WebXR и WebGPURenderer: https://discourse.threejs.org/t/webgpurenderer-vr-support/76048 ; https://github.com/mrdoob/three.js/issues/28968 ;
  https://immersive-web.github.io/WebXR-WebGPU-Binding/
- Состав дизайн-проекта и визуализации (РФ/РК): https://vc.ru/id1963646/886798-dizain-proekt-chto-v-nego-vhodit ;
  https://skillbox.ru/media/design/chto-takoe-3d-vizualizaciya-interera-i-kak-ee-sdelat/ ;
  https://obyavleniya.kaspi.kz/almaty/uslugi/k--3d-%D0%B2%D0%B8%D0%B7%D1%83%D0%B0%D0%BB%D0%B8%D0%B7%D0%B0%D1%86%D0%B8%D1%8F/
