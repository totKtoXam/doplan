/** IPC channel names shared by main and preload (main owns both). */
export const CH = {
  projectOpen: 'project:open',
  projectSave: 'project:save',
  projectAutosave: 'project:autosave',
  projectRecover: 'project:recover',
  projectClearRecovery: 'project:clearRecovery',
  projectReset: 'project:reset',
  projectAddAsset: 'project:addAsset',
  // project folders + git versions
  projectRoot: 'project:root',
  projectInstructions: 'project:instructions',
  projectSetInstructions: 'project:setInstructions',
  projectInfo: 'project:info',
  projectDefaultLocation: 'project:defaultLocation',
  projectPickLocation: 'project:pickLocation',
  projectPickProjectsDir: 'project:pickProjectsDir',
  projectCreate: 'project:create',
  projectOpenFolder: 'project:openFolder',
  projectExportZip: 'project:exportZip',
  projectAttach: 'project:attach',
  projectTrustGit: 'project:trustGit',
  projectHistory: 'project:history',
  projectVersionDoc: 'project:versionDoc',
  projectTagVersion: 'project:tagVersion',

  filesPick: 'files:pick',
  filesRead: 'files:read',
  filesReadText: 'files:readText',
  filesSaveText: 'files:saveText',
  filesSaveBinary: 'files:saveBinary',
  filesExportPdf: 'files:exportPdf',
  filesReveal: 'files:reveal',

  catalogLoad: 'catalog:load',
  catalogImportModel: 'catalog:importModel',
  catalogImportMaterial: 'catalog:importMaterial',
  catalogDownload: 'catalog:download',
  catalogRemove: 'catalog:remove',
  catalogSaveThumb: 'catalog:saveThumb',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsSetApiKey: 'settings:setApiKey',

  aiPlanFromImage: 'ai:planFromImage',

  // ── ai-chat block ──
  aiChatProviders: 'aiChat:providers',
  aiChatRun: 'aiChat:run',
  aiChatStop: 'aiChat:stop',
  aiChatToolResult: 'aiChat:toolResult',
  aiChatList: 'aiChat:list',
  aiChatLoad: 'aiChat:load',
  aiChatSave: 'aiChat:save',
  aiChatDelete: 'aiChat:delete',
  aiChatGetSettings: 'aiChat:getSettings',
  aiChatSetSettings: 'aiChat:setSettings',
  aiChatLogin: 'aiChat:login',
  aiChatLoginInput: 'aiChat:loginInput',
  aiChatLoginCancel: 'aiChat:loginCancel',
  evAiChatLogin: 'ev:aiChatLogin',
  evAiChatEvent: 'ev:aiChatEvent',
  evAiChatToolCall: 'ev:aiChatToolCall',
  // ── end ai-chat block ──

  // renderer → main (fire and forget)
  windowSetTitle: 'window:setTitle',
  windowConfirmClose: 'window:confirmClose',

  // main → renderer events
  evMenu: 'ev:menu',
  evCloseRequest: 'ev:closeRequest',
  evOpenFile: 'ev:openFile',
  evCatalogProgress: 'ev:catalogProgress',
} as const

/** argv prefix used to pass the app version into the sandboxed preload */
export const VERSION_ARG = '--doplan-version='
