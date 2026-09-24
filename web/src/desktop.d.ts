interface MiniClawDesktopApi {
  readonly platform: string
  selectDirectory(defaultPath?: string): Promise<string | null>
}

interface Window {
  readonly miniClawDesktop?: MiniClawDesktopApi
}
