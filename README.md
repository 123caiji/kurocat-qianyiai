# 🐈‍⬛ KuroCat

轻量级 **Windows & macOS（Apple Silicon + Intel 通用版）** 透明置顶桌面打字猫咪伴侣（开箱自带 **6 款手绘猫咪皮肤**：经典小黑猫、暖奶茶布偶猫、大橘猫、三花猫、奶牛猫、暹罗猫，并原生内置 **MCP 协议服务端**，支持用 AI 一句话定制或新增更多你自己的猫咪！），基于 **Tauri v2（Rust 全局原生钩子 + 内置 MCP 引擎 + HTML5 Canvas 2D）** 打造。单文件轻量低耗，零外部运行时依赖。

## ✨ 核心特性

- **6 款内置猫咪外观 + MCP 无限自定义**：
  - **🐈‍⬛ 经典小黑猫** / **🐱 暖奶茶布偶猫** / **🍊 大橘猫**（虎斑 `M` 额纹 + 环纹尾） / **🌸 三花猫** / **🐄 奶牛猫**（燕尾服 + 白手套） / **🤎 暹罗猫**（挖煤重点色），右键或系统托盘 0.1 秒一键无缝切换。
  - **🤖 原生内置 MCP 服务（AI 一句话捏自己的猫）**：无需装 Node.js 或 Python，直接把自家猫照片发给 **Claude Desktop / Cursor / Antigravity / Windsurf / Cline**，AI 通过内置 MCP 工具自动生成橘猫（虎斑 `M` 额纹 + 环纹尾）、三花猫、奶牛猫、暹罗猫、英短蓝猫或带专属胎记斑块的独一无二桌宠，**0.4 秒热更新到桌面、无需重启**！
- **面向猫咪的真实 180° 桌宠透视**：
  - 65% 白灰机械键盘与鼠标均 180° 朝向猫咪摆放（空格行紧贴猫爪、橙色右 Shift 居左上、橙色 Esc 居右下，按键字符面向猫咪，小鼠滚轮与左右键朝外）。
  - 猫右手（画面左侧）自然负责鼠标与右侧键区（`7–0`、`Y–P`、`H–L`、`N–M`、`Enter`），猫左手（画面右侧）负责 `WASD` 等左侧键区，纯打字时头部与上身随敲击节奏灵动左右晃动歪头，未敲键一侧自动蜷爪收在胸前。
- **摸头眯眼与呼噜互动**：鼠标移到猫头上自动切换为黑白描边小手光标，来回抚摸即触发慵懒细眯眼表情，并伴随 Web Audio 实时合成的温柔猫咪呼噜声（默认开启，可随时开关，不干扰自身键鼠声音）。
- **错落弹跳 3D 按键气泡**：键盘上方实时弹出白底立体键帽，支持一键隐藏（输密码更安心）。
- **智能鼠标穿透 & 系统托盘**：透明区域自动点击穿透不遮挡办公或游戏，右键猫咪或系统托盘可一键切换外观、调整缩放（75%–150%）、开关 MCP 服务并**一键复制 MCP 配置**。

## 🤖 MCP 接入指南（用 AI 改猫 / 加自己的猫）

KuroCat `v4.0.0+` 单文件程序原生内置 **Stdio** 与 **本机 Streamable HTTP（`127.0.0.1:27420`）** 双模式 MCP Server，无需任何额外依赖！

### 最快接入方式
1. 运行 `KuroCat`，右键猫咪 → 确认勾选 **「开启 MCP 扩展」** → 点击 **「复制 MCP 配置」**。
2. 粘贴到你常用的 AI 客户端 MCP 配置文件（Claude Desktop / Cursor / Antigravity / Windsurf / Cline）：

**方式 A：Stdio 模式（通用推荐，所有 MCP 客户端均支持）**
```json
{
  "mcpServers": {
    "kurocat": {
      "command": "C:\\Users\\<你的用户名>\\AppData\\Local\\KuroCat\\KuroCat.exe",
      "args": ["--mcp"]
    }
  }
}
```

**方式 B：本机 HTTP 模式（桌宠运行时直接连接）**
```json
{
  "mcpServers": {
    "kurocat": {
      "url": "http://127.0.0.1:27420/mcp"
    }
  }
}
```

### 试试这样跟 AI 说
- *「帮我用 KuroCat MCP 新增一只大橘猫（虎斑纹 + 白手套 + 橘色高亮键盘），并马上切过去」*
- *「看这张我家三花猫的照片，用 KuroCat MCP 按它的花色和斑点给我捏一只专属桌宠！」*
- *「把桌宠放大到 125%，关闭悬浮按键气泡，切回小黑猫」*

### 内置 MCP 工具清单
| 工具名 | 功能说明 |
| --- | --- |
| `list_cats` | 查看所有内置与自定义猫咪外观及当前激活的猫 |
| `get_cat_schema` | 获取完整花色参数规范、6 种花纹（`solid`/`bicolor`/`tuxedo`/`tabby`/`calico`/`siamese`）、自定义斑点坐标与常见品种模板 |
| `upsert_cat` | 新增或修改任意自定义猫咪（毛色、花纹、耳朵、瞳色、尾巴、白手套、高亮色、自定义胎记斑块），实时热更新上屏 |
| `switch_cat` | 按 ID 秒切桌面当前显示的猫咪 |
| `delete_cat` | 删除指定自定义猫咪（或重置内置外观） |
| `get_settings` / `update_settings` | 读取或实时修改缩放比例、按键气泡、呼噜声、置顶、穿透锁定与开机自启 |

自定义猫咪配置保存在：
- **Windows**：`%APPDATA%\kuro-cat-pet\cats.json`
- **macOS**：`~/Library/Application Support/kuro-cat-pet/cats.json`

也可手动编辑，桌宠自动实时热重载。

## 📥 直接下载使用（Windows & macOS）

前往 [Releases](https://github.com/qianyiai/kurocat/releases) 页面下载最新 `v4.3.0` 安装包：

- **Windows 10 / 11（x64）**：
  - **推荐：正式安装包** `KuroCat_4.3.0_x64-setup.exe` — 专属品牌安装向导，自动创建 **`KuroCat`** 桌面图标、开始菜单与系统应用卸载入口。
  - **绿色免安装单文件**：`KuroCat-v4.3.0-windows-x64.exe` — 双击即运行，右键猫咪或系统托盘也可一键 **「创建桌面图标」**。
- **macOS 11+（Apple Silicon M1/M2/M3/M4 & Intel 通用版）**：下载 `KuroCat-v4.3.0-macos-universal.dmg`，将 `KuroCat.app` 拖入「应用程序」文件夹运行。
  - **首次打开说明（开源未公证应用）**：若提示「无法验证开发者」或「已损坏」，在终端执行一次 `xattr -cr /Applications/KuroCat.app` 后即可正常打开。
  - **辅助功能权限（用于全局监听敲键盘/鼠标）**：首次启动会自动弹出系统授权引导，在「系统设置 → 隐私与安全性 → 辅助功能」中打开 `KuroCat` 开关即可立即生效（无需重启）。
  - **macOS Stdio MCP 路径**：`/Applications/KuroCat.app/Contents/MacOS/KuroCat`（参数 `--mcp`），或在桌宠运行时直接连接 `http://127.0.0.1:27420/mcp`。

## 🛠️ 本地源码构建

前置环境：Windows 10/11 或 macOS 11+、Node.js 18+、Rust 工具链（`cargo`）。

```bash
git clone https://github.com/qianyiai/kurocat.git
cd kurocat
npm install
npm run tauri:dev      # 本地热更新调试
npm run tauri:build    # 编译 Release 可执行文件与安装包
```

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。
