/** `git describe` of the build, injected by electron.vite.config.ts (`__APP_GIT__`); '' when unknown */
declare const __APP_GIT__: string | undefined

export const APP_GIT: string = typeof __APP_GIT__ === 'string' ? __APP_GIT__ : ''
