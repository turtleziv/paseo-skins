# Compatibility

Paseo Skins 通过运行时 DOM 与 CDP target 能力判断兼容性，不只比较应用版本号。版本号用于记录证据和定位回归，不作为“应该能用”的替代证明。

| Paseo | Platform | Last checked | Evidence |
|---|---|---|---|
| 0.10.3 | Windows x64, fork `windows-support` at `bc6dc7a` | 2026-10-06 | Isolated `doctor`/`status`/`inject`/`verify`/`reset`; Guardian restored the theme after Paseo restart and switched theme with one watcher; 21-page/5-hover renderer audit passed. After reboot, the hidden task started at user login with no Node window. Explorer launched Paseo, the watcher injected the greenhouse theme, and live `verify --theme` passed. After Paseo closed, Guardian stopped the watcher, stayed running, and its idle log grew by 0 bytes over 8 seconds. External termination of the production Guardian Node produced launcher exit -1 and a restart after 1 second; the new child under the same hidden launcher injected the greenhouse theme into isolated Paseo, and `verify --theme` passed. Isolated per-page cold injection passed 21 pages and 5 hover checks. After the CI-green commit was loaded, isolated Paseo again received the greenhouse theme with `verify --theme` passing, then closed with watcher inactive. Local `check` 129/129 and `release:check` passed; [GitHub CI](https://github.com/turtleziv/paseo-skins/actions/runs/37362302569) passed all five jobs, including Windows Node 22/24 and Node 24 `release:check`. |
| 0.5.0-beta.2 | macOS arm64 | 2026-08-20 | Live `status`, `verify`, 21-page/5-hover renderer audit, skin version 17, long diff counters with trailing workspace action, 101 automated tests |
| 0.3.0 | macOS arm64 | 2026-08-09 | Live `status` and `verify`, skin version 12, workspace/schedules/sessions/new SPA routes, workspace menu and hover-in/hover-out screenshots, 74 automated tests |

此前 macOS 兼容审计使用本机 Paseo `0.5.0-beta.2` 与回环 CDP `127.0.0.1:9224`。新版 workspace 行使用 `sidebar-workspace-trailing-scrim`，主题隐藏该原生遮罩并为统计区预留 24px；真实 `+27.5k/-17.4k` 行在 hover 后与更多按钮的横向重叠为 0px，`auxiliaryLayerIssues` 与 `workspaceActionOverlaps` 均为空。renderer audit 覆盖 21 类页面和 5 类 hover，原路径与侧栏滚动位置完整恢复。

0.9.0 发布审计使用本机正在运行的 Paseo 0.3.0 与回环 CDP `127.0.0.1:9224`。真实 renderer 验证确认 `#root` 可见、overlay 不接收指针、无横向溢出、浅色主题使用 `color-scheme: light`；workspace、计划、历史、新建页分别同步到 `workspace`、`utility`、`utility`、`home`。非选中 workspace 行的背景在 hover 前后均为透明，hover 中为主题主色 10%，三种状态都没有残留内联背景。

## Runtime contract

- App bundle identifier：`sh.paseo.desktop`
- Renderer target：`paseo://app/`
- Required native root：`#root` 必须存在且保持可见
- Injection lifecycle：单一 scene overlay、单一 style、幂等更新和完整 `destroy`
- Theme marker：`window.__PASEO_STAGE_BLACK_GOLD_SKIN__`
- CDP：指定端口、page target、回环 WebSocket，拒绝凭据、query、fragment 和非 page endpoint
- Restore：注销 reload hook，再移除 observer、overlay、style 和动态内联样式

## After a Paseo update

1. 先运行 `paseo-skin doctor --json` 和 `paseo-skin status --json`。
2. 在独立窗口检查首页、普通 workspace、设置/搜索和弹窗。
3. 运行 `paseo-skin verify --screenshot <absolute-path>`。
4. 停止 watcher，运行 `paseo-skin reset`，确认原生 UI 恢复。
5. 只有上述证据全部通过，才更新本表的版本和日期。

Windows 证据仅适用于 fork 的 `windows-support` 分支和 Paseo 0.10.3。独立任务中，Task Scheduler 的 `RestartOnFailure` 设置没有在非零退出后触发重启；本分支改由隐藏启动器在 Node 非零退出后重试，并已在正式 Guardian Node 遭外部终止后验证。逐页冷注入已在隔离的双 workspace profile 上验证，详见 `docs/RENDERER_STYLE_SAFETY.md`。Windows CI matrix 已加入；各 commit 的实际通过状态必须查对应的 GitHub Actions 结果，本机测试不能代替云端收据。隐藏启动器或排程本身遭外部终止后的恢复未验证。公开上游包与网站导出的 Agent Skill 仍是 macOS 版本；fork 分支内的 Skill 增加 Windows 工作流。Linux 和 Intel Mac 当前均未声明支持；新增平台必须提供真实设备证据和对应 CI/恢复测试。
