# 第三方程序声明 · Third-Party Notices

Sakura Launcher 本身以 MIT 许可证发布。安装包中另外分发了一个独立程序，它有自己的许可证，
条款如下。

Sakura Launcher itself is released under the MIT licence. The installer additionally
distributes one separate program, which carries its own licence. Its terms follow.

---

## Magpie

| | |
|---|---|
| 版本 · Version | **v0.12.1** |
| 许可证 · Licence | **GPL-3.0** |
| 上游项目 · Upstream | https://github.com/Blinue/Magpie |
| 发布页 · Release | https://github.com/Blinue/Magpie/releases/tag/v0.12.1 |
| 分发的文件 · Asset | `Magpie-v0.12.1-x64.zip` |
| SHA-256 | `8bc8bc233438f546b7996b00b21d7376f4f7d3d8a4940e6a8800babd2225b2de` |
| 许可证全文 · Licence text | [`third-party/magpie-LICENSE.txt`](third-party/magpie-LICENSE.txt)，安装后位于 `resources\magpie\LICENSE.txt` |

### 中文

Magpie 是一个把窗口实时放大的工具。Sakura Launcher 用它在游戏运行时放大游戏窗口，这项功能
**默认关闭**，第一次开启时才会把 Magpie 复制到 `%APPDATA%\sakura-launcher\magpie\`。

关于分发方式，有三件事需要说明：

1. **未经修改。** 分发的是上游发布页上的原始压缩包，一个字节都没有改动。构建脚本
   `scripts/fetch-magpie.mts` 在下载后校验上表中的 SHA-256，不匹配就直接让构建失败——这是
   「未经修改」这句话唯一可被验证的凭据。压缩包本身不进入本仓库的版本控制。
2. **以独立进程调用。** Sakura Launcher 不链接 Magpie 的任何代码，只是把它作为一个单独的
   进程启动，并为它写一份配置文件。两者之间只有进程边界和一个 JSON 文件。因此这属于
   GPLv3 意义上的「聚合」（aggregation），Sakura Launcher 自身的源码仍以 MIT 许可证发布。
   Magpie 及其全部组件仍然完整地受 GPL-3.0 约束。
3. **对应源码。** Magpie 的完整源码可在上述上游项目和发布页取得，其中包含与本安装包内二进制
   相对应的版本（tag `v0.12.1`）。如你希望由我们直接提供该版本的对应源码，可在本项目的
   issue 中提出，我们会依 GPL-3.0 第 6 条提供。

上游压缩包内**不含**许可证文件，所以 GPL-3.0 全文由本项目单独附上，随二进制一同分发。

另需说明：安装包内包含 Magpie 自带的 `Updater.exe`。Sakura Launcher 写给 Magpie 的配置中
`autoCheckForUpdates` 被强制设为 `false`，因此它不会自行联网；保留它只是为了让「未经修改地
分发」这句话成立。

### English

Magpie is a real-time window upscaler. Sakura Launcher uses it to scale a game's window
while the game runs. The feature is **off by default**; Magpie is copied into
`%APPDATA%\sakura-launcher\magpie\` only when it is first switched on.

Three points about how it is distributed:

1. **Unmodified.** What ships is the original archive from the upstream release page, byte
   for byte. The build script `scripts/fetch-magpie.mts` verifies the SHA-256 above after
   downloading and fails the build on a mismatch — that check is the only verifiable basis
   for the word "unmodified". The archive is not committed to this repository.
2. **Invoked as a separate process.** Sakura Launcher links none of Magpie's code. It
   starts Magpie as its own process and writes it a configuration file; a process boundary
   and a JSON file are the whole of the interface. This is aggregation in the sense of
   GPLv3, so Sakura Launcher's own source remains under the MIT licence, while Magpie and
   all of its components remain fully governed by GPL-3.0.
3. **Corresponding source.** Magpie's complete source is available from the upstream
   project and release page above, including the revision corresponding to the binaries in
   this installer (tag `v0.12.1`). If you would rather receive that corresponding source
   from us directly, open an issue on this project and we will provide it under section 6
   of the GPL-3.0.

The upstream archive contains **no** licence file, so the full GPL-3.0 text is supplied by
this project and travels with the binary.

Note also that the installer includes Magpie's own `Updater.exe`. The configuration Sakura
Launcher writes forces `autoCheckForUpdates` to `false`, so it never reaches the network on
its own; it is kept only so that "distributed unmodified" remains true.
