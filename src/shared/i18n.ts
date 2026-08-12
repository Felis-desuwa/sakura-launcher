/**
 * Every word the program says, in both languages it speaks.
 *
 * One flat dictionary rather than per-language files. The two translations of a string
 * sit on the same line, which is the only arrangement that makes drift visible: a phrase
 * reworded in Chinese and forgotten in English is obvious here and invisible in two
 * files kept side by side. `MessageKey` is derived from the dictionary, so a key that
 * does not exist is a compile error rather than a blank space on screen.
 *
 * Both processes share this. The main process needs it for the text it produces itself —
 * launch failures, diagnosis findings, the sidecar written into every game folder — and
 * the renderer for everything else.
 */

export type Lang = 'zh' | 'en'

export const LANGS: { key: Lang; label: string; note: string }[] = [
  { key: 'zh', label: '简体中文', note: '' },
  { key: 'en', label: 'English', note: '' }
]

/** Interpolation values. Numbers are formatted by the caller, not here. */
export type Vars = Record<string, string | number>

interface Entry {
  zh: string
  en: string
}

/**
 * Look a message up.
 *
 * Placeholders are `{name}`. A missing variable is left as written rather than replaced
 * with "undefined" — a visible `{name}` in a screenshot is a bug report, while the word
 * "undefined" reads like an application error to the person holding the screenshot.
 */
export function translate(dict: Record<string, Entry>, lang: Lang, key: string, vars?: Vars): string {
  const entry = dict[key]
  if (!entry) return key
  const text = entry[lang] || entry.zh
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  )
}

/* -------------------------------------------------------------------------- */

export const MESSAGES = {
  /* ---- shell ---- */
  'app.title': { zh: 'Sakura Launcher', en: 'Sakura Launcher' },
  'tab.all': { zh: '全部', en: 'All' },
  'tab.wishlist': { zh: '想玩', en: 'Wishlist' },
  'tab.playing': { zh: '在玩', en: 'Playing' },
  'tab.played': { zh: '玩过', en: 'Played' },

  'page.library': { zh: '书架', en: 'Library' },
  'page.tier': { zh: '评价', en: 'Tiers' },
  'page.wishlist': { zh: '想玩选择', en: 'Pick a game' },
  'page.disk': { zh: '磁盘', en: 'Disk' },
  'page.settings': { zh: '设置', en: 'Settings' },

  'top.search': { zh: '搜索游戏…', en: 'Search games…' },
  'top.refresh': { zh: '刷新', en: 'Refresh' },
  'top.refreshing': { zh: '刷新中…', en: 'Refreshing…' },
  'top.download': { zh: '下载新游戏', en: 'Download a game' },
  'top.back': { zh: '← 返回桌面', en: '← Back to library' },
  'top.sortTitle': { zh: '排序方式', en: 'Sort by' },
  'top.refreshTitle': {
    zh: '重新读取已有条目：名称、体积、说明文件与是否还在原处。要收录新游戏请到「设置 → 扫描文件夹 → 重新扫描并添加」',
    en: 'Re-read what is already in the library: names, sizes, sidecar files, and whether each folder is still there. To take in new games, go to Settings → Library folders → Rescan and add.'
  },

  'win.minimize': { zh: '最小化', en: 'Minimise' },
  'win.maximize': { zh: '最大化', en: 'Maximise' },
  'win.restore': { zh: '向下还原', en: 'Restore down' },
  'win.close': { zh: '关闭', en: 'Close' },

  'sort.manual': { zh: '手动', en: 'Manual' },
  'sort.name': { zh: '名称', en: 'Name' },
  'sort.size': { zh: '体积', en: 'Size' },
  'sort.mtime': { zh: '安装/修改时间', en: 'Installed / updated' },
  'sort.recent': { zh: '最近启动', en: 'Last launched' },
  'sort.playtime': { zh: '游玩时长', en: 'Playtime' },

  /* ---- settings ---- */
  'settings.appearance': { zh: '外观与行为', en: 'Appearance and behaviour' },
  'settings.language': { zh: '语言', en: 'Language' },
  'settings.languageHint': {
    zh: '同时决定写进每个游戏文件夹的 sakura-launcher.md 用哪种语言。两种格式都能读回，所以切换不会弄丢任何已记录的内容 —— 只是下次同步会把那些文件重写一遍。',
    en: 'Also sets the language of the sakura-launcher.md written into each game folder. Both formats are read back, so switching loses nothing already recorded — it only means the next sync rewrites those files.'
  },
  'settings.theme': { zh: '主题', en: 'Theme' },
  'settings.defaultTab': { zh: '默认启动标签页', en: 'Tab to open on start' },
  'download.paste': { zh: '粘贴下载链接', en: 'Paste download links' },
  'download.placeholder': {
    zh: '一行一条链接，可以一次贴多条\nhttps://example.com/game.7z.001',
    en: 'One link per line; several at once is fine\nhttps://example.com/game.7z.001'
  },
  'download.noDir': { zh: '尚未设置下载目录', en: 'No download folder set yet' },
  'download.change': { zh: '更改…', en: 'Change…' },
  'download.openSettings': { zh: '设置…', en: 'Settings…' },
  'download.noDirControl': {
    zh: '保存位置由它自己决定，上面选的目录只用来判断下载是否完成。',
    en: 'It decides where the file lands; the folder above is only used to tell when the download has finished.'
  },
  'download.autoImport': {
    zh: '下完之后会自动解压并加入游戏库。',
    en: 'When it finishes, the archive is extracted and added to the library automatically.'
  },
  'download.starting': { zh: '正在唤起下载器…', en: 'Handing it over…' },
  'download.start': { zh: '开始下载', en: 'Start download' },
  'download.startN': { zh: '开始下载 {n} 条', en: 'Download {n} links' },
  'download.saveTo': { zh: '保存到', en: 'Save to' },
  'download.downloader': { zh: '下载器', en: 'Downloader' },
  'download.needPath': {
    zh: '还没有指定 {name} 的可执行文件，先去设置里填好才能开始。',
    en: 'No executable has been given for {name}. Fill it in under Settings before starting.'
  },
  'settings.defaultSort': { zh: '默认排序', en: 'Default sort' },

  /* ---- tiers ---- */
  'tier.unrated': { zh: '未评级', en: 'Unrated' },

  /* ---- duration ---- */
  'time.zero': { zh: '0 分', en: '0 min' },
  'time.under1': { zh: '不到 1 分', en: 'under a minute' },
  'time.minutes': { zh: '{n} 分', en: '{n} min' },
  'time.hours': { zh: '{n} 小时', en: '{n} h' },
  'time.hoursMinutes': { zh: '{h} 小时 {m} 分', en: '{h} h {m} min' },
  'time.never': { zh: '从未', en: 'never' },

  /* ---- themes ---- */
  'theme.sakura': { zh: '樱花', en: 'Sakura' },
  'theme.sakura.note': { zh: '默认', en: 'default' },
  'theme.midnight': { zh: '夜樱', en: 'Midnight' },
  'theme.midnight.note': { zh: '深色', en: 'dark' },
  'theme.miku': { zh: '初音', en: 'Miku' },
  'theme.miku.note': { zh: '青绿', en: 'teal' },
  'theme.matcha': { zh: '抹茶', en: 'Matcha' },
  'theme.matcha.note': { zh: '', en: '' },
  'theme.ocean': { zh: '海盐', en: 'Sea salt' },
  'theme.ocean.note': { zh: '', en: '' },
  'theme.lavender': { zh: '薰衣草', en: 'Lavender' },
  'theme.lavender.note': { zh: '', en: '' },

  /* ---- downloaders ---- */
  'downloader.idm': { zh: 'Internet Download Manager', en: 'Internet Download Manager' },
  'downloader.idm.note': {
    zh: '自动探测安装路径。IDM 不回报进度，完成靠监视下载目录判定。',
    en: 'Its install path is detected automatically. IDM reports no progress, so completion is judged by watching the download folder.'
  },
  'downloader.aria2': { zh: 'aria2c', en: 'aria2c' },
  'downloader.aria2.note': {
    zh: '唯一能给出真实进度和确切完成信号的选项，需要自备 aria2c.exe。',
    en: 'The only option that reports real progress and a definite finish. You supply aria2c.exe yourself.'
  },
  'downloader.system': { zh: '系统默认 / 浏览器', en: 'System default / browser' },
  'downloader.system.note': {
    zh: '交给系统打开链接。兼容性最好，但保存位置由浏览器决定，未必是这里选的目录。',
    en: 'Hands the link to whatever opens it. Works everywhere, but the browser decides where the file lands — not necessarily the folder chosen here.'
  },
  'downloader.custom': { zh: '自定义命令行', en: 'Custom command line' },
  'downloader.custom.note': {
    zh: '自己填可执行文件与参数模板，占位符 {url} {dir} {name}。',
    en: 'Give an executable and an argument template. Placeholders: {url} {dir} {name}.'
  },

  /* ---- share categories and formats ---- */
  'share.cat.launcher': { zh: '启动器写的文件', en: 'Files the launcher wrote' },
  'share.cat.launcher.hint': {
    zh: '游玩时长、评分、标签和每一次游玩记录都在里面',
    en: 'Playtime, rating, tags and every session it has recorded'
  },
  'share.cat.save': { zh: '存档', en: 'Saves' },
  'share.cat.save.hint': {
    zh: '你的进度。留在包里就是把通关记录一起发出去',
    en: 'Your progress. Leaving them in means sending your playthrough along with the game'
  },
  'share.cat.noise': { zh: '日志 · 截图 · 临时文件', en: 'Logs · screenshots · temporary files' },
  'share.cat.noise.hint': {
    zh: '跑出来的杂物，对方并不需要',
    en: 'Debris from running it. Nobody on the other end needs any of it'
  },
  'share.cat.config': { zh: '设置文件（默认不排除）', en: 'Settings files (not excluded by default)' },
  'share.cat.config.hint': {
    zh: '可能存了你的用户名或窗口位置，但也可能是游戏启动必需的 —— 拿不准就别动',
    en: 'These may hold your name or window position, but some engines will not start without them — leave them alone unless you are sure'
  },
  'share.format.7z.note': {
    zh: '压缩率最好，可连文件名一起加密。对方需要 7-Zip',
    en: 'Best compression, and it can encrypt the file names too. The recipient needs 7-Zip'
  },
  'share.format.zip.note': {
    zh: '到处都能打开。加密用 AES-256，但文件名是明文',
    en: 'Opens anywhere. Encryption is AES-256, but the file list stays readable'
  },

  /* ---- engines ---- */
  'engine.kirikiri.note': {
    zh: '吉里吉里 / KAG，资源打包在 .xp3 里',
    en: 'KiriKiri / KAG. Assets are packed into .xp3 files'
  },
  'engine.bgi.note': {
    zh: 'BURIKO General Interpreter，本体是根目录的 .arc',
    en: 'BURIKO General Interpreter. The game itself is the .arc files in the root folder'
  },
  'engine.siglus.note': { zh: 'Key / VisualArt’s 系', en: 'Used by Key and VisualArt’s titles' },
  'engine.majiro.note': { zh: '', en: '' },
  'engine.nscripter.note': { zh: '', en: '' },
  'engine.artemis.note': { zh: '资源打包在 .pfs 里', en: 'Assets are packed into .pfs files' },
  'engine.renpy.note': {
    zh: 'Python 写的，日志在游戏目录里',
    en: 'Written in Python; it leaves its log in the game folder'
  },
  'engine.rpgmaker.note': { zh: '', en: '' },
  'engine.wolf.note': { zh: '', en: '' },
  'engine.unity.note': {
    zh: '日志写在 %LOCALAPPDATA%Low 下',
    en: 'Writes its log under %LOCALAPPDATA%Low'
  },
  'engine.unreal.note': { zh: '', en: '' },
  'engine.tyrano.note': { zh: '', en: '' },
  'engine.nwjs.note': { zh: 'Chromium 套壳', en: 'A Chromium shell' },

  /* ---- runtimes the diagnosis can name ---- */
  'runtime.vc2015': { zh: 'Visual C++ 2015-2022 运行库', en: 'Visual C++ 2015-2022 Redistributable' },
  'runtime.vc2015.note': {
    zh: '微软官方下载页叫「Visual C++ Redistributable」，装 x86 与 x64 两个版本最省事',
    en: 'Microsoft lists it as “Visual C++ Redistributable”. Installing both the x86 and x64 builds saves trouble later'
  },
  'runtime.vc2013': { zh: 'Visual C++ 2013 运行库', en: 'Visual C++ 2013 Redistributable' },
  'runtime.vc2013.note': { zh: '版本号 12.0', en: 'Version 12.0' },
  'runtime.vc2012': { zh: 'Visual C++ 2012 运行库', en: 'Visual C++ 2012 Redistributable' },
  'runtime.vc2012.note': { zh: '版本号 11.0', en: 'Version 11.0' },
  'runtime.vc2010': { zh: 'Visual C++ 2010 运行库', en: 'Visual C++ 2010 Redistributable' },
  'runtime.vc2010.note': {
    zh: '版本号 10.0 —— 这个年代的日系游戏最常缺它',
    en: 'Version 10.0 — the one Japanese games of that era are missing most often'
  },
  'runtime.vc2008': { zh: 'Visual C++ 2008 运行库', en: 'Visual C++ 2008 Redistributable' },
  'runtime.vc2008.note': { zh: '版本号 9.0', en: 'Version 9.0' },
  'runtime.vc2005': { zh: 'Visual C++ 2005 运行库', en: 'Visual C++ 2005 Redistributable' },
  'runtime.vc2005.note': { zh: '版本号 8.0', en: 'Version 8.0' },
  'runtime.directx': {
    zh: 'DirectX 末端用户运行库（DirectX End-User Runtime）',
    en: 'DirectX End-User Runtime'
  },
  'runtime.directx.note': {
    zh: '系统自带的 DirectX 不含这些旧组件，必须单独装一次，装完是永久的',
    en: 'The DirectX that ships with Windows does not include these older components. Installing it once is permanent'
  },
  'runtime.dotnet': { zh: '.NET Framework', en: '.NET Framework' },
  'runtime.dotnet.note': { zh: '', en: '' },
  'runtime.mediafeature': { zh: 'Media Feature Pack', en: 'Media Feature Pack' },
  'runtime.mediafeature.note': {
    zh: 'N 版或 KN 版 Windows 缺少媒体组件，视频过场会让游戏直接起不来',
    en: 'N and KN editions of Windows ship without the media components, and a video cutscene then stops the game dead'
  },
  'runtime.openal': { zh: 'OpenAL', en: 'OpenAL' },
  'runtime.openal.note': {
    zh: '游戏目录里通常自带 oalinst.exe',
    en: 'The game folder usually carries oalinst.exe already'
  },
  'runtime.physx': { zh: 'NVIDIA PhysX 系统软件', en: 'NVIDIA PhysX System Software' },
  'runtime.physx.note': { zh: '', en: '' },

  /* ---- locale-emulator reasoning ---- */
  'diag.locale.engineReason': {
    zh: '{engine} 是按日文系统写的引擎，走的是 ANSI 接口',
    en: '{engine} was written for a Japanese system and goes through the ANSI APIs'
  },
  'diag.locale.kanaReason': { zh: '文件名里有日文假名', en: 'File names contain Japanese kana' },
  'diag.locale.mojibakeReason': {
    zh: '文件名已经是乱码的：{names}',
    en: 'File names are already mojibake: {names}'
  },
  'diag.locale.acpReason': {
    zh: '当前系统非 Unicode 程序用的是代码页 {acp}，不是日文的 932',
    en: 'Non-Unicode programs on this machine use codepage {acp}, not Japanese 932'
  },

  /* ---- diagnosis findings ---- */
  'diag.joinSentence': { zh: '{a}。{b}', en: '{a}. {b}' },
  'diag.notFound': { zh: '找不到 {names}', en: 'Could not find {names}' },
  'diag.arch16': { zh: '16 位', en: '16-bit' },

  'diag.missingRuntime.title': { zh: '缺 {pkg}', en: '{pkg} is missing' },
  'diag.missingRuntime.detail': {
    zh: '装上之后这个游戏，以及库里所有同样缺它的游戏，都会一起好。',
    en: 'Installing it fixes this game and every other one in the library that is missing the same thing.'
  },
  'diag.missingDll.title': {
    zh: '缺文件，但不是常见运行库',
    en: 'Files are missing, and not from a known runtime'
  },
  'diag.missingDll.detail': {
    zh: '这些 DLL 本该和游戏一起分发。多半是压缩包没解全，或者解压时被杀毒软件删掉了 —— 重新解压一次通常就能解决。',
    en: 'These DLLs were meant to ship with the game. Usually the archive was not fully extracted, or an antivirus removed them on the way out — extracting it again normally settles it.'
  },
  'diag.delayMissing.title': {
    zh: '有几个延迟加载的 DLL 找不到',
    en: 'Some delay-loaded DLLs are missing'
  },
  'diag.delayMissing.detail': {
    zh: '这类 DLL 只有用到时才加载，缺了不一定影响启动 —— 但如果游戏是走到某个画面才崩，大概率就是它们。',
    en: 'These load only when something needs them, so a missing one need not stop the game starting — but if it crashes on reaching some particular screen, this is very likely why.'
  },
  'diag.needsAdmin.title': {
    zh: '这个程序要求以管理员身份运行',
    en: 'This program demands administrator rights'
  },
  'diag.needsAdmin.detail': {
    zh: '它的清单里写着 requireAdministrator。双击磁贴时启动器是普通权限，系统会直接拒绝，看上去就是毫无反应。',
    en: 'Its manifest says requireAdministrator. Double-clicking the tile launches it with ordinary rights, Windows refuses outright, and what you see is nothing happening at all.'
  },
  'diag.needsAdmin.reason': {
    zh: '内嵌 manifest 的 requestedExecutionLevel 是 requireAdministrator',
    en: 'The embedded manifest sets requestedExecutionLevel to requireAdministrator'
  },
  'diag.noExe.title': { zh: '这个条目没有主程序', en: 'This entry has no main program' },
  'diag.noExe.detail': {
    zh: '库里记着这个文件夹，但没有记着该运行哪个程序。',
    en: 'The library has the folder recorded but not which program to run.'
  },
  'diag.exeGone.title': { zh: '主程序不在了', en: 'The main program is gone' },
  'diag.exeGone.detail': {
    zh: '{exe} 已经不存在 —— 文件被移走、改名，或者所在的盘没挂上。',
    en: '{exe} no longer exists — moved, renamed, or on a drive that is not mounted.'
  },
  'diag.notExe.title': { zh: '这个文件不是可执行程序', en: 'This file is not an executable' },
  'diag.notExe.detail': {
    zh: '它的文件头不是任何一种 Windows 可执行格式。多半是主程序选错了。',
    en: 'Its header is not any Windows executable format. The main program is probably set to the wrong file.'
  },
  'diag.bit16.title': {
    zh: '16 位程序，64 位 Windows 跑不了',
    en: 'A 16-bit program, which 64-bit Windows cannot run'
  },
  'diag.bit16.detail': {
    zh: '这是 DOS 或 16 位 Windows 时代的程序。64 位 Windows 移除了运行它们的子系统，没有补丁能改变这一点 —— 要跑只能用 DOSBox 之类的模拟器。',
    en: 'This is from the DOS or 16-bit Windows era. 64-bit Windows removed the subsystem that ran them and no patch changes that — it takes an emulator such as DOSBox.'
  },
  'diag.bit16.reason': { zh: '文件头不是 PE', en: 'The header is not a PE header' },
  'diag.badArch.title': { zh: '这是 {arch} 版本的程序', en: 'This is an {arch} build' },
  'diag.badArch.detail': {
    zh: '当前这台机器的处理器架构跑不了它。',
    en: 'This machine’s processor architecture cannot run it.'
  },
  'diag.badArch.reason': {
    zh: 'PE 头里的 Machine 字段是 {arch}',
    en: 'The Machine field in the PE header says {arch}'
  },
  'diag.wrongExe.title': {
    zh: '现在选的可能不是游戏本体',
    en: 'The program currently selected may not be the game'
  },
  'diag.wrongExe.detail': {
    zh: '{name} 看起来是{kind}。换成真正的主程序试试。',
    en: '{name} looks like {kind}. Try pointing the launcher at the real one.'
  },
  'diag.wrongExe.uninstaller': { zh: '卸载程序', en: 'an uninstaller' },
  'diag.wrongExe.patch': { zh: '补丁', en: 'a patch' },
  'diag.wrongExe.tool': { zh: '工具或设置程序', en: 'a tool or settings program' },
  'diag.wrongExe.fallbackReason': { zh: '文件名特征', en: 'Judged from the file name' },
  'diag.localeNoArgs.title': {
    zh: '选的是区域模拟器，但没告诉它要启动什么',
    en: 'A locale emulator is selected, with nothing told to it'
  },
  'diag.localeNoArgs.detail': {
    zh: '{name} 是区域模拟器。单独运行它只会打开它自己的界面。在「更换主程序…」里把要启动的游戏作为参数配上，双击磁贴才会是完整的那一串。',
    en: '{name} is a locale emulator. Run on its own it just opens its own window. In “Change main program…”, give it the game to start as an argument — then double-clicking the tile runs the whole chain.'
  },
  'diag.localeNoArgs.reason': {
    zh: '主程序是区域模拟器，且没有记录启动参数',
    en: 'The main program is a locale emulator and no launch arguments are recorded'
  },
  'diag.needsLocale.title': {
    zh: '这个游戏多半要用区域模拟器启动',
    en: 'This game probably needs a locale emulator'
  },
  'diag.needsLocale.detail': {
    zh: '它按日文系统写成，会把文件名和脚本按系统代码页转换。在非日文系统上这一步会出错，表现通常是直接退出或者满屏乱码。用 NTLEA 或 Locale Emulator 启动能解决 —— 在「更换主程序…」里可以配成「用模拟器启动游戏本体」。',
    en: 'It was written for a Japanese system and converts file names and script text through the system codepage. On a machine set to anything else that step goes wrong, and the result is usually an instant exit or a screen full of garbage. NTLEA or Locale Emulator fixes it — set it up under “Change main program…” as “run the game through the emulator”.'
  },
  'diag.errorDialog.title': {
    zh: '游戏正弹着一个报错窗口',
    en: 'The game is showing an error message'
  },
  'diag.errorDialog.detail': {
    zh: '这是引擎自己给出的原因，比这里其它任何一条推断都可靠。',
    en: 'This is the engine’s own account of what went wrong, and it is worth more than anything else on this list.'
  },
  'diag.errorDialog.mojibakeNote': {
    zh: '原文是日文，被系统按中文代码页显示成了乱码，下面是还原后的。',
    en: ' The original is Japanese, mangled by the system codepage; below is the text recovered.'
  },
  'diag.errorDialog.windowTitle': { zh: '窗口标题：{title}', en: 'Window title: {title}' },
  'diag.errorDialog.excerpt': {
    zh: '{message}\n\n（屏幕上显示的是：{raw}）',
    en: '{message}\n\n(What is on screen: {raw})'
  },
  'diag.crashLog.title': {
    zh: '游戏留下了一份刚写的日志',
    en: 'The game left a log, written just now'
  },
  'diag.crashLog.detail': {
    zh: '{file} 是这次启动之后写的，末尾大概率就是它退出的原因。',
    en: '{file} was written after this launch, and its last lines are very likely the reason it quit.'
  },

  'diag.checked.readable': {
    zh: '主程序能不能作为可执行文件读出来',
    en: 'Whether the main program can be read as an executable'
  },
  'diag.checked.dlls': {
    zh: '主程序需要的 {n} 个 DLL 是否都能找到',
    en: 'Whether all {n} DLLs the main program needs can be found'
  },
  'diag.checked.admin': {
    zh: '主程序有没有要求管理员权限',
    en: 'Whether the main program demands administrator rights'
  },
  'diag.checked.rightExe': {
    zh: '选中的主程序是不是游戏本体',
    en: 'Whether the selected program is the game itself'
  },
  'diag.checked.codepage': {
    zh: '系统代码页与游戏文件名是否对得上',
    en: 'Whether the system codepage matches the game’s file names'
  },
  'diag.checked.dialog': {
    zh: '游戏此刻有没有弹出报错窗口',
    en: 'Whether the game is showing an error window right now'
  },
  'diag.checked.log': {
    zh: '游戏这次有没有留下日志',
    en: 'Whether the game left a log this time'
  },

  /* ---- diagnosis dialog ---- */
  'diag.step': { zh: '启动诊断', en: 'Launch diagnosis' },
  'diag.running': { zh: '正在检查…', en: 'Checking…' },
  'diag.recheck': { zh: '重新检查', en: 'Check again' },
  'diag.gone': { zh: '这个条目已经不在库里了。', en: 'This entry is no longer in the library.' },
  'diag.sev.blocker': { zh: '拦路', en: 'Blocking' },
  'diag.sev.likely': { zh: '很可能', en: 'Likely' },
  'diag.sev.note': { zh: '参考', en: 'Note' },
  'diag.becauseOf': { zh: '依据：{reasons}', en: 'Because: {reasons}' },
  'diag.fact.engine': { zh: '引擎：{engine}', en: 'Engine: {engine}' },
  'diag.fact.arch': { zh: '架构：{arch}', en: 'Architecture: {arch}' },
  'diag.fact.checked': { zh: '检查了 {n} 项', en: 'Checked {n} things' },
  'diag.clean.title': { zh: '没查出问题。', en: 'Nothing wrong found.' },
  'diag.clean.detail': {
    zh: '下面这些都看过了，都正常。如果游戏确实起不来，多半是引擎自己的问题 —— 游戏目录里若有 readme 或说明文件，值得读一眼。',
    en: 'Everything below was examined and is in order. If the game still will not start, the trouble is most likely inside the engine — if the game folder holds a readme, it is worth a look.'
  },
  'diag.lede.earlyexit': {
    zh: '进程起来过，但几秒之内就没了 —— 这通常意味着它在初始化阶段崩了。',
    en: 'A process appeared and was gone within seconds — usually that means it died during start-up.'
  },
  'diag.lede.noshow': {
    zh: '启动之后一直没有在游戏目录里看到进程。下面是能查到的原因。',
    en: 'Nothing ever ran out of the game folder after the launch. Here is what could be found out.'
  },
  'diag.lede.dialog': {
    zh: '进程还在，但它停在一个报错窗口上 —— 这次不计入游玩时长。',
    en: 'The process is still there, but it is stopped on an error window — this run is not counted as playtime.'
  },
  'diag.lede.manual': {
    zh: '下面是启动这个游戏时可能会绊住它的东西，全部在本地判定，不联网。',
    en: 'Below is anything that could trip this game up on the way to starting. All decided locally; nothing is sent anywhere.'
  },
  'diag.runAsAdmin': { zh: '以管理员身份启动', en: 'Run as administrator' },
  'diag.elevating': { zh: '等待授权…', en: 'Waiting for consent…' },
  'diag.elevated.ok': { zh: '已以管理员身份启动《{name}》', en: 'Started {name} as administrator' },
  'diag.elevated.failed': { zh: '以管理员身份启动失败', en: 'Could not run it as administrator' },

  /* ---- toasts and shell dialogs ---- */
  'toast.extractOk': { zh: '解压完成，已加入游戏库', en: 'Extracted and added to the library' },
  'toast.extractFailed': { zh: '解压失败：{error}', en: 'Extraction failed: {error}' },
  'toast.refreshed': { zh: '已刷新，库里共 {n} 个游戏', en: 'Refreshed — {n} games in the library' },
  'toast.sidecarsRead': {
    zh: '{n} 个说明文件被手动改过，已读回',
    en: '{n} sidecar files had been edited by hand and were read back'
  },
  'toast.missing': {
    zh: '有 {n} 个条目这次没找到，已保留其评级与记录',
    en: '{n} entries were not found this time; their ratings and records are kept'
  },
  'toast.nothingNew': { zh: '这个文件夹里没有可以新增的内容', en: 'Nothing new to add in that folder' },
  'toast.nothingToAdd': {
    zh: '这个文件夹里没有找到可以添加的内容',
    en: 'Nothing that could be added was found in that folder'
  },
  'toast.addFailed': { zh: '{path} 加入失败', en: 'Could not add {path}' },
  'toast.markedAs': { zh: '，已标记为「{tab}」', en: ', marked as {tab}' },
  'toast.allFailed': {
    zh: '{n} 个都没能加入：{first}',
    en: 'None of the {n} could be added: {first}'
  },
  'toast.addedOne': { zh: '已加入《{name}》{suffix}', en: 'Added {name}{suffix}' },
  'toast.addedMany': { zh: '已加入 {n} 个游戏{suffix}', en: 'Added {n} games{suffix}' },
  'toast.someFailed': {
    zh: '{headline}；{n} 个未加入：{first}',
    en: '{headline}; {n} not added: {first}'
  },
  'toast.noExeHere': { zh: '这个文件夹里没有找到可执行文件', en: 'No executable found in that folder' },
  'toast.need7z': { zh: '分享需要 7-Zip，请先安装', en: 'Sharing needs 7-Zip. Install it first' },
  'toast.added': { zh: '已添加《{name}》', en: 'Added {name}' },
  'toast.archiveNotInstalled': {
    zh: '这是未安装的压缩包 —— 右键选择「一键解压」先装上',
    en: 'This is an archive that has not been installed — right-click and choose Extract first'
  },
  'toast.launching': { zh: '正在启动《{name}》', en: 'Starting {name}' },
  'toast.launchFailed': { zh: '启动失败', en: 'Could not start it' },
  'toast.wishlistNoLaunch': {
    zh: '「想玩」清单只作规划，去「全部」或「在玩」里启动',
    en: 'The wishlist is for planning only — start games from All or Playing'
  },
  'toast.tiersCleared': { zh: '已清除全部评级', en: 'All tier ratings cleared' },
  'toast.restored': { zh: '已恢复该条目，重新扫描完成', en: 'Entry restored; rescan complete' },
  'toast.forgotten': {
    zh: '已从名单里清除，下次重新扫描该文件夹时会重新问你',
    en: 'Dropped from the list — the next rescan of that folder will ask about it again'
  },
  'toast.renamedBack': { zh: '已恢复为文件夹名', en: 'Restored to the folder name' },
  'toast.renameFailed': { zh: '重命名失败', en: 'Rename failed' },
  'toast.renamedWithSidecar': {
    zh: '已重命名，说明文件已写入游戏文件夹',
    en: 'Renamed, and the sidecar was written into the game folder'
  },
  'toast.renamedNoSidecar': {
    zh: '已重命名（无法写入游戏文件夹，仅保存在启动器内{detail}）',
    en: 'Renamed, but the game folder could not be written to — kept in the launcher only{detail}'
  },
  'toast.removeFailed': { zh: '{n} 个条目移除失败', en: '{n} entries could not be removed' },
  'toast.removedOne': {
    zh: '已移除《{name}》，磁盘上的文件未改动',
    en: 'Removed {name}. Nothing on disk was touched'
  },
  'toast.removedMany': {
    zh: '已移除 {n} 个条目，磁盘上的文件未改动',
    en: 'Removed {n} entries. Nothing on disk was touched'
  },
  'toast.setExeFailed': { zh: '设置失败', en: 'Could not set it' },
  'toast.exeSetWithArgs': {
    zh: '主程序已设为 {name}，并带上参数启动',
    en: 'Main program set to {name}, with arguments'
  },
  'toast.exeSet': { zh: '主程序已设为 {name}', en: 'Main program set to {name}' },
  'toast.ignoredCleared': { zh: '已清除 {n} 条移除记录', en: 'Cleared {n} removal records' },
  'toast.rootRemovedWith': {
    zh: '已移除该文件夹及其 {n} 个条目，磁盘文件未改动',
    en: 'Removed the folder and its {n} entries. Nothing on disk was touched'
  },
  'toast.rootRemoved': { zh: '已从扫描列表移除该文件夹', en: 'Folder removed from the scan list' },
  'toast.downloadPartial': {
    zh: '已开始 {ok} 条，{bad} 条失败：{first}',
    en: 'Started {ok}; {bad} failed: {first}'
  },
  'toast.downloadStarted': {
    zh: '已交给下载器，共 {n} 条。下载完成后会自动解压并加入库',
    en: 'Handed {n} links to the downloader. Finished downloads are extracted and added automatically'
  },
  'toast.imported': { zh: '已导入 {n} 个条目', en: 'Imported {n} entries' },
  'toast.nothingImported': {
    zh: '没有新增条目，扫描列表已更新',
    en: 'Nothing new; the scan list has been updated'
  },
  'toast.leftoverTrashed': { zh: '残留文件已移入回收站', en: 'Leftover files sent to the recycle bin' },
  'toast.cleanupFailed': { zh: '清理失败', en: 'Cleanup failed' },
  'toast.uninstallFailed': { zh: '卸载失败', en: 'Uninstall failed' },
  'toast.trashed': {
    zh: '《{name}》已移入回收站，可从回收站恢复',
    en: '{name} was sent to the recycle bin and can be restored from there'
  },
  'toast.uninstalled': { zh: '《{name}》已卸载', en: '{name} uninstalled' },
  'toast.uninstalledMany': { zh: '已卸载 {n} 个游戏', en: 'Uninstalled {n} games' },
  'toast.uninstalledPartial': {
    zh: '{ok} 个已卸载，{bad} 个失败',
    en: '{ok} uninstalled, {bad} failed'
  },
  'toast.groupsMade': { zh: '已建立 {n} 个分组', en: 'Created {n} groups' },
  'toast.dropUnreadable': {
    zh: '读不到拖入文件的路径（{n} 个），请改用「添加游戏」按钮',
    en: 'The paths of {n} dropped files could not be read — use the Add game button instead'
  },
  'toast.dropNothing': { zh: '没有拖入任何文件', en: 'No files were dropped' },

  /* ---- drop overlay ---- */
  'drop.release': { zh: '松手加入游戏库', en: 'Release to add to the library' },
  'drop.intoTab': { zh: '加入并标记为「{tab}」', en: 'Add and mark as {tab}' },
  'drop.intoAll': { zh: '直接加入「全部」', en: 'Add to All' },
  'drop.hint': { zh: '支持 .exe 与桌面快捷方式', en: 'Accepts .exe files and desktop shortcuts' },

  /* ---- onboarding ---- */
  'onboard.title': { zh: '还没有游戏库', en: 'No library yet' },
  'onboard.detail': {
    zh: '选择一个存放游戏的文件夹，Sakura 会自动扫描其中的游戏，提取每个游戏的图标，并统计它们占用的磁盘空间。扫描目录只保存在本机，不会上传到任何地方。',
    en: 'Point Sakura at a folder of games. It finds the games inside, pulls each one’s icon out of its executable, and works out how much disk they take. The folders you name are stored on this machine and sent nowhere.'
  },
  'onboard.pick': { zh: '选择文件夹开始扫描', en: 'Choose a folder to scan' },
  'onboard.single': { zh: '或者手动添加单个游戏', en: 'Or add a single game by hand' },
  'onboard.drop': {
    zh: '也可以直接把游戏的 exe 或桌面快捷方式拖进这个窗口。',
    en: 'You can also drop a game’s .exe or its desktop shortcut straight into this window.'
  },

  /* ---- rename / tags / remove dialogs ---- */
  'rename.title': { zh: '重命名《{name}》', en: 'Rename {name}' },
  'rename.placeholder': { zh: '游戏名称', en: 'Game name' },
  'rename.note': {
    zh: '新名字会写进游戏文件夹里的 sakura-launcher.md，不会改动文件夹名，也不影响游戏启动 —— 很多游戏按路径找资源，直接改文件夹名会让它们打不开。那个文件里还记着这个游戏的状态、评分、标签和游玩时长，删掉它就全部恢复默认。',
    en: 'The new name is written into sakura-launcher.md inside the game folder. The folder itself is not renamed and the game is not affected — many of these games look for their assets by path, and renaming the folder stops them opening at all. That file also holds this game’s status, rating, tags and playtime; delete it and everything returns to defaults.'
  },
  'rename.revert': { zh: '恢复原名', en: 'Use the folder name' },
  'tags.title': { zh: '《{name}》的标签', en: 'Tags for {name}' },
  'tags.placeholder': {
    zh: '用逗号分隔，例如：战棋, 已打汉化补丁',
    en: 'Comma separated, e.g. strategy, translated'
  },
  'tags.save': { zh: '保存', en: 'Save' },
  'tags.note': {
    zh: '标签会一起写进游戏文件夹里的 sakura-launcher.md，在顶部搜索框里输入标签也能筛选出对应的游戏。',
    en: 'Tags are written into sakura-launcher.md alongside everything else, and typing one into the search box filters the library by it.'
  },
  'remove.titleOne': { zh: '把《{name}》从库中移除？', en: 'Remove {name} from the library?' },
  'remove.titleMany': {
    zh: '把选中的 {n} 个条目从库中移除？',
    en: 'Remove the {n} selected entries from the library?'
  },
  'remove.confirmOne': { zh: '移除磁贴', en: 'Remove tile' },
  'remove.confirmMany': { zh: '移除 {n} 个磁贴', en: 'Remove {n} tiles' },
  'remove.detail': {
    zh: '只是把{what}从启动器里拿掉，不会删除磁盘上的任何文件 —— 用来清掉误扫进来的非游戏内容。',
    en: 'This takes {what} out of the launcher. No file on disk is deleted — it is for clearing out things the scan picked up that were never games.'
  },
  'remove.thisTile': { zh: '这个磁贴', en: 'this tile' },
  'remove.theseTiles': { zh: '这些磁贴', en: 'these tiles' },
  'remove.andMore': { zh: '…等共 {n} 个', en: '…{n} in all' },
  'remove.pathNote': {
    zh: '这{what}会被记住，之后重新扫描也不会再加回来。想恢复的话，到「设置 → 已移除的条目」里点一下即可。',
    en: 'The {what} is remembered, so a later scan will not bring it back. To undo, go to Settings → Removed entries and put it back.'
  },
  'remove.thisPath': { zh: '个路径', en: 'path' },
  'remove.thesePaths': { zh: '些路径', en: 'paths' },

  /* ---- launch trouble card ---- */
  'trouble.dialogTitle': { zh: '《{name}》停在一个报错窗口上', en: '{name} is stuck on an error window' },
  'trouble.noshowTitle': { zh: '《{name}》好像没起来', en: '{name} does not seem to have started' },
  'trouble.earlyexit': { zh: '进程出现过，几秒之内就没了', en: 'A process appeared and was gone in seconds' },
  'trouble.dialog': {
    zh: '引擎弹了报错框，这次不计入游玩时长',
    en: 'The engine put up an error box; this run is not counted as playtime'
  },
  'trouble.noshow': { zh: '启动之后一直没有检测到进程', en: 'No process was ever seen after the launch' },
  'trouble.view': { zh: '查看诊断', en: 'See the diagnosis' },
  'trouble.dismiss': { zh: '知道了', en: 'Dismiss' },

  /* ---- clearing removal records / dropping a root ---- */
  'clearIgnored.title': {
    zh: '清除全部 {n} 条移除记录？',
    en: 'Clear all {n} removal records?'
  },
  'clearIgnored.confirm': { zh: '全部清除', en: 'Clear all' },
  'clearIgnored.detail': {
    zh: '这些路径会不再被扫描跳过，但不会立刻回到库里 —— 下次对它们所在的文件夹点「重新扫描并添加」时，会重新出现在勾选列表里。',
    en: 'These paths stop being skipped by scans, but they do not come back into the library right away — they will reappear in the pick list the next time you rescan the folder they live in.'
  },
  'clearIgnored.detail2': {
    zh: '磁盘上的文件不受影响，它们原来的封面、评分与游玩记录也仍然留着，重新加回来时会一并恢复。',
    en: 'Nothing on disk is affected, and their covers, ratings and play records are still held — adding them back restores all of it.'
  },
  'dropRoot.title': { zh: '不再扫描这个文件夹？', en: 'Stop scanning this folder?' },
  'dropRoot.confirm': { zh: '移除文件夹', en: 'Remove folder' },
  'dropRoot.willRemove': { zh: '{path} 会从扫描列表里去掉，', en: '{path} will be dropped from the scan list, ' },
  'dropRoot.affected': {
    zh: '库里来自它的 {n} 个条目也会一起消失 —— 否则它们会一直留在主页上，而这个文件夹早已不在列表里了。',
    en: 'and the {n} entries that came from it go with it — otherwise they would sit on the shelf forever while the folder itself is no longer listed.'
  },
  'dropRoot.none': { zh: '库里目前没有来自它的条目。', en: 'Nothing in the library came from it.' },
  'dropRoot.safe': { zh: '磁盘上的文件不会被改动。', en: 'No file on disk is changed.' },
  'dropRoot.sidecarNote': {
    zh: '每个游戏的评分、评级、标签和游玩时长会先写进它自己文件夹里的 sakura-launcher.md，之后重新加回这个文件夹就能一并恢复。',
    en: 'Each game’s rating, tier, tags and playtime are written into its own sakura-launcher.md first, so adding the folder back later brings all of it with it.'
  },

  /* ---- leftover cleanup ---- */
  'leftover.title': { zh: '卸载程序已结束', en: 'The uninstaller has finished' },
  'leftover.confirm': { zh: '移入回收站', en: 'Send to recycle bin' },
  'leftover.cancel': { zh: '保留', en: 'Keep them' },
  'leftover.detail': {
    zh: '目录里还剩 {size}，通常是存档或卸载程序没清干净的残留。是否把剩余文件也移入回收站？',
    en: '{size} is still left in the folder — usually saves, or debris the uninstaller did not clear. Send the rest to the recycle bin?'
  },

  /* ---- grouping prompt ---- */
  'group.step': { zh: '扫描完成', en: 'Scan complete' },
  'group.title': {
    zh: '发现 {n} 个可分组的文件夹',
    en: 'Found {n} folders that could become groups'
  },
  'group.detail': {
    zh: '这些文件夹下各有多个游戏。要按文件夹名自动建好分组吗？分组只影响启动器里的排列，不会移动磁盘上的任何文件，之后也能随时拖出或解散。',
    en: 'Each of these folders holds several games. Create a group per folder, named after it? Groups only affect how things are arranged in the launcher — no file on disk is moved, and you can drag things out or dissolve a group at any time.'
  },
  'group.count': { zh: '（{n} 个）', en: '({n})' },
  'group.renameTitle': { zh: '重命名分组', en: 'Rename group' },
  'group.promptNote': {
    zh: '分组只影响启动器里的排列，不会移动磁盘上的任何文件。',
    en: 'Groups only affect how things are arranged in the launcher. No file on disk is moved.'
  },
  'group.defaultName': { zh: '新分组', en: 'New group' },
  'group.namePlaceholder': { zh: '分组名称', en: 'Group name' },
  'group.tileTitle': { zh: '{name} — 双击打开', en: '{name} — double-click to open' },
  'group.decline': { zh: '不用，保持平铺', en: 'No, leave them flat' },
  'group.accept': { zh: '自动建组', en: 'Create groups' },

  /* ---- context menus ---- */
  'menu.rating': { zh: '评分', en: 'Rating' },
  'menu.clearRating': { zh: '清除评分', en: 'Clear rating' },
  'menu.extract': { zh: '一键解压', en: 'Extract' },
  'menu.extractN': { zh: '一键解压这 {n} 个', en: 'Extract these {n}' },
  'menu.play': { zh: '打开游戏', en: 'Play' },
  'menu.diagnose': { zh: '启动诊断…', en: 'Diagnose launch…' },
  'menu.browse': { zh: '打开所在文件夹', en: 'Open containing folder' },
  'menu.setCover': { zh: '设置封面…', en: 'Set cover…' },
  'menu.clearCover': { zh: '清除封面', en: 'Clear cover' },
  'menu.rename': { zh: '重命名…', en: 'Rename…' },
  'menu.editTags': { zh: '编辑标签…', en: 'Edit tags…' },
  'menu.share': { zh: '分享…', en: 'Share…' },
  'menu.shareN': { zh: '分享这 {n} 个…', en: 'Share these {n}…' },
  'menu.leaveGroup': { zh: '移出分组', en: 'Take out of group' },
  'menu.moveToGroup': { zh: '移动到分组', en: 'Move to group' },
  'menu.removeTile': { zh: '从库中移除…', en: 'Remove from library…' },
  'menu.removeTileN': { zh: '从库中移除这 {n} 个…', en: 'Remove these {n} from the library…' },
  'menu.uninstall': { zh: '卸载…', en: 'Uninstall…' },
  'menu.uninstallN': { zh: '卸载这 {n} 个…', en: 'Uninstall these {n}…' },
  'menu.selectedN': { zh: '已选 {n} 个', en: '{n} selected' },
  'menu.markWishlist': { zh: '标记为想玩', en: 'Mark as wishlist' },
  'menu.markPlaying': { zh: '标记为在玩', en: 'Mark as playing' },
  'menu.markPlayed': { zh: '标记为玩过', en: 'Mark as played' },
  'menu.newGroupWith': { zh: '新建分组并放入…', en: 'New group with these…' },
  'menu.newGroup': { zh: '新建分组', en: 'New group' },
  'menu.addGame': { zh: '添加游戏…', en: 'Add a game…' },
  'menu.addFolder': { zh: '导入文件夹…', en: 'Import a folder…' },
  'menu.builtinGroup': { zh: '内置分组，无法修改', en: 'Built-in group — cannot be changed' },
  'menu.renameGroup': { zh: '重命名分组…', en: 'Rename group…' },
  'menu.dissolveGroup': { zh: '解散分组', en: 'Dissolve group' },

  /* ---- desktop page ---- */
  'desk.gamesInGroup': { zh: '{n} 个游戏', en: '{n} games' },
  'desk.empty': { zh: '这里还没有游戏', en: 'Nothing here yet' },
  'desk.emptyAll': {
    zh: '右键空白处可以添加游戏或导入文件夹。',
    en: 'Right-click the empty space to add a game or import a folder.'
  },
  'desk.emptyTab': {
    zh: '在「全部」里右键磁贴，把游戏标记到这个清单。',
    en: 'Right-click a tile under All to put a game on this list.'
  },
  'desk.downloads': { zh: '下载', en: 'Downloads' },
  'desk.clearDone': { zh: '清除已完成', en: 'Clear finished' },
  'desk.cancel': { zh: '取消', en: 'Cancel' },
  'desk.remove': { zh: '移除', en: 'Remove' },
  'desk.extracting': { zh: '解压 {name}', en: 'Extracting {name}' },
  'desk.selectedCount': { zh: '已选 {n} 个', en: '{n} selected' },
  'desk.selectedSize': { zh: '合计 {size}', en: '{size} total' },
  'desk.selectAll': { zh: '全选', en: 'Select all' },
  'desk.bulkActions': { zh: '批量操作', en: 'Bulk actions' },
  'desk.clearSelection': { zh: '清空选择', en: 'Clear selection' },
  'dl.downloading': { zh: '等待下载完成…', en: 'Waiting for the download…' },
  'dl.extracting': { zh: '解压中', en: 'Extracting' },
  'dl.importing': { zh: '导入中…', en: 'Importing…' },
  'dl.done': { zh: '已完成', en: 'Done' },
  'dl.failed': { zh: '失败', en: 'Failed' },

  /* ---- detail drawer ---- */
  'drawer.thisGame': { zh: '本游戏', en: 'This game' },
  'drawer.otherGames': { zh: '其他游戏', en: 'Other games' },
  'drawer.otherFiles': { zh: '其他文件', en: 'Other files' },
  'drawer.freeSpace': { zh: '可用空间', en: 'Free space' },
  'drawer.otherN': { zh: '其他 {n} 项', en: '{n} more' },
  'drawer.root': { zh: '根目录', en: 'Root' },
  'drawer.shareOfLibrary': { zh: '占游戏库 {pct}', en: '{pct} of the library' },
  'drawer.thisLevel': { zh: '当前层级', en: 'This level' },
  'drawer.hintToInner': {
    zh: '点击饼图 → 查看游戏文件夹内部构成',
    en: 'Click the ring → see what is inside the game folder'
  },
  'drawer.hintToUsage': {
    zh: '点击饼图 → 返回磁盘占用视角 · 点击文件夹切片可下钻',
    en: 'Click the ring → back to disk usage · click a folder slice to go deeper'
  },
  'drawer.drive': { zh: '{drive} 盘', en: 'Drive {drive}' },
  'drawer.diskUsage': {
    zh: '已用 {used} / 共 {total} · 可用 {free}',
    en: '{used} used of {total} · {free} free'
  },
  'drawer.diskShare': {
    zh: '本游戏占全盘 {game}，游戏库共占 {library}',
    en: 'This game is {game} of the drive; the library is {library}'
  },
  'drawer.libraryShare': { zh: '游戏库占比', en: 'Share of the library' },
  'drawer.allEntries': { zh: '全部条目', en: 'All entries' },
  'drawer.emptyFolder': { zh: '此文件夹为空', en: 'This folder is empty' },
  'drawer.details': { zh: '详情', en: 'Details' },
  'drawer.playtime': { zh: '游玩时长', en: 'Playtime' },
  'drawer.notRecorded': { zh: '未记录', en: 'not recorded' },
  'drawer.running': { zh: '游玩中', en: 'running' },
  'drawer.lastLaunched': { zh: '最后启动', en: 'Last launched' },
  'drawer.launchCount': { zh: '启动次数', en: 'Times launched' },
  'drawer.timesN': { zh: '{n} 次', en: '{n}' },
  'drawer.mainProgram': { zh: '主程序', en: 'Main program' },
  'drawer.archiveNotInstalled': { zh: '（压缩包，未安装）', en: '(archive, not installed)' },
  'drawer.withArgs': { zh: '带参数启动', en: 'launched with arguments' },
  'drawer.change': { zh: '更换', en: 'change' },
  'drawer.size': { zh: '体积', en: 'Size' },
  'drawer.installed': { zh: '安装/修改', en: 'Installed / updated' },
  'drawer.unknown': { zh: '未知', en: 'unknown' },
  'drawer.tags': { zh: '标签', en: 'Tags' },
  'drawer.sessions': { zh: '游玩记录', en: 'Play history' },
  'drawer.moreSessions': {
    zh: '还有 {n} 条，完整记录在游戏文件夹的 sakura-launcher.md 里',
    en: '{n} more — the full record is in sakura-launcher.md in the game folder'
  },

  /* ---- settings page ---- */
  'settings.roots': { zh: '扫描文件夹', en: 'Library folders' },
  'settings.noRoots': { zh: '还没有添加任何扫描目录。', en: 'No folders added yet.' },
  'settings.browse': { zh: '浏览', en: 'Open' },
  'settings.rescanTitle': {
    zh: '重新查看这个文件夹里有什么，和添加文件夹一样先让你勾选',
    en: 'Look at the folder again and offer what is in it, the same way adding a folder does'
  },
  'settings.rescan': { zh: '重新扫描并添加', en: 'Rescan and add' },
  'settings.remove': { zh: '移除', en: 'Remove' },
  'settings.rootsNote': {
    zh: '顶部的「刷新」只同步已有条目 —— 名称、体积、说明文件、是否还在原处。往文件夹里新放了游戏，就在这里点「重新扫描并添加」，会像添加文件夹一样列出可添加的内容让你勾选。',
    en: 'Refresh at the top only syncs what is already in the library — names, sizes, sidecar files, and whether each folder is still there. When you put new games into a folder, use Rescan and add here: it lists what could be taken in and lets you pick, the same as adding a folder.'
  },
  'settings.ignoredTitle': { zh: '已移除的条目（{n}）', en: 'Removed entries ({n})' },
  'settings.ignoredNote': {
    zh: '这些路径被你从库里移除过，扫描时会跳过。磁盘上的文件从未被改动。',
    en: 'These paths were removed from the library and are skipped by scans. Nothing on disk was ever changed.'
  },
  'settings.ignoredNote2': {
    zh: '「恢复」把条目直接加回库里；「清除」只是把它从这份名单里删掉 —— 不会立刻加回来，但下次「重新扫描并添加」会重新问你。两种做法都会带回它原来的封面与评分。',
    en: 'Restore puts the entry straight back. Forget only drops it from this list — it does not come back right away, but the next Rescan and add will ask about it again. Either way its old cover and rating come with it.'
  },
  'settings.restore': { zh: '恢复', en: 'Restore' },
  'settings.forget': { zh: '清除', en: 'Forget' },
  'settings.forgetTitle': {
    zh: '从这份名单里删掉，不加回库',
    en: 'Drop it from this list without adding it back'
  },
  'settings.tileSize': { zh: '磁贴尺寸', en: 'Tile size' },
  'settings.petals': { zh: '花瓣动画', en: 'Falling petals' },
  'settings.pollInterval': { zh: '游玩时长检查间隔', en: 'Playtime check interval' },
  'settings.pollHint': {
    zh: '游戏运行期间，每隔这么久确认一次它还开着。间隔越长越省电，但记录到的时长最多会短这么多。',
    en: 'While a game is running, this is how often it is confirmed to still be open. A longer interval uses less power, and the recorded time can fall short by at most that much.'
  },
  'settings.seconds': { zh: '{n} 秒', en: '{n} s' },
  'settings.diagnoseOnLaunch': { zh: '启动没反应时提示', en: 'Speak up when a launch does nothing' },
  'settings.diagnoseHint': {
    zh: '双击之后十几秒都没有进程跑起来，就在角落里给一张卡片，点开能看到具体原因 —— 缺哪个运行库、是不是要管理员权限、是不是主程序选错了。关掉之后仍然可以随时右键「启动诊断…」。',
    en: 'When nothing has started a dozen seconds after a double-click, a small card appears in the corner; opening it gives the reason — a missing runtime, a demand for administrator rights, the wrong program picked. With this off you can still run Diagnose launch… from the right-click menu at any time.'
  },
  'settings.downloadSection': { zh: '下载', en: 'Downloads' },
  'settings.downloadDir': { zh: '默认下载目录', en: 'Download folder' },
  'settings.downloadDirHint': {
    zh: '不指定时跟随第一个扫描文件夹。下载完成后会在这里解压并加入游戏库。',
    en: 'Follows the first library folder when unset. Finished downloads are extracted here and added to the library.'
  },
  'settings.noDirYet': {
    zh: '还没有可用目录，请先添加扫描文件夹',
    en: 'No folder available yet — add a library folder first'
  },
  'settings.followsRoot': { zh: '（跟随扫描文件夹）', en: ' (follows the library folder)' },
  'settings.pick': { zh: '指定…', en: 'Choose…' },
  'settings.resetDefault': { zh: '恢复默认', en: 'Back to default' },
  'settings.downloaderProgram': { zh: '下载器程序', en: 'Downloader executable' },
  'settings.detecting': { zh: '正在探测…', en: 'Looking for it…' },
  'settings.notFoundIdm': { zh: '未指定，也没有探测到 IDM', en: 'Not set, and IDM was not found' },
  'settings.notSet': { zh: '未指定', en: 'Not set' },
  'settings.autoDetected': { zh: '（自动探测）', en: ' (detected automatically)' },
  'settings.clear': { zh: '清除', en: 'Clear' },
  'settings.argTemplate': { zh: '参数模板', en: 'Argument template' },
  'settings.argTemplateHint': {
    zh: '按空格分成一个个参数后再替换占位符，所以链接里的空格或引号不会被当成新的参数。',
    en: 'Split into arguments on whitespace first, then the placeholders are filled in — so a space or quote inside a link never becomes a separate argument.'
  },
  'settings.trashArchive': { zh: '解压后把压缩包移入回收站', en: 'Recycle the archive after extracting' },
  'settings.trashArchiveHint': {
    zh: '关闭时压缩包保留在库里的「待安装」分组，磁盘页可以随时批量清理。',
    en: 'With this off, archives stay in the Not installed group and can be cleared in bulk from the Disk page whenever you like.'
  },
  'settings.externalSection': { zh: '外部程序', en: 'External programs' },
  'settings.geekNotSet': {
    zh: '未指定（没有自带卸载程序的游戏将直接移入回收站）',
    en: 'Not set — games without their own uninstaller go straight to the recycle bin'
  },
  'settings.7zChecking': { zh: '检测中…', en: 'Checking…' },
  'settings.7zFound': { zh: '已检测到，可解压压缩包条目', en: 'Found — archive entries can be extracted' },
  'settings.7zMissing': { zh: '未检测到，无法解压', en: 'Not found — extraction is unavailable' },

  /* ---- share dialog ---- */
  'share.step': { zh: '分享', en: 'Share' },
  'share.packedN': { zh: '已打包 {n} 个游戏', en: 'Packed {n} games' },
  'share.partial': { zh: '{ok} 个成功，{bad} 个失败', en: '{ok} succeeded, {bad} failed' },
  'share.allFailed': { zh: '打包失败', en: 'Packing failed' },
  'share.nameEmpty': { zh: '压缩包名称不能为空', en: 'An archive name cannot be empty' },
  'share.nameClash': {
    zh: '有两个压缩包重名，它们会互相覆盖',
    en: 'Two archives share a name and would overwrite each other'
  },
  'share.cantStart': { zh: '无法开始打包', en: 'Could not start packing' },
  'share.oversized': {
    zh: '· 占了整个游戏的一大块，多半是被误判的游戏数据',
    en: '· a large share of the whole game, so this is most likely game data caught by mistake'
  },
  'share.yourOwn': { zh: '你自己加的 ({n})', en: 'Added by you ({n})' },
  'share.yourOwnHint': { zh: '手动指定的排除项', en: 'Exclusions you named yourself' },
  'share.addedByHand': { zh: '手动添加', en: 'added by hand' },
  'share.nothingFound': {
    zh: '这个文件夹里没有找到存档或个人痕迹，可以直接打包。',
    en: 'No saves or personal traces were found in this folder — it can be packed as it is.'
  },
  'share.addYourOwn': { zh: '规则没找到的，自己加：', en: 'Anything the rules missed, add it yourself:' },
  'share.addFile': { zh: '添加文件…', en: 'Add a file…' },
  'share.addFolder': { zh: '添加文件夹…', en: 'Add a folder…' },
  'share.doneTitle': { zh: '打包完成', en: 'Packing finished' },
  'share.noneTitle': { zh: '没有打包成功', en: 'Nothing was packed' },
  'share.openLocation': { zh: '打开位置', en: 'Show it' },
  'share.cancelled': { zh: '已取消', en: 'cancelled' },
  'share.untouched': {
    zh: '你的游戏文件夹没有被改动过 —— 排除只影响压缩包内容。',
    en: 'Your game folders were not touched — the exclusions only decide what goes into the archive.'
  },
  'share.gotIt': { zh: '知道了', en: 'Done' },
  'share.packN': { zh: '打包 {n} 个游戏', en: 'Pack {n} games' },
  'share.onePerGame': { zh: '每个游戏一个压缩包', en: 'one archive per game' },
  'share.lede': {
    zh: '勾中的内容不会被打进压缩包。你的游戏文件夹分毫不动 —— 存档还在原处，这里只决定发出去的那一份里有什么。',
    en: 'What you tick stays out of the archive. Your game folders are not altered in any way — the saves stay where they are; this only decides what the copy you send contains.'
  },
  'share.blocked': { zh: '《{name}》不能分享：{reason}', en: '{name} cannot be shared: {reason}' },
  'share.progress': { zh: '正在打包第 {i} / {n} 个 · ', en: 'Packing {i} of {n} · ' },
  'share.slowNote': {
    zh: '大文件夹会压很久。中途取消不会留下半个压缩包。',
    en: 'A large folder takes a while. Cancelling partway leaves no half-written archive behind.'
  },
  'share.collapse': { zh: '收起', en: 'Collapse' },
  'share.excludedN': { zh: '排除 {n} 项', en: 'Excluding {n}' },
  'share.format': { zh: '格式', en: 'Format' },
  'share.password': { zh: '密码', en: 'Password' },
  'share.passwordPlaceholder': { zh: '留空则不加密', en: 'Leave empty for no encryption' },
  'share.password7zNote': {
    zh: '压缩期间密码会短暂出现在进程列表里 —— 7-Zip 没有别的传法',
    en: 'The password appears briefly in the process list while packing — 7-Zip offers no other way to pass it'
  },
  'share.passwordZipNote': {
    zh: 'zip 用 AES-256 加密内容，但文件名对方不用密码也看得到',
    en: 'zip encrypts the contents with AES-256, but the file names stay readable without the password'
  },
  'share.encryptNames': {
    zh: '连文件名一起加密（不输密码连里面有什么都看不到）',
    en: 'Encrypt the file names too — without the password, even the contents list is hidden'
  },
  'share.saveTo': { zh: '存放到', en: 'Save to' },
  'share.browse': { zh: '浏览…', en: 'Browse…' },
  'share.overwrite': { zh: '覆盖同名的压缩包', en: 'Overwrite an archive of the same name' },
  'share.estimate': { zh: '预计写入约 {size}（压缩前）', en: 'About {size} to write (before compression)' },
  'share.freeSpace': { zh: ' · 目标磁盘可用 {size}', en: ' · {size} free on the target drive' },
  'share.notEnoughSpace': {
    zh: '目标磁盘剩余空间可能不够 —— 未压缩就要 {needed}，而那个盘只剩 {free}。',
    en: 'The target drive may not have room — {needed} uncompressed, and only {free} is free.'
  },
  'share.cancelPacking': { zh: '取消打包', en: 'Cancel packing' },
  'share.start': { zh: '开始打包', en: 'Start packing' },

  /* ---- executable classification ---- */
  'exeKind.main': { zh: '主程序候选', en: 'Possible main program' },
  'exeKind.launcher': { zh: '启动器', en: 'Launcher' },
  'exeKind.locale': { zh: '区域模拟器', en: 'Locale emulator' },
  'exeKind.patch': { zh: '补丁', en: 'Patch' },
  'exeKind.uninstall': { zh: '卸载程序', en: 'Uninstaller' },
  'exeKind.tool': { zh: '工具', en: 'Tool' },
  'exeKind.sub': { zh: '子目录', en: 'Subfolder' },
  'exeWhy.dataDir': { zh: '有同名的 {base}_Data 目录', en: 'There is a matching {base}_Data folder' },
  'exeWhy.sameName': { zh: '文件名与游戏文件夹同名', en: 'Named the same as the game folder' },
  'exeWhy.xp3': { zh: '目录里有 .xp3 引擎资源', en: 'The folder holds .xp3 engine assets' },
  'exeWhy.rpgmaker': { zh: 'RPG Maker 的主程序名', en: 'The name RPG Maker gives its main program' },
  'exeWhy.renpy': { zh: 'Ren’Py 引擎目录', en: 'A Ren’Py engine layout' },
  'exeWhy.biggest': { zh: '目录里体积最大的 exe', en: 'The largest executable in the folder' },
  'exeWhy.icon': { zh: '自带 {px}px 图标', en: 'Carries a {px}px icon' },
  'exeWhy.noIcon': { zh: '没有内嵌图标', en: 'No embedded icon' },
  'exeWhy.describes': { zh: '自述：{text}', en: 'Describes itself as: {text}' },
  'exeWhy.product': { zh: '自述产品：{text}', en: 'Product name: {text}' },
  'exeWhy.byDescription': { zh: '按自述判定为{kind}', en: 'Its own description makes it {kind}' },

  /* ---- main-process errors and dialogs ---- */
  'err.gameNotFound': { zh: '找不到该游戏', en: 'That game could not be found' },
  'err.entryNotFound': { zh: '找不到该条目', en: 'That entry could not be found' },
  'err.nameEmpty': { zh: '名称不能为空', en: 'The name cannot be empty' },
  'err.mustBeInside': {
    zh: '只能选择游戏文件夹里的程序',
    en: 'Only a program inside the game folder can be chosen'
  },
  'err.mustBeInsideTry': {
    zh: '只能试运行游戏文件夹里的程序',
    en: 'Only a program inside the game folder can be tried'
  },
  'err.fileGone': { zh: '这个文件已经不在了', en: 'That file is no longer there' },
  'err.notExecutable': { zh: '不是可执行文件', en: 'Not an executable' },
  'err.notExecutableNamed': { zh: '{name} 不是可执行文件', en: '{name} is not an executable' },
  'err.targetMissing': { zh: '找不到 {name}', en: '{name} could not be found' },
  'err.badShortcut': { zh: '无法解析这个快捷方式', en: 'That shortcut could not be read' },
  'err.alreadyInLibrary': { zh: '《{name}》已经在库里了', en: '{name} is already in the library' },
  'err.cantReadFolder': {
    zh: '无法读取该程序所在的文件夹',
    en: 'The folder that program lives in could not be read'
  },
  'err.notArchive': { zh: '不是压缩包条目', en: 'Not an archive entry' },
  'err.shareBusy': { zh: '已经有一个分享在进行中', en: 'A share is already running' },
  'err.nothingToShare': { zh: '没有可以分享的条目', en: 'Nothing here can be shared' },
  'share.blocked.gone': { zh: '这个条目已经不在库里了', en: 'This entry is no longer in the library' },
  'share.blocked.isArchive': {
    zh: '这本来就是一个压缩包，直接发给对方即可',
    en: 'This is already an archive — send it as it is'
  },
  'share.blocked.noFolder': {
    zh: '找不到这个游戏的文件夹',
    en: 'The game’s folder could not be found'
  },
  'share.goneName': { zh: '（已不在库中）', en: '(no longer in the library)' },
  'exeWhy.inSubfolder': { zh: '位于 {dir}\\', en: 'In {dir}\\' },
  'pick.cover': { zh: '选择封面图片', en: 'Choose a cover image' },
  'pick.images': { zh: '图片', en: 'Images' },
  'pick.excludeDir': { zh: '选择要排除的文件夹', en: 'Choose a folder to leave out' },
  'pick.excludeFile': { zh: '选择要排除的文件', en: 'Choose a file to leave out' },
  'pick.libraryFolder': { zh: '选择游戏库文件夹', en: 'Choose a library folder' },
  'pick.mainExe': { zh: '选择游戏主程序', en: 'Choose the game’s main program' },
  'pick.executables': { zh: '可执行文件', en: 'Executables' },
  'pick.anyExe': { zh: '选择可执行文件', en: 'Choose an executable' },
  'pick.downloadDir': { zh: '选择下载目录', en: 'Choose a download folder' },
  'splash.preparing': { zh: '正在准备…', en: 'Getting ready…' },
  'splash.loading': { zh: '正在读取游戏库…', en: 'Reading the library…' },
  'splash.arranging': { zh: '正在布置书架…', en: 'Arranging the shelf…' },
  'group.archives': { zh: '待安装', en: 'Not installed' },

  /* ---- executable picker ---- */
  'exe.step': { zh: '更换主程序', en: 'Change main program' },
  'exe.lede': {
    zh: '双击磁贴时运行的就是这里选中的程序。拿不准的话先「试运行」—— 启动器会去看游戏目录里有没有进程真的跑起来。',
    en: 'Double-clicking the tile runs whichever program is selected here. If you are unsure, try one: the launcher then goes and looks for a process running out of the game folder.'
  },
  'exe.notPinned': {
    zh: '（当前这个是扫描自动挑的，还没有人工确认过。）',
    en: ' (The current one was picked by the scan and has not been confirmed by anyone.)'
  },
  'exe.sec.main': { zh: '推荐', en: 'Recommended' },
  'exe.sec.mainHint': {
    zh: '扫描判定为可以直接启动的程序，按可能性排序',
    en: 'Programs the scan judged startable, most likely first'
  },
  'exe.sec.locale': { zh: '区域模拟器', en: 'Locale emulators' },
  'exe.sec.localeHint': {
    zh: '日文游戏常常要通过它才能正常显示 —— 见下方的组合启动',
    en: 'Japanese games often need one to display correctly — see the combination below'
  },
  'exe.sec.tool': { zh: '工具 · 补丁 · 卸载', en: 'Tools · patches · uninstallers' },
  'exe.sec.toolHint': {
    zh: '一般不是启动游戏用的，判断错了就在这里选',
    en: 'Usually not how a game starts — but if the judgement was wrong, pick from here'
  },
  'exe.sec.sub': { zh: '子目录里的程序', en: 'Programs in subfolders' },
  'exe.sec.subHint': {
    zh: '游戏本体偶尔真的在下一层',
    en: 'Now and then the game really is one level down'
  },
  'exe.trial.running': { zh: '⏳ 已启动，正在看有没有进程…', en: '⏳ Started — looking for a process…' },
  'exe.trial.alive': {
    zh: '✓ 跑起来了 —— 游戏目录里有进程在运行',
    en: '✓ It runs — a process is live in the game folder'
  },
  'exe.trial.dead': {
    zh: '✗ 十秒内没有检测到进程，多半不是这个',
    en: '✗ No process within ten seconds — probably not this one'
  },
  'exe.trial.busy': {
    zh: '· 这个游戏本来就开着，测不出来；先关掉再试',
    en: '· The game is already open, so this proves nothing — close it and try again'
  },
  'exe.trial.failed': { zh: '✗ 没能启动', en: '✗ Would not start' },
  'exe.current': { zh: '当前', en: 'current' },
  'exe.noFeatures': { zh: '没有可说的特征', en: 'nothing distinctive about it' },
  'exe.whyNot': { zh: '查一下为什么', en: 'Find out why' },
  'exe.tryRun': { zh: '试运行', en: 'Try it' },
  'exe.isMain': { zh: '已是主程序', en: 'Already the main program' },
  'exe.setMain': { zh: '设为主程序', en: 'Make this the main program' },
  'exe.expandN': { zh: '展开这 {n} 项', en: 'Show these {n}' },
  'exe.combo': { zh: '组合启动', en: 'Combination launch' },
  'exe.comboHint': {
    zh: '用区域模拟器带起游戏本体，双击磁贴时就是这一串',
    en: 'Have a locale emulator start the game itself — that whole chain is what the tile runs'
  },
  'exe.comboUse': { zh: '用', en: 'Use' },
  'exe.comboStart': { zh: '启动', en: 'to start' },
  'exe.comboNote': {
    zh: '模拟器接收参数的写法各不相同。设好之后建议双击磁贴验一次 —— 没反应就回到这里换一种组合。',
    en: 'Emulators differ in how they take arguments. Once set, double-click the tile to check — if nothing happens, come back and try another combination.'
  },

  /* ---- import dialog ---- */
  'import.step': { zh: '导入文件夹', en: 'Import a folder' },
  'import.sec.games': { zh: '识别为游戏', en: 'Recognised as games' },
  'import.sec.gamesHint': { zh: '扫描时判定为游戏的文件夹', en: 'Folders the scan judged to be games' },
  'import.sec.maybe': { zh: '疑似非游戏', en: 'Probably not games' },
  'import.sec.maybeHint': {
    zh: '有可执行文件但没通过检查 —— 判断错了就勾上',
    en: 'They hold an executable but did not pass the checks — tick any the scan got wrong'
  },
  'import.sec.archive': { zh: '压缩包 · 未安装', en: 'Archives · not installed' },
  'import.sec.archiveHint': {
    zh: '还没解压的安装包，导入后可以右键解压',
    en: 'Archives not yet extracted; once imported, right-click to extract'
  },
  'import.selected': { zh: '已选 {n} / {total} 项', en: '{n} of {total} selected' },
  'import.totalBytes': { zh: ' · 合计 {size}', en: ' · {size} in all' },
  'import.selectAll': { zh: '全选', en: 'Select all' },
  'import.invert': { zh: '反选', en: 'Invert' },
  'import.volumes': { zh: '{n} 个分卷', en: '{n} volumes' },
  'import.note': {
    zh: '没有勾选的条目会被记住，之后重新扫描不会再冒出来；随时可以在「设置 → 已移除的条目」里恢复。这个文件夹会加入扫描列表，每次启动自动检查新游戏。',
    en: 'Whatever you leave unticked is remembered and will not come up again on a later scan; you can restore any of it from Settings → Removed entries at any time. The folder joins the scan list and is checked for new games on every start.'
  },
  'import.confirm': { zh: '导入 {n} 项', en: 'Import {n}' },

  /* ---- bulk uninstall ---- */
  'bulk.step': { zh: '批量卸载', en: 'Uninstall several' },
  'bulk.title': { zh: '即将卸载 {n} 个游戏', en: 'About to uninstall {n} games' },
  'bulk.progress': { zh: '正在处理《{name}》 · {done} / {total}', en: 'Working on {name} · {done} of {total}' },
  'bulk.detail': {
    zh: '将按顺序对每个游戏执行卸载：有自带卸载程序的运行它，否则交给 Geek，再否则移入回收站。合计可释放 {size}。',
    en: 'Each game is uninstalled in turn: its own uninstaller if it has one, otherwise Geek, otherwise the recycle bin. {size} would be freed in all.'
  },
  'bulk.typeCount': { zh: '确认请输入本次卸载的数量 {n}：', en: 'To confirm, type the number being uninstalled — {n}:' },
  'bulk.running': { zh: '卸载中…', en: 'Uninstalling…' },
  'bulk.confirm': { zh: '卸载这 {n} 个游戏', en: 'Uninstall these {n} games' },

  /* ---- tile ---- */
  'tile.missing': { zh: '未找到', en: 'not found' },
  'tile.notInstalled': { zh: '未安装 · {size}', en: 'not installed · {size}' },
  'tile.running': { zh: '游玩中', en: 'running' },
  'tile.ratingTitle': { zh: '评分 {n} / 5', en: 'Rated {n} of 5' },

  /* ---- small dialogs ---- */
  'folder.back': { zh: '返回上一级 (Backspace)', en: 'Back up one level (Backspace)' },
  'folder.close': { zh: '关闭 (Esc)', en: 'Close (Esc)' },

  /* ---- disk page ---- */
  'disk.recycled': { zh: '已回收 {size}，压缩包在回收站中', en: 'Reclaimed {size} — the archives are in the recycle bin' },
  'disk.capacity': { zh: '磁盘容量', en: 'Drive capacity' },
  'disk.noData': { zh: '暂无数据', en: 'No data yet' },
  'disk.used': { zh: '已用 {used} / 共 {total} · 可用 {free}', en: '{used} used of {total} · {free} free' },
  'disk.library': { zh: '游戏库', en: 'Library' },
  'disk.installedGames': { zh: '已安装游戏', en: 'Installed games' },
  'disk.archiveEntries': { zh: '压缩包条目', en: 'Archive entries' },
  'disk.totalSize': { zh: '占用总计', en: 'Total on disk' },
  'disk.top10': { zh: '体积 Top 10', en: 'Ten largest' },
  'disk.redundant': { zh: '冗余安装包', en: 'Redundant archives' },
  'disk.redundantNote': {
    zh: '下列压缩包都已确认存在对应的解压文件夹，删掉不影响游戏运行。会移入回收站，可恢复。',
    en: 'Each archive below has a confirmed extracted copy, so removing it affects no game. They go to the recycle bin and can be restored.'
  },
  'disk.noRedundant': { zh: '没有发现冗余压缩包。', en: 'No redundant archives found.' },
  'disk.extractedTo': { zh: '已解压到：{dir}', en: 'Extracted to: {dir}' },
  'disk.volumes': { zh: ' · {n} 个分卷', en: ' · {n} volumes' },
  'disk.selectedSize': { zh: '已选 {size}', en: '{size} selected' },
  'disk.cleaning': { zh: '清理中…', en: 'Clearing…' },
  'disk.toRecycle': { zh: '移入回收站', en: 'Send to recycle bin' },
  'disk.confirmTitle': { zh: '清理冗余安装包', en: 'Clear redundant archives' },
  'disk.confirmDetail': {
    zh: '将把 {n} 个压缩包（共 {size}）移入回收站。它们都已确认存在解压副本，删掉不影响游戏运行，之后也可从回收站恢复。',
    en: '{n} archives ({size} in all) will be sent to the recycle bin. Each has a confirmed extracted copy, so no game is affected, and they can be restored from the bin afterwards.'
  },

  /* ---- tier page ---- */
  'tier.lede': {
    zh: '拖动图标在各档之间移动；悬停可看名称。此页仅用于评级，不会启动游戏。未安装的压缩包不参与评级。',
    en: 'Drag an icon between rows; hover to read its name. This page is for ranking only and never starts a game. Archives that are not installed are left out.'
  },
  'tier.clearAll': { zh: '清除全部评级', en: 'Clear every tier' },
  'tier.dropHere': { zh: '拖游戏到这里', en: 'Drag games here' },
  'tier.clearTitle': { zh: '清除全部 {n} 个游戏的评级？', en: 'Clear the tier on all {n} games?' },
  'tier.clearConfirm': { zh: '清除评级', en: 'Clear tiers' },
  'tier.clearDetail': {
    zh: '所有游戏都会回到「未评级」一行。这不会影响星级评分、游玩记录或磁盘上的任何文件。',
    en: 'Every game returns to the unrated row. Star ratings, play history and files on disk are all untouched.'
  },
  'tier.clearDetail2': {
    zh: '评级同时记在每个游戏文件夹的 sakura-launcher.md 里，清除后下次扫描会一并同步过去。',
    en: 'Tiers are also recorded in each game’s sakura-launcher.md; the next scan syncs the clearing through to those files.'
  },

  /* ---- wishlist page ---- */
  'wish.onlySelected': { zh: '只看已选', en: 'Selected only' },
  'wish.selected': { zh: '已选 {n} / {total}', en: '{n} of {total} selected' },
  'wish.add': { zh: '加入想玩', en: 'Add to wishlist' },
  'wish.remove': { zh: '移出想玩', en: 'Remove from wishlist' },
  'wish.noMatch': { zh: '没有匹配的游戏', en: 'No games match' },
  'wish.noMatchHint': {
    zh: '换个关键词，或者关掉「只看已选」。',
    en: 'Try another word, or turn off Selected only.'
  },

  /* ---- downloader ---- */
  'dlerr.noDir': {
    zh: '还没有设置下载目录，请先在设置里指定，或先添加一个游戏库文件夹',
    en: 'No download folder is set — name one in Settings, or add a library folder first'
  },
  'dlerr.cantCreateDir': { zh: '无法创建下载目录：{error}', en: 'Could not create the download folder: {error}' },
  'dlerr.noIdm': { zh: '没有找到 IDM，请在设置里指定 IDMan.exe', en: 'IDM was not found — point Settings at IDMan.exe' },
  'dlerr.noDownloader': { zh: '请先在设置里指定下载器程序', en: 'Name the downloader executable in Settings first' },
  'dlerr.cantStart': { zh: '无法启动下载器', en: 'The downloader would not start' },
  'dlerr.aria2Exit': { zh: 'aria2c 退出码 {code}', en: 'aria2c exited with code {code}' },
  'dlerr.exit': { zh: '下载器退出码 {code}', en: 'The downloader exited with code {code}' },
  'dlerr.timeout': { zh: '等待超过 12 小时，已停止监视', en: 'Waited over 12 hours — no longer watching' },
  'dlerr.notArchive': { zh: '已下载 {name}，不是压缩包，未自动解压', en: 'Downloaded {name}; it is not an archive, so nothing was extracted' },
  'dlerr.extractFailed': { zh: '解压失败', en: 'Extraction failed' },
  'dlerr.interrupted': { zh: '解压过程被中断，请重新解压压缩包', en: 'Extraction was interrupted — extract the archive again' },
  'dl.importedN': { zh: '已导入 {n} 个游戏', en: 'Imported {n} games' },
  'dl.noneRecognised': {
    zh: '解压完成，但没有识别出游戏，可用「导入文件夹」手动挑选',
    en: 'Extracted, but nothing was recognised as a game — use Import a folder to pick by hand'
  },
  'dl.archiveTrashed': { zh: '，压缩包已移入回收站', en: '. The archive went to the recycle bin' },
  'dl.archiveNotTrashed': { zh: '，但压缩包未能移入回收站', en: '. The archive could not be moved to the recycle bin' },
  'dl.dirAdded': { zh: '。下载目录已加入扫描列表', en: '. The download folder has joined the scan list' },

  /* ---- launcher ---- */
  'launch.refused': {
    zh: '系统拒绝运行这个程序 —— 多半需要管理员权限，或者被安全软件拦下了',
    en: 'Windows refused to run it — most likely it needs administrator rights, or security software stopped it'
  },
  'launch.notFound': { zh: '找不到这个程序', en: 'That program could not be found' },
  'launch.notRunnable': {
    zh: '这个程序无法直接启动（可能不是有效的可执行文件）',
    en: 'It cannot be started directly — it may not be a valid executable'
  },
  'launch.noExe': { zh: '该条目没有可执行文件', en: 'This entry has no executable' },
  'launch.exeMissing': { zh: '主程序不存在：{exe}', en: 'The main program does not exist: {exe}' },
  'launch.exeMissingShort': { zh: '主程序不存在', en: 'The main program does not exist' },
  'launch.uacDeclined': { zh: '你取消了管理员授权', en: 'You declined the administrator prompt' },
  'launch.elevateFailed': { zh: '以管理员身份启动失败', en: 'Could not run it as administrator' },

  /* ---- share scan reasons ---- */
  'shareWhy.launcher': {
    zh: '启动器写的说明文件，含游玩时长、评分与游玩记录',
    en: 'The launcher’s own sidecar — playtime, rating and every session'
  },
  'shareWhy.saveExt': { zh: '存档文件（{ext}）', en: 'A save file ({ext})' },
  'shareWhy.saveInDir': { zh: '存档目录里的 {ext} 文件', en: 'A {ext} file inside a save folder' },
  'shareWhy.saveRoot': { zh: '游戏根目录下的存档文件', en: 'A save file in the game’s root folder' },
  'shareWhy.noiseName': { zh: '系统或引擎生成的杂项文件', en: 'Debris written by the system or the engine' },
  'shareWhy.noiseExt': { zh: '日志或临时文件（{ext}）', en: 'A log or temporary file ({ext})' },
  'shareWhy.config': {
    zh: '设置文件，可能存了你的用户名或窗口位置',
    en: 'A settings file — it may hold your name or window position'
  },
  'shareWhy.saveDir': { zh: '存档目录', en: 'A save folder' },
  'shareWhy.noiseDir': { zh: '日志、崩溃转储或截图目录', en: 'A folder of logs, crash dumps or screenshots' },

  /* ---- uninstaller / archive ---- */
  'uninst.noMethod': { zh: '无法确定卸载方式', en: 'No way to uninstall it could be determined' },
  'err.no7z': { zh: '未找到 7-Zip，请先安装', en: '7-Zip was not found — install it first' },
  'err.no7zPath': {
    zh: '未找到 7-Zip，请先安装或在设置中指定路径',
    en: '7-Zip was not found — install it, or point Settings at it'
  },
  'err.7zExit': { zh: '7z 退出码 {code}', en: '7z exited with code {code}' },

  'fmt.calculating': { zh: '计算中…', en: 'measuring…' },
  'fmt.neverLaunched': { zh: '从未启动', en: 'never launched' },
  'dlerr.emptyLink': { zh: '链接为空', en: 'The link is empty' },
  'dlerr.badLink': { zh: '不是有效的链接', en: 'Not a valid link' },
  'dlerr.badProtocol': {
    zh: '不支持 {protocol} 链接，只接受 http / https / ftp 直链',
    en: '{protocol} links are not supported — only direct http / https / ftp links'
  },
  'scan.tooSmall': {
    zh: '内容太少（{size} MB{extra}）',
    en: 'Too little in it ({size} MB{extra})'
  },
  'scan.tinyExe': { zh: '，主程序也很小', en: ', and the main program is tiny too' },
  'scan.staging': { zh: '看起来是压缩包暂存目录', en: 'Looks like a folder archives were unpacked into' },

  /* ---- uninstall ritual ---- */
  'ritual.method.uninstaller': { zh: '将运行该游戏自带的卸载程序', en: 'Its own uninstaller will be run' },
  'ritual.method.geek': { zh: '将调用 Geek Uninstaller 卸载', en: 'Geek Uninstaller will be called' },
  'ritual.method.trash': {
    zh: '将把整个文件夹移入回收站（可从回收站恢复）',
    en: 'The whole folder goes to the recycle bin, and can be restored from there'
  },
  'ritual.step1': { zh: '第一步 · 确认对象', en: 'Step one · which game' },
  'ritual.step1.title': { zh: '要卸载《{name}》吗？', en: 'Uninstall {name}?' },
  'ritual.location': { zh: '位置', en: 'Location' },
  'ritual.mainProgram': { zh: '主程序', en: 'Main program' },
  'ritual.isArchive': { zh: '（压缩包）', en: '(an archive)' },
  'ritual.lastLaunched': { zh: '最后启动', en: 'Last launched' },
  'ritual.method': { zh: '方式', en: 'Method' },
  'ritual.detecting': { zh: '检测中…', en: 'working it out…' },
  'ritual.reclaim': { zh: '此操作将回收 {size} 磁盘空间', en: 'This reclaims {size} of disk space' },
  'ritual.continue': { zh: '继续', en: 'Continue' },
  'ritual.step2': { zh: '第二步 · 手抄花名', en: 'Step two · copy the flower' },
  'ritual.step2.title': { zh: '抄下这个名字', en: 'Write this name out' },
  'ritual.meaning': { zh: '花语 · {meaning}', en: 'It stands for {meaning}' },
  'ritual.aboutTo': { zh: '即将卸载《{name}》', en: 'About to uninstall {name}' },
  'ritual.typeHere': { zh: '在这里抄一遍花名', en: 'Copy the flower’s name here' },
  'ritual.step3': { zh: '第三步 · 长按碎落', en: 'Step three · hold until it breaks' },
  'ritual.step3.title': { zh: '按住不放，直到它碎尽', en: 'Hold it down until nothing is left' },
  'ritual.letGo': {
    zh: '中途松手即中止，碎片会合回去，一切照旧。',
    en: 'Let go at any point and it stops — the pieces come back together and nothing has happened.'
  },
  'ritual.uninstalling': { zh: '正在卸载…', en: 'Uninstalling…' },
  'ritual.keepHolding': { zh: '继续按住', en: 'Keep holding' },
  'ritual.hold': { zh: '按住 2.5 秒', en: 'Hold for 2.5 seconds' },

  /* ---- automatic tags ---- */
  'facet.genre': { zh: '题材', en: 'Genre' },
  'facet.year': { zh: '年份', en: 'Year' },

  /* Why each tag was applied. Shown on hover, the same contract the executable picker
     keeps: a judgement nobody can check is a judgement nobody can correct. */
  'tag.why.dlsite': { zh: 'DLsite 上 {code} 的分类', en: "DLsite's genres for {code}" },
  'tag.why.vndb': { zh: 'VNDB 标签，投票强度 {rating}/3', en: 'VNDB tag, voted {rating}/3' },
  'tag.why.year': { zh: '目录站记载的发售年份', en: 'The release year the catalogue records' },

  /* ---- tag bar and tag filtering ---- */
  'tagbar.clear': { zh: '清除筛选', en: 'Clear' },
  /* A tag on a single game is a search, not a filter — and the search box already finds it. */
  'tagbar.singletonNote': {
    zh: '只列出两个以上游戏共有的标签；单个游戏独有的直接搜就行',
    en: 'Only tags shared by two or more games are listed — search finds the one-offs'
  },

  /* ---- working tags out ---- */
  'tags.compute': { zh: '获取标签', en: 'Fetch tags' },
  'tags.computeOne': { zh: '重新获取标签', en: 'Fetch tags again' },
  'tags.computing': { zh: '正在获取…', en: 'Fetching…' },
  'tags.cancel': { zh: '停止', en: 'Stop' },
  'tags.progress': { zh: '{done}/{total} · {name}', en: '{done}/{total} · {name}' },
  'tags.needOnline': {
    zh: '题材标签必须联网获取。先打开上面的开关。',
    en: 'Genre tags can only come from a catalogue. Turn the switch above on first.'
  },
  'tags.pendingCount': { zh: '{n} 个游戏还没查过', en: '{n} games not looked up yet' },
  'tags.allDone': { zh: '都查过了', en: 'All looked up' },
  'tags.redoAll': { zh: '全部重查', en: 'Look everything up again' },
  'tags.done': {
    zh: '查了 {looked} 个，{matched} 个对上了',
    en: 'Looked up {looked}, matched {matched}'
  },
  'tags.stopped': {
    zh: '已停止 · 查了 {looked} 个，{matched} 个对上了',
    en: 'Stopped — looked up {looked}, matched {matched}'
  },
  'tags.offline': {
    zh: '一个都没连上。检查网络，或者目录站正好不通。',
    en: 'Not one lookup got through. Check the network, or the catalogue is down.'
  },
  'tags.hide': { zh: '这条不对，隐藏', en: 'Wrong — hide this' },
  'tags.hidden': { zh: '已隐藏 {n} 条', en: '{n} hidden' },
  'tags.adultHidden': {
    zh: '{n} 个 R18 标签没显示（设置里可以打开）',
    en: '{n} adult tags not shown — there is a switch in Settings'
  },
  'tags.restore': { zh: '恢复隐藏的标签', en: 'Restore hidden tags' },
  'tags.autoTitle': { zh: '题材标签', en: 'Genre tags' },
  'tags.fromWork': { zh: '来自 {source} · {title}', en: 'From {source} · {title}' },

  /* ---- the online switch ---- */
  'settings.onlineTags': { zh: '联网获取题材标签', en: 'Fetch genre tags online' },
  'settings.onlineTagsNote': {
    zh: '关闭时一个字节也不出去。开启后，获取标签时会把文件夹名里的作品编号、或者游戏标题，发给 DLsite 和 VNDB —— 只有这两样。路径、体积、时长、评分、你的库有多大，一概不发。',
    en: 'Off, nothing leaves the machine. On, fetching tags sends the work number from the folder name, or the game’s title, to DLsite and VNDB — those two things only. Never the path, the size, the playtime, the rating, or anything about the shape of your library.'
  },
  'settings.adultTags': { zh: '显示 R18 标签', en: 'Show adult tags' },
  'settings.adultTagsNote': {
    zh: '默认关掉。标签照样会取回来存着，这个开关只管画不画 —— 随手一开一关立刻生效，不用重新联网。关着的时候书架可以当着人看。',
    en: 'Off by default. The tags are fetched and kept either way; this only decides whether they are drawn, so it takes effect the moment you flip it and costs no traffic. Off means a shelf you can leave on screen with company.'
  },
  'settings.spoilerTags': { zh: '显示剧透标签', en: 'Show spoiler tags' },
  'settings.spoilerTagsNote': {
    zh: 'VNDB 会标出哪些标签泄露剧情。默认藏起来 —— 没人想在自己的书架上被剧透。',
    en: 'VNDB marks which tags give the plot away. Hidden by default — nobody wants their own shelf to spoil a story.'
  },
  'settings.tagsSection': { zh: '题材标签', en: 'Genre tags' },
  'settings.tagsNote': {
    zh: '题材（校园、催泪、NTR 这些）不在游戏文件里 —— 那是对故事的判断，只有目录站有。编号能精确对上的直接采用，靠标题搜到的会让你确认。整个过程不碰游戏文件夹，只读文件夹的名字。',
    en: 'Genres — school life, tear-jerker, NTR — are not in the game files. They are judgements about a story, and only a catalogue has them. A work number is taken as given; a title search is put to you. Nothing in the game folder is touched: only its name is read.'
  },

  /* ---- settling an uncertain match ---- */
  'match.title': { zh: '这些游戏没法确定是哪一部', en: 'These could be more than one work' },
  'match.intro': {
    zh: '编号能精确对上的已经直接用了。下面这些是靠标题搜到的 —— 标题相近的作品很容易搞混，所以由你来定。',
    en: 'Anything matched by work number was taken as given. These were found by title, where a fan disc or a sequel is easy to mistake for the real thing — so they are yours to settle.'
  },
  'match.score': { zh: '匹配 {n}%', en: '{n}% match' },
  'match.released': { zh: '{date} 发售', en: 'released {date}' },
  'match.tagCount': { zh: '{n} 个标签', en: '{n} tags' },
  'match.search': { zh: '搜索', en: 'Search' },
  'match.searching': { zh: '搜索中…', en: 'Searching…' },
  'match.searchPlaceholder': {
    zh: '换个名字搜，或直接填编号',
    en: 'Search another title, or paste an id'
  },
  'match.searchHint': {
    zh: '日文名、中文名、英文名都行；也可以直接填 v1234、RJ01234567 或对应网址',
    en: 'Japanese, Chinese or English titles all work — or paste v1234, RJ01234567, or a link to either'
  },
  'match.searchEmpty': { zh: '这个词没搜到，换一个试试', en: 'Nothing found for that — try another' },
  'match.noCandidates': {
    zh: '自动查找没找到这个游戏。上面自己搜一下。',
    en: 'The automatic lookup found nothing. Search for it above.'
  },
  'match.allSettled': { zh: '都处理完了', en: 'All settled' },
  'match.none': { zh: '都不是，跳过', en: 'None of these — skip' },
  'match.apply': { zh: '采用', en: 'Use this' },
  'match.skipAll': { zh: '全部跳过', en: 'Skip all' },
  'match.spoilerHidden': { zh: '（{n} 个标签已隐藏）', en: '({n} tags hidden)' },

  /* ---- units and shared words ---- */
  'common.none': { zh: '无', en: 'none' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.close': { zh: '关闭', en: 'Close' },
  'common.confirm': { zh: '确定', en: 'OK' },
  'common.unknownError': { zh: '未知错误', en: 'unknown error' },
  'common.showInExplorer': { zh: '在资源管理器中显示', en: 'Show in Explorer' },
  /** Chinese wraps game titles in corner brackets; English uses nothing but the name. */
  'common.quoted': { zh: '《{name}》', en: '{name}' },
  'menu.chooseExe': { zh: '更换主程序…', en: 'Change main program…' },
  'menu.matchWork': { zh: '手动匹配…', en: 'Match manually…' }
} satisfies Record<string, Entry>

export type MessageKey = keyof typeof MESSAGES

/** Bound lookup for a language. */
export function makeT(lang: Lang): (key: MessageKey, vars?: Vars) => string {
  return (key, vars) => translate(MESSAGES as Record<string, Entry>, lang, key, vars)
}

export type T = ReturnType<typeof makeT>
