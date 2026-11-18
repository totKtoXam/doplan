/** IPC of the welcome screen: recent projects (checked on disk, with plan thumbnails) and the launch file. */
import { join } from 'node:path'
import { RECENT_CH } from '../shared/recent'
import { handleIpc } from './ipc'
import { paths } from './paths'
import { dropThumb, listEntries, pruneThumbs, writeThumb } from './recentList'
import { getSettings, isRecentPath, removeRecent } from './settings'
import { takeLaunchOpen } from './window'

const thumbsDir = () => join(paths.userData, 'recent-thumbs')

export function registerRecentIpc(): void {
  handleIpc(RECENT_CH.list, async () => {
    const { recent } = await getSettings()
    void pruneThumbs(thumbsDir(), recent)
    return listEntries(recent, thumbsDir())
  })
  handleIpc(RECENT_CH.remove, async (path: unknown) => {
    if (typeof path !== 'string' || !path) return
    if (await removeRecent(path)) await dropThumb(thumbsDir(), path)
  })
  handleIpc(RECENT_CH.setThumb, async (path: unknown, svg: unknown) => {
    // only projects of the list get a thumbnail: the renderer cannot make main write files elsewhere
    if (typeof path !== 'string' || !path || !(await isRecentPath(path))) return
    if (svg === null) await dropThumb(thumbsDir(), path)
    else await writeThumb(thumbsDir(), path, svg)
  })
  handleIpc(RECENT_CH.launch, () => ({ file: takeLaunchOpen() }))
}
