#!/usr/bin/env node
/**
 * dp — doplan photo-to-plan toolchain for agents (Claude Code) and developers.
 * Run: pnpm dp <group> <command> [args] [--json]
 *
 * Command modules are imported lazily so `img …` works even while core is being changed.
 */
import { Args, parseArgs } from './lib/args'
import { type CommandResult, DpError, printError, printResult } from './lib/output'

type Handler = (a: Args) => Promise<CommandResult>

interface Cmd {
  usage: string
  summary: string
  load: () => Promise<Handler>
}

const COMMANDS: Record<string, Record<string, Cmd>> = {
  img: {
    info: {
      usage: 'img info <file>',
      summary: 'size, format, EXIF orientation, vision token estimate',
      load: async () => (await import('./commands/img')).imgInfo,
    },
    prep: {
      usage:
        'img prep <file> --out <dir> [--perspective x1,y1,x2,y2,x3,y3,x4,y4 [--rect-mm W,H] [--pad 0.1]] [--max 2000] [--min 1000] [--crop x,y,w,h] [--deskew [auto|<deg>]] [--contrast] [--gray] [--no-upscale]',
      summary:
        'auto-orient, perspective-rectify (4 corners of a rectangle in ORIGINAL px, any order), crop, deskew, enhance, resize → <dir>/work.png + prep.json',
      load: async () => (await import('./commands/img')).imgPrep,
    },
    grid: {
      usage: 'img grid <file> --out <png> [--step 100] [--major 500] [--margin 64] [--no-inner]',
      summary: 'labelled pixel-coordinate grid with axis numbers on all sides',
      load: async () => (await import('./commands/img')).imgGrid,
    },
    tiles: {
      usage: 'img tiles <file> --out <dir> [--n 2x2] [--overlap 0.15] [--step N] [--target 1400]',
      summary: 'zoomed tiles, grid labels in ORIGINAL px',
      load: async () => (await import('./commands/img')).imgTiles,
    },
    zoom: {
      usage: 'img zoom <file> --rect x,y,w,h --out <png> [--scale N] [--step N]',
      summary: 'one zoomed crop with a fine grid in ORIGINAL px (doors, windows, dimension text)',
      load: async () => (await import('./commands/img')).imgZoom,
    },
    mark: {
      usage: 'img mark <file> --out <png> --points "x,y;x,y" [--labels a,b] [--rects "x,y,w,h;…"]',
      summary: 'draw numbered markers to verify "is this the corner I think it is?"',
      load: async () => (await import('./commands/img')).imgMark,
    },
    paste: {
      usage: 'img paste [--out inbox/|file.png]',
      summary: 'save the clipboard image to a file (pasted screenshots)',
      load: async () => (await import('./commands/img')).imgPaste,
    },
    lines: {
      usage: 'img lines <file> --out <json> [--overlay <png>] [--min-thick px] [--max-thick px] [--close px] [--threshold 0-255]',
      summary: 'CV HINTS: axis-aligned thick wall bands with thickness (px)',
      load: async () => (await import('./commands/img')).imgLines,
    },
  },
  spec: {
    scale: {
      usage: 'spec scale --px N --mm M | --ref x1,y1,x2,y2 --mm M [--spec f.json [--label t]] | --from-areas spec.px.json',
      summary: 'mm per px from a printed dimension (optionally written into the spec) or from labelled areas',
      load: async () => (await import('./commands/spec')).specScale,
    },
    validate: {
      usage: 'spec validate <spec.json> [--strict]',
      summary: 'core validator + computed vs labelled room areas; exit 1 on errors',
      load: async () => (await import('./commands/spec')).specValidate,
    },
    normalize: {
      usage: 'spec normalize <spec.json> --out <file> [--mm-per-px N] [--grid 10] [--ortho-tol 3] [--merge 30]',
      summary: 'px→mm, orthogonal snap, merge near-coincident coordinates, 10 mm grid',
      load: async () => (await import('./commands/spec')).specNormalize,
    },
    render: {
      usage: 'spec render <spec.json> --out <png> [--px-per-m 100] [--frame source] [--no-dims] [--no-furniture] [--theme blueprint]',
      summary: 'compile and draw with the app display list',
      load: async () => (await import('./commands/spec')).specRender,
    },
    overlay: {
      usage: 'spec overlay <spec.json> --image <work.png> --out <png> [--alpha 0.5] [--no-diff] [--min-thick px]',
      summary: 'compiled plan in magenta over the source image + wall IoU and missing/extra boxes',
      load: async () => (await import('./commands/spec')).specOverlay,
    },
    check: {
      usage: 'spec check <spec.json> --out-dir <dir> [--image <work.png>] [--iter N]',
      summary: 'validate + render + overlay in one call (render-NN.png, overlay-NN.png, check-NN.json)',
      load: async () => (await import('./commands/spec')).specCheck,
    },
    build: {
      usage: 'spec build <spec.json> --out <project.doplan> [--open] [--no-underlay] [--name "…"] [--strict]',
      summary: 'compile → .doplan (zip: manifest.json, doc.json, assets/) and optionally open the app',
      load: async () => (await import('./commands/spec')).specBuild,
    },
  },
  doc: {
    info: {
      usage: 'doc info <project.doplan>',
      summary: 'levels, rooms with areas, walls, openings',
      load: async () => (await import('./commands/doc')).docInfo,
    },
    render: {
      usage: 'doc render <project.doplan> --out <png> [--px-per-m 100] [--level name|n]',
      summary: '2D render of a project',
      load: async () => (await import('./commands/doc')).docRender,
    },
    spec: {
      usage: 'doc spec <project.doplan> --out <spec.json>',
      summary: 'decompile a project into a walls-mode PlanSpec',
      load: async () => (await import('./commands/doc')).docSpec,
    },
  },
}

function help(group?: string): string {
  const lines = ['dp — doplan photo-to-plan toolchain', 'usage: pnpm dp <group> <command> [args] [--json]', '']
  for (const [g, cmds] of Object.entries(COMMANDS)) {
    if (group && g !== group) continue
    for (const c of Object.values(cmds)) lines.push(`  ${c.usage}`, `      ${c.summary}`)
  }
  lines.push('', 'All coordinates are px of the given image (x right, y down) unless a command says mm.', 'Output: concise text; --json prints one JSON object. Exit code 0 = ok, 1 = problems found, 2 = crash.')
  return lines.join('\n')
}

export async function runCli(argv: string[]): Promise<number> {
  const [group, name, ...rest] = argv
  const json = argv.includes('--json')
  if (!group || group === 'help' || group === '--help' || group === '-h') {
    process.stdout.write(`${help()}\n`)
    return 0
  }
  const cmds = COMMANDS[group]
  if (!cmds) {
    printError(new DpError(`unknown group "${group}"`, 1, 'groups: img, spec, doc (pnpm dp help)'), json)
    return 1
  }
  if (!name || name === 'help' || name === '--help') {
    process.stdout.write(`${help(group)}\n`)
    return 0
  }
  const cmd = cmds[name]
  if (!cmd) {
    printError(new DpError(`unknown command "${group} ${name}"`, 1, `commands: ${Object.keys(cmds).join(', ')}`), json)
    return 1
  }
  const parsed = parseArgs(rest)
  if (parsed.flags.help) {
    process.stdout.write(`usage: pnpm dp ${cmd.usage}\n  ${cmd.summary}\n`)
    return 0
  }
  try {
    const handler = await cmd.load()
    const res = await handler(new Args(parsed))
    printResult(res, json)
    return res.exitCode ?? 0
  } catch (e) {
    return printError(e, json)
  }
}

const isMain = (() => {
  const entry = process.argv[1] ?? ''
  return /[\\/]dp[\\/]cli\.(ts|js|mjs)$/.test(entry)
})()

if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (e) => {
      process.exitCode = printError(e, process.argv.includes('--json'))
    },
  )
}
