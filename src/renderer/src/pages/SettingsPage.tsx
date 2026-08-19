import { useEffect, useState } from 'react'
import type { Lang, MessageKey } from '../../../shared/i18n'
import { LANGS } from '../../../shared/i18n'
import type {
  DownloaderKey,
  LosslessHdr,
  Settings,
  SortKey,
  TabKey,
  Upscaler,
  UpscaleStatus
} from '../../../shared/types'
import {
  DOWNLOADERS,
  isIntegratedGpu,
  LOSSLESS_PRESETS,
  MAGPIE_MODES,
  normalizeUpscaleMode,
  POLL_CHOICES,
  presetIsHeavy,
  SORT_KEYS,
  TAB_KEYS,
  THEMES
} from '../../../shared/types'
import { useT } from '../lib/i18n'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  /** Re-run the import preview for one folder, so new games in it can be picked up. */
  onRescanFolder: (folder: string) => void
  /** Drop a folder and everything the library took from it. */
  onRemoveRoot: (folder: string) => void
  onAddFolder: () => void
  onBrowsePath: (dir: string) => void
  /** Put a removed entry back into the library. */
  onUnignore: (dir: string) => void
  /** Drop one path from the removed list without adding it back. */
  onForgetIgnored: (dir: string) => void
  onClearIgnored: () => void
  /** Look up every game that has no catalogue match yet. */
  onComputeTags: () => void
  /** Ask again about every game, including the ones already matched. */
  onRedoTags: () => void
  onCancelTags: () => void
  /** Non-null while a pass is running. */
  tagProgress: { done: number; total: number; name: string } | null
  /** How many games a pass would look up. Drives both the hint and the disabled state. */
  pendingCount: number
  gameCount: number
  /** Games given their own upscaling answer, so the override is never invisible. */
  upscaleOverrides: number
}

export default function SettingsPage({
  settings,
  onChange,
  onRescanFolder,
  onRemoveRoot,
  onAddFolder,
  onBrowsePath,
  onUnignore,
  onForgetIgnored,
  onClearIgnored,
  onComputeTags,
  onRedoTags,
  onCancelTags,
  tagProgress,
  pendingCount,
  gameCount,
  upscaleOverrides
}: Props): React.JSX.Element {
  const t = useT()
  const [has7z, setHas7z] = useState<boolean | null>(null)
  /** undefined while the probe is still running, so "not found" is not shown too early. */
  const [detected, setDetected] = useState<string | null | undefined>(undefined)
  /** The suggested backup folder, shown when the user has not named one. */
  const [backupDir, setBackupDir] = useState('')
  /** null while the probe is still running, so nothing is claimed too early. */
  const [upscaler, setUpscaler] = useState<UpscaleStatus | null>(null)
  /**
   * What the backend in force actually offers.
   *
   * Magpie's built-in seven until it can be read, which is also the wrong starting point
   * for the other one — so switching to Lossless Scaling replaces the list rather than
   * adding to it, and an empty answer there is a real answer: that program has no
   * built-ins, and a name this program invented would be offered and then do nothing.
   */
  const [modes, setModes] = useState<string[]>(MAGPIE_MODES)
  /** A path the user picked that the main process would not keep. Cleared by the next try. */
  const [pickRefused, setPickRefused] = useState(false)

  useEffect(() => {
    window.sakura.has7z().then(setHas7z)
  }, [])

  // Polled, not asked once. Switching the feature on lays a copy down or goes looking for
  // one, and the upscaler itself comes and goes with the games it scales — neither of which
  // this page would ever hear about. A status that cannot change is the same as no status:
  // the user is left watching a line that says "ready" whether or not anything is working.
  useEffect(() => {
    let alive = true
    // One question at a time. Each status answer costs a process query with a twenty-second
    // ceiling of its own, so on a loaded machine the next tick can arrive while the last is
    // still outstanding — and shells would then stack up for as long as the page is open.
    let asking = false
    const ask = (): void => {
      if (asking) return
      asking = true
      void window.sakura
        .upscaleStatus()
        .then((s) => {
          if (alive) setUpscaler(s)
        })
        .finally(() => {
          asking = false
        })
      // Asked on the same beat, and for the same reason: a mode just built in
      // the upscaler's own interface is worth nothing if choosing it means restarting this
      // program. Only a file read, unlike the status above.
      void window.sakura.upscaleModes().then((m) => {
        if (alive) setModes(m)
      })
    }
    ask()
    // Asked once even with the feature off, because `supported` is what disables the switch
    // on a machine too old for Magpie — and with the switch off the main process answers
    // that without going near a process query.
    if (!settings.upscale) {
      return () => {
        alive = false
      }
    }
    // Five seconds, not one: each answer costs a PowerShell process query. Slow enough to
    // be cheap, quick enough that starting a game and tabbing back here shows it.
    const id = setInterval(ask, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
    // Re-run on a backend switch as well as on the master switch, because a stale
    // Magpie answer on screen after a switch to Lossless Scaling would show a version
    // number for a program that is no longer the one in force.
  }, [settings.upscale, settings.upscaler])

  // Re-asked whenever the choice changes: the answer is "theirs, or the default", so a
  // value cached from before a reset would show the folder they just cleared.
  useEffect(() => {
    void window.sakura.backupDir().then(setBackupDir)
  }, [settings.backupDir])

  useEffect(() => {
    setDetected(undefined)
    void window.sakura.detectDownloader(settings.downloader).then(setDetected)
  }, [settings.downloader])

  const current = DOWNLOADERS.find((d) => d.key === settings.downloader)
  // Normalised for display: a setting saved when this field held keys rather than names
  // would match no option at all, and the control would sit on the wrong one.
  const chosenMode = normalizeUpscaleMode(settings.upscaleMode)
  const magpie = upscaler?.backend === 'magpie' ? upscaler : null
  const lossless = upscaler?.backend === 'lossless' ? upscaler : null
  const onMagpie = settings.upscaler === 'magpie'
  // Only Magpie can be refused by the machine itself. Lossless Scaling's requirement is
  // that the user owns it, which is not something a version check can answer.
  const blocked = magpie !== null && !magpie.supported
  /**
   * Every name the picker can currently resolve.
   *
   * Presets count under Lossless Scaling even though they are not in `modes` — they are
   * this program's own and always available, so a stored preset id is not an unknown mode
   * and must not be reported as one.
   */
  const known = onMagpie ? modes : [...LOSSLESS_PRESETS.map((p) => p.id), ...modes]
  const display = lossless?.display ?? null
  /**
   * The whole-multiple arithmetic, done with this machine's screen rather than an example.
   *
   * Halving is the only case worth printing: 2× is what anybody reaching for whole-multiple
   * scaling wants, and the window that gets it is exactly half the screen. Anything that
   * does not divide falls back to 1× in silence, which is the trap being described.
   */
  const halfScreen =
    display === null ? null : `${Math.floor(display.width / 2)}×${Math.floor(display.height / 2)}`
  // Only the discouraging half of the annotation is ever shown — see `isIntegratedGpu`.
  const heavyForThisGpu =
    lossless?.gpu != null && isIntegratedGpu(lossless.gpu.name) && presetIsHeavy(chosenMode)

  return (
    <div className="page">
      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>{t('settings.roots')}</div>
        {settings.roots.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
            {t('settings.noRoots')}
          </div>
        )}
        {settings.roots.map((root) => (
          <div className="root-row" key={root}>
            <span style={{ flex: 1 }}>{root}</span>
            <button
              type="button"
              className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => onBrowsePath(root)}
            >
              {t('settings.browse')}
            </button>
            <button
              type="button"
              className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 12 }}
              title={t('settings.rescanTitle')}
              onClick={() => onRescanFolder(root)}
            >
              {t('settings.rescan')}
            </button>
            <button
              type="button"
              className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => onRemoveRoot(root)}
            >
              {t('settings.remove')}
            </button>
          </div>
        ))}
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '12px 0 0', lineHeight: 1.6 }}>
          {t('settings.rootsNote')}
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button type="button" className="btn primary" onClick={onAddFolder}>
            {t('menu.addFolder')}
          </button>
        </div>
      </div>

      {settings.ignoredDirs.length > 0 && (
        <div className="card" style={{ maxWidth: 760 }}>
          <div
            className="section-title"
            style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <span style={{ flex: 1 }}>
              {t('settings.ignoredTitle', { n: settings.ignoredDirs.length })}
            </span>
            <button
              type="button"
              className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={onClearIgnored}
            >
              {t('clearIgnored.confirm')}
            </button>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 12px', lineHeight: 1.6 }}>
            {t('settings.ignoredNote')}
            <br />
            {t('settings.ignoredNote2')}
          </p>
          {settings.ignoredDirs.map((dir) => (
            <div className="root-row" key={dir}>
              <span style={{ flex: 1 }}>{dir}</span>
              <button
                type="button"
                className="btn ghost"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => onUnignore(dir)}
              >
                {t('settings.restore')}
              </button>
              <button
                type="button"
                className="btn ghost"
                style={{ padding: '4px 10px', fontSize: 12 }}
                title={t('settings.forgetTitle')}
                onClick={() => onForgetIgnored(dir)}
              >
                {t('settings.forget')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>{t('settings.theme')}</div>
        <div className="theme-grid">
          {THEMES.map((theme) => {
            const note = t(`theme.${theme.key}.note` as MessageKey)
            return (
              <button
                type="button"
                key={theme.key}
                className={`theme-card${settings.theme === theme.key ? ' active' : ''}`}
                onClick={() => onChange({ theme: theme.key })}
              >
                <span className="theme-swatch">
                  {theme.swatch.map((c) => (
                    <span key={c} style={{ background: c }} />
                  ))}
                </span>
                <span className="theme-name">
                  {t(`theme.${theme.key}` as MessageKey)}
                  {note && <em>{note}</em>}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>{t('settings.appearance')}</div>

        <div className="settings-row">
          <label htmlFor="language">
            {t('settings.language')}
            <span className="settings-hint">{t('settings.languageHint')}</span>
          </label>
          <select
            id="language"
            className="field"
            value={settings.language}
            onChange={(e) => onChange({ language: e.target.value as Lang })}
          >
            {LANGS.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <label htmlFor="defaultTab">{t('settings.defaultTab')}</label>
          <select
            id="defaultTab"
            className="field"
            value={settings.defaultTab}
            onChange={(e) => onChange({ defaultTab: e.target.value as TabKey })}
          >
            {TAB_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(`tab.${key}` as MessageKey)}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <label htmlFor="sortKey">{t('settings.defaultSort')}</label>
          <select
            id="sortKey"
            className="field"
            value={settings.sortKey}
            onChange={(e) => onChange({ sortKey: e.target.value as SortKey })}
          >
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(`sort.${key}` as MessageKey)}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <label htmlFor="tileSize">{t('settings.tileSize')}</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              id="tileSize"
              type="range"
              min={130}
              max={280}
              step={10}
              value={settings.tileSize}
              onChange={(e) => onChange({ tileSize: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span style={{ width: 54, fontSize: 12.5, color: 'var(--ink-soft)' }}>
              {settings.tileSize}px
            </span>
          </div>
        </div>

        <div className="settings-row">
          <label htmlFor="petals">{t('settings.petals')}</label>
          <button
            id="petals"
            type="button"
            className={`switch${settings.petals ? ' on' : ''}`}
            onClick={() => onChange({ petals: !settings.petals })}
          />
        </div>

        <div className="settings-row">
          <label htmlFor="poll">
            {t('settings.pollInterval')}
            <span className="settings-hint">
              {t('settings.pollHint')}
            </span>
          </label>
          <select
            id="poll"
            value={settings.playtimePollSeconds}
            onChange={(e) => onChange({ playtimePollSeconds: Number(e.target.value) })}
          >
            {POLL_CHOICES.map((s) => (
              <option key={s} value={s}>
                {t('settings.seconds', { n: s })}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <label htmlFor="diagnose">
            {t('settings.diagnoseOnLaunch')}
            <span className="settings-hint">
              {t('settings.diagnoseHint')}
            </span>
          </label>
          <button
            id="diagnose"
            type="button"
            className={`switch${settings.diagnoseOnLaunch ? ' on' : ''}`}
            onClick={() => onChange({ diagnoseOnLaunch: !settings.diagnoseOnLaunch })}
          />
        </div>
      </div>

      {/* A card of its own rather than a row under Launch: it carries a paragraph about
          where the upscaler comes from and a line about whether it is there yet, and
          neither fits in a row. */}
      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>
          {t('settings.upscaleSection')}
        </div>

        <div className="settings-row">
          <label htmlFor="upscale">
            {t('settings.upscale')}
            <span className="settings-hint">
              {blocked ? t('settings.magpieUnsupported') : t('settings.upscaleHint')}
            </span>
          </label>
          <button
            id="upscale"
            type="button"
            disabled={blocked}
            className={`switch${settings.upscale ? ' on' : ''}`}
            onClick={() => onChange({ upscale: !settings.upscale })}
          />
        </div>

        {settings.upscale && (
          <>
            <div className="settings-row">
              <label htmlFor="upscaler">
                {t('settings.upscaler')}
                <span className="settings-hint">{t('settings.upscalerHint')}</span>
              </label>
              <select
                id="upscaler"
                className="field"
                value={settings.upscaler}
                onChange={(e) => onChange({ upscaler: e.target.value as Upscaler })}
              >
                <option value="magpie">{t('settings.upscalerMagpie')}</option>
                <option value="lossless">{t('settings.upscalerLossless')}</option>
              </select>
            </div>

            {/* Where it comes from, shown whether or not it was found. A note that appeared
                only on failure would leave everybody who does already own Lossless Scaling
                never told that this program does not supply it, and that it writes into
                that program's own configuration. */}
            <p className="settings-hint" style={{ marginTop: 0 }}>
              {onMagpie ? t('settings.magpieNote') : t('settings.losslessNote')}
            </p>

            {onMagpie ? (
              <p className="settings-hint" style={{ marginTop: 0 }}>
                {t('settings.magpieHotkeyHint')}
              </p>
            ) : (
              <>
                {/* What will be written into their file, said before the first write rather
                    than after it. The link opens in their own browser through the window
                    handler in `index.ts`; this program still opens no socket of its own. */}
                <p className="settings-hint" style={{ marginTop: 0 }}>
                  {t('settings.losslessWrites')}{' '}
                  <a
                    className="linkish"
                    href="https://store.steampowered.com/app/993090/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('settings.losslessStore')}
                  </a>
                </p>

                {/* Where it is, immediately above the control that changes that — the two
                    are one subject, and a "not found" reported at the bottom of the card
                    leaves the button that fixes it out of sight. Says nothing at all until
                    the first answer arrives, rather than guessing at it. */}
                {lossless !== null && (
                  <p className="settings-hint" style={{ marginTop: 0, wordBreak: 'break-all' }}>
                    {!lossless.installed
                      ? t('settings.losslessNotFound')
                      : t(
                          lossless.pinned
                            ? 'settings.losslessPinnedAt'
                            : 'settings.losslessFoundAt',
                          { path: lossless.path ?? '' }
                        )}
                  </p>
                )}

                {/* Offered at all times, not only after a failure. The automatic search can
                    land on a stale or wrong install and still look like it worked, and the
                    user has to be able to overrule it — and to take the overrule back. */}
                <div className="settings-row">
                  <label htmlFor="losslessPick">
                    {t('settings.losslessPick')}
                    <span className="settings-hint">{t('settings.losslessPickHint')}</span>
                  </label>
                  <span style={{ display: 'flex', gap: 8 }}>
                    {settings.losslessPath !== null && (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                          setPickRefused(false)
                          void window.sakura.pinLossless(null)
                          onChange({ losslessPath: null })
                        }}
                      >
                        {t('settings.losslessClear')}
                      </button>
                    )}
                    <button
                      id="losslessPick"
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        void window.sakura.pickExePath().then((exe) => {
                          // A cancelled dialog is not a refusal and must not clear the pin.
                          if (exe === null) return
                          void window.sakura.pinLossless(exe).then((ok) => {
                            setPickRefused(!ok)
                            // Stored by the main process, which is the only side that can
                            // check it. Mirrored into settings so the row updates now
                            // rather than at the next poll.
                            if (ok) onChange({ losslessPath: exe })
                          })
                        })
                      }}
                    >
                      {t('settings.losslessPick')}
                    </button>
                  </span>
                </div>
                {pickRefused && (
                  <p className="settings-hint" style={{ marginTop: 0, color: 'var(--danger-text)' }}>
                    {t('settings.losslessWrongExe')}
                  </p>
                )}

                {lossless !== null && (
                  <>
                    {/* What the machine actually is.
                        Here rather than anywhere else because it is the input to exactly one
                        decision on this page: the HDR switch written into the profiles
                        below. Reading it costs a PowerShell and a compiled interop stub, so
                        the poll behind this card answers from a cache and this button is the
                        only thing that asks again. A screen that has not been measured says
                        so and claims nothing — "no HDR" on an unknown is the same
                        fabrication as the stale value that made this necessary. */}
                    <div className="section-title">{t('settings.displaySection')}</div>
                    <p className="settings-hint" style={{ marginTop: 0 }}>
                      {t('settings.displayHint')}
                    </p>
                    <div className="settings-row">
                      <label htmlFor="displayRefresh">
                        {display === null
                          ? t('settings.displayUnknown')
                          : t('settings.displayLine', {
                              name: display.name || t('settings.displayNoName'),
                              w: display.width,
                              h: display.height,
                              hz: display.refreshHz,
                              bits: display.bitsPerChannel
                            })}
                        <span className="settings-hint">
                          {display !== null &&
                            (!display.hdrSupported
                              ? t('settings.displayHdrUnsupported')
                              : display.hdrEnabled
                                ? t('settings.displayHdrOn')
                                : t('settings.displayHdrOff'))}
                          {lossless.gpu !== null && (
                            <>
                              {display !== null && ' · '}
                              {t('settings.displayGpu', { name: lossless.gpu.name })}
                            </>
                          )}
                        </span>
                      </label>
                      <button
                        id="displayRefresh"
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                          void window.sakura.refreshDisplays().then(setUpscaler)
                        }}
                      >
                        {t('settings.displayRefresh')}
                      </button>
                    </div>

                    <div className="settings-row">
                      <label htmlFor="losslessHdr">
                        {t('settings.losslessHdr')}
                        <span className="settings-hint">{t('settings.losslessHdrHint')}</span>
                      </label>
                      <select
                        id="losslessHdr"
                        className="field"
                        value={settings.losslessHdr}
                        onChange={(e) => onChange({ losslessHdr: e.target.value as LosslessHdr })}
                      >
                        <option value="auto">{t('settings.losslessHdrAuto')}</option>
                        <option value="on">{t('settings.losslessHdrOn')}</option>
                        <option value="off">{t('settings.losslessHdrOff')}</option>
                      </select>
                    </div>

                    {/* A standing line, not the toast `lossless.configLocked` raises. That
                        toast lasts four seconds; this state lasts until they close the
                        program, and the colour bug all of this was written for survived
                        precisely because nothing on screen ever said that the last
                        correction had not been written. */}
                    {lossless.pendingWrite && (
                      <p
                        className="settings-hint"
                        style={{
                          marginTop: 0,
                          whiteSpace: 'pre-line',
                          color: lossless.running ? 'var(--warn)' : undefined
                        }}
                      >
                        {t(
                          lossless.running
                            ? 'settings.losslessPendingLocked'
                            : 'settings.losslessPendingNext'
                        )}
                      </p>
                    )}
                    {/* Only reachable for a mode naming one of their own profiles: a preset
                        disagreeing with the screen is something the next write settles, and
                        the line above is already saying why it has not. Their own profile is
                        cloned and never corrected, so pointing at it is all there is to do. */}
                    {lossless.hdrMismatch && !lossless.pendingWrite && (
                      <p className="settings-hint" style={{ marginTop: 0, color: 'var(--warn)' }}>
                        {t('settings.losslessHdrMismatch', { mode: chosenMode })}
                      </p>
                    )}
                  </>
                )}
              </>
            )}

            <div className="settings-row">
              <label htmlFor="upscaleMode">
                {t('settings.upscaleMode')}
                <span className="settings-hint">
                  {onMagpie ? t('settings.magpieModeHint') : t('settings.losslessModeHint')}
                </span>
              </label>
              <select
                id="upscaleMode"
                className="field"
                value={chosenMode}
                onChange={(e) => onChange({ upscaleMode: e.target.value })}
              >
                {/* A mode chosen before it was deleted from the upscaler, or one carried
                    over from another machine, is still the answer on record — listed so the
                    control shows what is actually set rather than silently reading as the
                    first entry. Magpie treats an unknown name as "use the default"; for
                    Lossless Scaling nothing is written for it and the user is told. */}
                {!known.includes(chosenMode) && <option value={chosenMode}>{chosenMode}</option>}
                {/* Presets first, and in their own group: somebody who has just switched
                    this on has no profiles of their own and would otherwise be handed an
                    empty list, or a list of names they would have to research. */}
                {!onMagpie && (
                  <optgroup label={t('upscale.presetGroup')}>
                    {LOSSLESS_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {t(preset.labelKey)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {onMagpie
                  ? modes.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))
                  : modes.length > 0 && (
                      <optgroup label={t('upscale.profileGroup')}>
                        {modes.map((mode) => (
                          <option key={mode} value={mode}>
                            {mode}
                          </option>
                        ))}
                      </optgroup>
                    )}
              </select>
            </div>
            {!onMagpie && (
              // `pre-line` because this one is written in paragraphs: it walks through five
              // choices and which to pick, and collapsed into a single block nobody reads
              // past the first line. The blank lines in the dictionary entry are the layout.
              <p className="settings-hint" style={{ marginTop: 0, whiteSpace: 'pre-line' }}>
                {t('settings.losslessPresetHint')}
              </p>
            )}
            {/* The same rule that paragraph states, worked out on the screen actually
                plugged in. The hint used to carry one machine's numbers, which made it
                wrong on every other machine. Absent when nothing has been measured. */}
            {!onMagpie && display !== null && halfScreen !== null && (
              <p className="settings-hint" style={{ marginTop: 0 }}>
                {t('settings.losslessIntegerFit', {
                  screen: `${display.width}×${display.height}`,
                  half: halfScreen
                })}
              </p>
            )}
            {!onMagpie && heavyForThisGpu && (
              <p className="settings-hint" style={{ marginTop: 0, color: 'var(--warn)' }}>
                {t('settings.presetHeavyGpu')}
              </p>
            )}
            {!onMagpie && modes.length === 0 && (
              <p className="settings-hint" style={{ marginTop: 0 }}>
                {t('settings.losslessNoModes')}
              </p>
            )}
            {/* The setting holds one name for both backends, so switching can leave it
                pointing at a Magpie mode. Said here rather than left to be discovered at
                launch, by which time the game has already started unscaled. Presets are
                always valid, so this only fires on a name that was meant to be a profile. */}
            {!onMagpie && !known.includes(chosenMode) && (
              <p className="settings-hint" style={{ marginTop: 0, color: 'var(--warn)' }}>
                {t('settings.losslessModeMissing', { mode: chosenMode })}
              </p>
            )}

            {onMagpie ? (
              <div className="settings-row">
                <label htmlFor="magpieElevate">
                  {t('settings.magpieElevate')}
                  <span className="settings-hint">{t('settings.magpieElevateHint')}</span>
                </label>
                <button
                  id="magpieElevate"
                  type="button"
                  className={`switch${settings.magpieElevate ? ' on' : ''}`}
                  onClick={() => onChange({ magpieElevate: !settings.magpieElevate })}
                />
              </div>
            ) : (
              <div className="settings-row">
                <label htmlFor="losslessDelay">
                  {t('settings.losslessDelay')}
                  <span className="settings-hint">{t('settings.losslessDelayHint')}</span>
                </label>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input
                    id="losslessDelay"
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={settings.losslessDelay}
                    onChange={(e) => onChange({ losslessDelay: Number(e.target.value) })}
                  />
                  <span style={{ width: 44, fontSize: 12.5, color: 'var(--ink-soft)' }}>
                    {t('settings.losslessSeconds', { n: settings.losslessDelay })}
                  </span>
                </span>
              </div>
            )}

            <div className="settings-row">
              {/* Ordered by what the user most needs to know. For Magpie a foreign instance
                  means nothing will scale at all, and saying "ready" over that would be a
                  lie; for Lossless Scaling the equivalent is not being found, which is the
                  ordinary state for anybody who has not bought it. */}
              <span className="settings-hint">
                {/* The null case is its own answer, not the negative one. Locating Lossless
                    Scaling reads the registry through PowerShell and takes a moment, and
                    "not found" said during that moment is a claim rather than a wait — the
                    exact wrong thing to show somebody who does have it installed. */}
                {upscaler === null
                  ? t('settings.upscaleChecking')
                  : magpie !== null
                    ? magpie.foreign
                      ? t('settings.magpieForeignShort')
                      : magpie.running
                        ? magpie.forGame
                          ? t('settings.magpieRunningFor', {
                              name: t('common.quoted', { name: magpie.forGame }),
                              version: magpie.version
                            })
                          : t('settings.magpieRunning', { version: magpie.version })
                        : magpie.installed
                          ? t('settings.magpieReady', { version: magpie.version })
                          : t('settings.magpieNotInstalled')
                    : !lossless?.installed
                      ? t('settings.losslessNotFound')
                      : lossless.running
                        ? lossless.forGame
                          ? t('settings.losslessRunningFor', {
                              name: t('common.quoted', { name: lossless.forGame })
                            })
                          : t('settings.losslessRunning')
                        : t('settings.losslessReady')}
                {upscaleOverrides > 0 &&
                  ` · ${t('settings.upscaleOverrides', { n: upscaleOverrides })}`}
                {!onMagpie &&
                  lossless !== null &&
                  lossless.profiles > 0 &&
                  ` · ${t('settings.losslessProfiles', { n: lossless.profiles })}`}
              </span>
              {(onMagpie ? magpie?.installed : lossless?.installed) && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void window.sakura.revealUpscaler()}
                >
                  {t('settings.upscaleFolder')}
                </button>
              )}
            </div>
            {/* Its own setting, read and never written — worth saying because it explains
                the UAC prompt at launch and why a copy started that way cannot be stopped
                from here. */}
            {!onMagpie && lossless?.startsElevated && (
              <p className="settings-hint" style={{ marginTop: 0 }}>
                {t('settings.losslessElevates')}
              </p>
            )}

            {/* The way out of this page and into the settings this one does not carry.
                Last, because it leaves: everything above is answerable here. */}
            <div className="settings-row">
              <label htmlFor="upscaleOpen">
                {t('settings.upscaleOpen')}
                <span className="settings-hint">
                  {onMagpie ? t('settings.magpieOpenHint') : t('settings.losslessOpenHint')}
                </span>
              </label>
              <button
                id="upscaleOpen"
                type="button"
                className="btn ghost"
                disabled={blocked || (!onMagpie && lossless !== null && !lossless.installed)}
                onClick={() => void window.sakura.openUpscalerSettings()}
              >
                {t('settings.upscaleOpen')}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>{t('settings.tagsSection')}</div>
        <p className="settings-hint" style={{ marginTop: 0 }}>{t('settings.tagsNote')}</p>

        <div className="settings-row">
          <label htmlFor="onlineTags">
            {t('settings.onlineTags')}
            <span className="settings-hint">{t('settings.onlineTagsNote')}</span>
          </label>
          <button
            id="onlineTags"
            type="button"
            className={`switch${settings.onlineTags ? ' on' : ''}`}
            onClick={() => onChange({ onlineTags: !settings.onlineTags })}
          />
        </div>

        {/* A sub-switch of the one above: with the catalogue off, nothing here can
            happen. It is separate because covers change *what* leaves the machine —
            a request to an image host, rather than a title to an API. */}
        {settings.onlineTags && (
          <div className="settings-row">
            <label htmlFor="onlineCovers">
              {t('settings.onlineCovers')}
              <span className="settings-hint">{t('settings.onlineCoversNote')}</span>
            </label>
            <button
              id="onlineCovers"
              type="button"
              className={`switch${settings.onlineCovers ? ' on' : ''}`}
              onClick={() => onChange({ onlineCovers: !settings.onlineCovers })}
            />
          </div>
        )}

        {/* Under covers rather than beside them: the description arrives on the same
            request, so with covers off there is nothing for this to ride along with. */}
        {settings.onlineTags && settings.onlineCovers && (
          <div className="settings-row">
            <label htmlFor="onlineSummary">
              {t('settings.onlineSummary')}
              <span className="settings-hint">{t('settings.onlineSummaryNote')}</span>
            </label>
            <button
              id="onlineSummary"
              type="button"
              className={`switch${settings.onlineSummary ? ' on' : ''}`}
              onClick={() => onChange({ onlineSummary: !settings.onlineSummary })}
            />
          </div>
        )}

        {/* Under the description switch, which is the only thing it can act on. */}
        {settings.onlineTags && settings.onlineCovers && settings.onlineSummary && (
          <div className="settings-row">
            <label htmlFor="translateSummary">
              {t('settings.translateSummary')}
              <span className="settings-hint">{t('settings.translateSummaryNote')}</span>
            </label>
            <button
              id="translateSummary"
              type="button"
              className={`switch${settings.translateSummary ? ' on' : ''}`}
              onClick={() => onChange({ translateSummary: !settings.translateSummary })}
            />
          </div>
        )}

        {/* Only worth asking about once there is something they could reveal. */}
        {settings.onlineTags && (
          <div className="settings-row">
            <label htmlFor="adultTags">
              {t('settings.adultTags')}
              <span className="settings-hint">{t('settings.adultTagsNote')}</span>
            </label>
            <button
              id="adultTags"
              type="button"
              className={`switch${settings.adultTags ? ' on' : ''}`}
              onClick={() => onChange({ adultTags: !settings.adultTags })}
            />
          </div>
        )}

        {settings.onlineTags && (
          <div className="settings-row">
            <label htmlFor="spoilerTags">
              {t('settings.spoilerTags')}
              <span className="settings-hint">{t('settings.spoilerTagsNote')}</span>
            </label>
            <button
              id="spoilerTags"
              type="button"
              className={`switch${settings.spoilerTags ? ' on' : ''}`}
              onClick={() => onChange({ spoilerTags: !settings.spoilerTags })}
            />
          </div>
        )}

        <div className="settings-row">
          <label>
            {t('tags.compute')}
            <span className="settings-hint">
              {/* The switch is not a preference here, it is the whole feature — so say
                  that rather than leaving a dead button and no explanation. */}
              {!settings.onlineTags
                ? t('tags.needOnline')
                : pendingCount > 0
                  ? t('tags.pendingCount', { n: pendingCount })
                  : t('tags.allDone')}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {tagProgress && (
              <span className="settings-hint" style={{ margin: 0 }}>
                {t('tags.progress', {
                  done: tagProgress.done,
                  total: tagProgress.total,
                  name: tagProgress.name
                })}
              </span>
            )}
            {tagProgress ? (
              /* A pass over a large library runs for minutes. Somebody who started it by
                 mistake, or who can see the catalogue is not answering, needs a way out
                 that is not killing the program. */
              <button type="button" className="btn ghost" onClick={onCancelTags}>
                {t('tags.cancel')}
              </button>
            ) : (
              settings.onlineTags &&
              pendingCount === 0 &&
              gameCount > 0 && (
                <button type="button" className="btn ghost" onClick={onRedoTags}>
                  {t('tags.redoAll')}
                </button>
              )
            )}
            <button
              type="button"
              className="btn primary"
              disabled={tagProgress !== null || !settings.onlineTags || pendingCount === 0}
              onClick={onComputeTags}
            >
              {tagProgress ? t('tags.computing') : t('tags.compute')}
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>{t('settings.downloadSection')}</div>

        <div className="settings-row">
          <label>
            {t('settings.downloadDir')}
            <span className="settings-hint">
              {t('settings.downloadDirHint')}
            </span>
          </label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-soft)', wordBreak: 'break-all' }}>
              {settings.downloadDir ?? settings.roots[0] ?? t('settings.noDirYet')}
              {settings.downloadDir === null && settings.roots[0] && t('settings.followsRoot')}
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                const dir = await window.sakura.pickDownloadDir()
                if (dir) onChange({ downloadDir: dir })
              }}
            >
              {t('settings.pick')}
            </button>
            {settings.downloadDir && (
              <button type="button" className="btn ghost" onClick={() => onChange({ downloadDir: null })}>
                {t('settings.resetDefault')}
              </button>
            )}
          </div>
        </div>

        <div className="settings-row">
          <label htmlFor="downloader">{t('download.downloader')}</label>
          <select
            id="downloader"
            className="field"
            value={settings.downloader}
            onChange={(e) => onChange({ downloader: e.target.value as DownloaderKey })}
          >
            {DOWNLOADERS.map((d) => (
              <option key={d.key} value={d.key}>
                {t(`downloader.${d.key}` as MessageKey)}
              </option>
            ))}
          </select>
        </div>

        <p className="settings-note">
          {current ? t(`downloader.${current.key}.note` as MessageKey) : ''}
        </p>

        {settings.downloader !== 'system' && (
          <div className="settings-row">
            <label>{t('settings.downloaderProgram')}</label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-soft)', wordBreak: 'break-all' }}>
                {settings.downloaderPath ??
                  (settings.downloader === 'idm'
                    ? detected === undefined
                      ? t('settings.detecting')
                      : (detected ?? t('settings.notFoundIdm'))
                    : t('settings.notSet'))}
                {settings.downloaderPath === null && detected && t('settings.autoDetected')}
              </span>
              <button
                type="button"
                className="btn ghost"
                onClick={async () => {
                  const exe = await window.sakura.pickExePath()
                  if (exe) onChange({ downloaderPath: exe })
                }}
              >
                {t('settings.pick')}
              </button>
              {settings.downloaderPath && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => onChange({ downloaderPath: null })}
                >
                  {t('settings.clear')}
                </button>
              )}
            </div>
          </div>
        )}

        {settings.downloader === 'custom' && (
          <div className="settings-row">
            <label htmlFor="dlargs">
              {t('settings.argTemplate')}
              <span className="settings-hint">
                {t('settings.argTemplateHint')}
              </span>
            </label>
            <input
              id="dlargs"
              className="field"
              spellCheck={false}
              value={settings.downloaderArgs}
              placeholder="{url} -o {dir}"
              onChange={(e) => onChange({ downloaderArgs: e.target.value })}
            />
          </div>
        )}

        <div className="settings-row">
          <label htmlFor="trashArchive">
            {t('settings.trashArchive')}
            <span className="settings-hint">
              {t('settings.trashArchiveHint')}
            </span>
          </label>
          <button
            id="trashArchive"
            type="button"
            className={`switch${settings.trashArchiveAfterExtract ? ' on' : ''}`}
            onClick={() => onChange({ trashArchiveAfterExtract: !settings.trashArchiveAfterExtract })}
          />
        </div>
      </div>

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>{t('settings.backupSection')}</div>

        <div className="settings-row">
          <label>
            {t('settings.backupDir')}
            <span className="settings-hint">{t('settings.backupDirHint')}</span>
          </label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-soft)', wordBreak: 'break-all' }}>
              {settings.backupDir ?? backupDir}
              {settings.backupDir === null && t('settings.backupDirDefault')}
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                const dir = await window.sakura.pickBackupDir()
                if (dir) onChange({ backupDir: dir })
              }}
            >
              {t('settings.pick')}
            </button>
            {settings.backupDir && (
              <button type="button" className="btn ghost" onClick={() => onChange({ backupDir: null })}>
                {t('settings.resetDefault')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>{t('settings.externalSection')}</div>

        <div className="settings-row">
          <label>Geek Uninstaller</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-soft)', wordBreak: 'break-all' }}>
              {settings.geekPath ?? t('settings.geekNotSet')}
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                const exe = await window.sakura.pickExePath()
                if (exe) onChange({ geekPath: exe })
              }}
            >
              {t('settings.pick')}
            </button>
            {settings.geekPath && (
              <button type="button" className="btn ghost" onClick={() => onChange({ geekPath: null })}>
                {t('settings.clear')}
              </button>
            )}
          </div>
        </div>

        <div className="settings-row">
          <label>7-Zip</label>
          <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
            {has7z === null
              ? t('settings.7zChecking')
              : has7z
                ? t('settings.7zFound')
                : t('settings.7zMissing')}
          </span>
        </div>
      </div>
    </div>
  )
}
