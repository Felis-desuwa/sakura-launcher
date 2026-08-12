/// <reference types="vite/client" />

import type { SakuraApi } from '../../preload/index'

declare global {
  interface Window {
    sakura: SakuraApi
  }
}

export {}
