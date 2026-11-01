# cc-unlimitconnect

Claude Desktop **Code 标签页**无限报错重连补丁：临时请求失败后每隔 **3 秒**重试，次数不限。

**支持 Windows x64，当前已验证的 Code 引擎为 2.1.309。** Code 引擎版本与桌面 App 版本不同；其他引擎版本会拒绝安装。

[下载一键安装包](https://github.com/Aflydream/cc-unlimitconnect/releases/latest)

## 使用

1. 下载 Release 中的 `cc-unlimitconnect-v1.0.0.zip`，完整解压。
2. 双击 `Install.cmd`。
3. 从托盘彻底退出 Claude，再打开新增的 **Claude Unlimited Retry** 桌面快捷方式。

无需管理员、Python 或 Node.js。安装器使用 Windows 自带的 PowerShell 5.1；补丁模块嵌入 `Install.ps1`，这个脚本也可以单独下载运行。

如果没有检测到引擎，先打开 Code 标签页，等引擎下载完成后再安装。本项目不会下载或降级 Claude。普通 Claude 快捷方式保留；使用补丁时从新增快捷方式启动。

## 重试行为

- 临时 HTTP 错误（408、409、429、5xx）、连接故障、输出前的已识别流式临时错误：失败后等 3 秒，无限重试。
- 单次请求超时为 30 分钟，超时后继续重试；整轮重试没有次数或累计时间上限。
- 成功或手动停止后结束；认证、证书等永久错误仍会终止。
- 收到内容或工具调用后，补丁不重新发送已交付的流。
- SDK 进度字段只支持有限数字，界面可能显示一个很大的重试分母。该数字仅用于显示，实际循环没有次数上限。

沿用各自现有的 API 地址、账号和代理配置，支持 API 地址中的路径前缀。只提供重试功能，不附带遥测开关、隐私代理、防火墙或其他网络功能，不修改官方 exe。

## 路径与更新

默认安装到 `%LOCALAPPDATA%\ClaudeUnlimitedReconnect`。路径含空格时自动使用 Windows 短文件名；若短文件名不可用，选择无空格目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -InstallDir D:\ClaudeUnlimitedReconnect
```

引擎更新后需要重新运行安装器确认支持。此项目依赖当前 SDK 内部接口，是本地兼容补丁，不是 Anthropic 官方发布的客户端。

## 源码与验证

`src/` 保留未编码的模块、启动器和安装模板，便于阅读。仓库没有 API 密钥、作者的个人配置或官方 exe。

开发者可使用 Python 3.10+ 重建安装器和发布 ZIP，使用 Node.js 20+ 运行重试逻辑测试。这些工具仅用于开发，不是安装依赖。

```powershell
python scripts/build.py
node tests/retry-core.test.cjs
```

验证涵盖超过 200 次后的恢复、手动取消、HTTP/SSE/网络错误、单次超时后的重试、中文及空格路径、重复安装、失败还原、版本拒绝、自动识别，以及真实捆绑引擎在本机模拟 API 上的约 3 秒重试。未调用付费模型；验证摘要见 [docs/verification.json](docs/verification.json)。
