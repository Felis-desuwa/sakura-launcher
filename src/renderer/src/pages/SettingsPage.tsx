import { useEffect, useState } from 'react'
import type { Lang, MessageKey } from '../../../shared/i18n'
import { LANGS } from '../../../shared/i18n'
import type { DownloaderKey, Settings, SortKey, TabKey } from '../../../shared/types'
import { DOWNLOADERS, POLL_CHOICES, SORT_KEYS, TAB_KEYS, THEMES } from '../../../shared/types'
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
  gameCount
}: Props): React.JSX.Element {
  const t = useT()
  const [has7z, setHas7z] = useState<boolean | null>(null)
  /** undefined while the probe is still running, so "not found" is not shown too early. */
  const [detected, setDetected] = useState<string | null | undefined>(undefined)
  /** The suggested backup folder, shown when the user has not named one. */
  const [backupDir, setBackupDir] = useState('')

  useEffect(() => {
    window.sakura.has7z().then(setHas7z)
  }, [])

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
