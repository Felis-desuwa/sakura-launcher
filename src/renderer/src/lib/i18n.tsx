import { createContext, useContext, useMemo } from 'react'
import { makeT, type Lang, type T } from '../../../shared/i18n'
import { setFormatLang } from './format'

/**
 * The current language, handed down the tree.
 *
 * A context rather than a module-level variable because switching has to repaint: every
 * label in the application is derived from `t`, so the language living in React state is
 * what makes a change take effect without a reload.
 */
const LangContext = createContext<{ lang: Lang; t: T }>({ lang: 'zh', t: makeT('zh') })

export function LangProvider({
  lang,
  children
}: {
  lang: Lang
  children: React.ReactNode
}): React.JSX.Element {
  const value = useMemo(() => {
    // During render, not in an effect: an effect runs after the children have already
    // painted, so the first frame in the new language would still show the old one.
    setFormatLang(lang)
    return { lang, t: makeT(lang) }
  }, [lang])
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

/** The translator. Every user-facing string in the renderer comes through here. */
export function useT(): T {
  return useContext(LangContext).t
}

export function useLang(): Lang {
  return useContext(LangContext).lang
}
