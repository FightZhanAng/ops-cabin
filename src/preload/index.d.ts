import type { OpsCabinApi } from './index'

declare global {
  interface Window {
    opsCabin: OpsCabinApi
  }
}

export {}
