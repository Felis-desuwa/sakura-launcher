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

/**
 * Render the `**bold**` inside a translated string.
 *
 * The dictionary is written in the same voice as the rest of this project's prose, so the
 * clause that carries the warning is marked. Nothing rendered those markers, which meant a
 * line written to draw the eye to one phrase displayed a pair of asterisks around it
 * instead — noise, on exactly the lines that most needed to be skimmable.
 *
 * This is the whole of the markup on purpose: no links, no italics, no lists. A hint that
 * needs more than an emphasised clause needs rewriting rather than a parser.
 *
 * An unbalanced string is returned untouched rather than half-marked: a stray `**` is a
 * typo in the dictionary, and swallowing it would hide the typo instead of showing it.
 */
export function emph(text: string): React.ReactNode {
  const parts = text.split('**')
  if (parts.length < 3 || parts.length % 2 === 0) return text
  return parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))
}
