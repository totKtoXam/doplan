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
  projectTrustFolder: 'project:trustFolder',
  projectResetGitConfig: 'project:resetGitConfig',
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
  aiChatMove: 'aiChat:move',
  aiChatDrop: 'aiChat:drop',
  aiChatClaim: 'aiChat:claim',
  aiChatLogin: 'aiChat:login',
  aiChatLoginInput: 'aiChat:loginInput',
  aiChatLoginCancel: 'aiChat:loginCancel',
  evAiChatLogin: 'ev:aiChatLogin',
  evAiChatEvent: 'ev:aiChatEvent',
  evAiChatToolCall: 'ev:aiChatToolCall',
  evAiChatToolCancel: 'ev:aiChatToolCancel',
  // ── end ai-chat block ──

  // ── github block ──
  githubGhStatus: 'github:ghStatus',
  githubInstallGh: 'github:installGh',
  githubLogin: 'github:login',
  githubLoginCancel: 'github:loginCancel',
  evGithubLogin: 'ev:githubLogin',
  evGithubCreateStep: 'ev:githubCreateStep',
  githubStatus: 'github:status',
  githubConnect: 'github:connect',
  githubCreate: 'github:create',
  githubPush: 'github:push',
  githubPull: 'github:pull',
  githubResolve: 'github:resolve',
  githubDisconnect: 'github:disconnect',
  githubOpenPage: 'github:openPage',
  // ── end github block ──

  updatesGet: 'updates:get',
  updatesCheck: 'updates:check',
  updatesInstall: 'updates:install',
  updatesOpenRelease: 'updates:openRelease',
  evUpdateState: 'ev:updateState',

  pagesStatus: 'pages:status',
  pagesPublish: 'pages:publish',
  pagesUnpublish: 'pages:unpublish',
  pagesOpenUrl: 'pages:openUrl',
  evPagesProgress: 'ev:pagesProgress',

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
