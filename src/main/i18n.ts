import { makeT, type Lang, type MessageKey, type T, type Vars } from '../shared/i18n.ts'

/**
 * The main process's copy of the current language.
 *
 * Held as a module variable rather than threaded through every call: the text produced
 * here — launch failures, diagnosis findings, the sidecar written into a game folder —
 * is generated in a dozen places that have no business knowing about settings. The
 * database sets this once at startup and again whenever the user changes it.
 */
let current: Lang = 'zh'
let bound: T = makeT('zh')

export function setMainLang(lang: Lang): void {
  if (lang === current) return
  current = lang
  bound = makeT(lang)
}

export function mainLang(): Lang {
  return current
}

export function t(key: MessageKey, vars?: Vars): string {
  return bound(key, vars)
}
