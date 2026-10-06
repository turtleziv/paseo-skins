# Support

使用前先运行：

```bash
npm run doctor -- --json
npm run status -- --json
```

Windows PowerShell 在固定 checkout 根目录也可执行同样的 `npm run` 命令；一次性 GitHub CLI 调用请使用 `npx.cmd`，macOS Terminal 使用 `npx`。报告常驻问题时，请从安装 Guardian 的固定 checkout 运行 `node ./src/cli.mjs autostart status --json`，并注明操作系统、Paseo 版本与 CLI commit。公开主题 ZIP 须先解压，再以 `inspect --theme` 指向 `.theme.json`。

- 安装、注入、主题显示或恢复异常：使用 Bug report 模板，并提供脱敏后的 `doctor`、`status`、`verify` 输出。
- 新主题：使用 Theme submission 模板，必须提供作者、原始来源、许可证与公开再分发确认。
- 功能建议：使用 Feature request 模板，写清使用场景、验收结果与恢复边界。
- 安全漏洞：通过 GitHub Private Vulnerability Reporting 私密报告，不要建立公开 issue。

项目不会要求上传 Paseo 会话、Agent 数据、cookies、token 或完整用户目录。公开截图前请先隐藏项目名称和对话内容。
