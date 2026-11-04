# NovelAI WebUI (fnOS Native)

NovelAI WebUI 是一款专为飞牛私有云 (fnOS) 打造的第三方原生客户端，提供完整的 NovelAI 绘画、管理与归档体验。

## 核心特性

- 纯网关安全接入：接入飞牛系统统一反向代理网关与登录鉴权，通过 Unix Domain Socket 内部通信，无需监听宿主机公网端口，无端口冲突隐患。
- 数据本地化持久存储：所有画作、生图历史、提示词记录、自定义角色库与画师风格库均保存在 NAS 本地共享目录（`/shares/NovelAI-WebUI`），不经过第三方存储。
- 高性能分表存储：底层存储采用 Node.js 22 原生内置 SQLite (node:sqlite) 并开启 WAL 模式，毫秒级快速写入，具备断电保护，杜绝单文件膨胀与主线程阻塞。
- 自定义图片目录归档：支持按规则自动创建子目录归档图片（默认 `/{year}/{month}/`），支持 `{year}`, `{month}`, `{day}`, `{date}`, `{model}`, `{profile}` 等变量自定义，并提供实时路径预览与格式校验。
- 完整绘画能力：支持文生图、图生图、涂抹局部重绘 (Inpaint)、V5 模型精准计费与生成、高画质超分放大 (Upscale) 及参数复用。
- 多端适配与弱网优化：支持 PC 浏览器、平板及手机飞牛 App 内嵌 WebView 布局，支持深色/浅色主题自动跟随。

## 运行环境与依赖

- 依赖运行环境：飞牛应用中心官方 `nodejs_v22`。
- 运行权限：受限应用包用户（package:novelai），严格非 root 运行。
- 数据存储目录：`/shares/NovelAI-WebUI`（在飞牛“文件管理”中可直接查看与整理）。

## 构建与打包

构建需要 Node.js 22 或更高版本：

```bash
# 1. 安装依赖并构建前端
cd frontend
npm install
npm run build
cd ..

# 2. 安装服务端生产依赖
npm --prefix app/server install --omit=dev

# 3. 构建多架构 fnOS 安装包 (.fpk)
node scripts/build_fpk.js
```

构建产物将输出至 `dist_fpk/` 目录，包含全架构通用包 (`all`)、x86 架构包 (`amd64`) 及 ARM 架构包 (`arm64`)。

## 重要声明

1. 本软件为开源第三方客户端，自身完全免费，不含任何应用内购买、付费解锁或收费行为。
2. 图像生成功能由第三方服务商 NovelAI (Anlatan) 官方提供，使用时需用户自备并填入有效的 NovelAI API Token。
3. 相关的账号额度、Anlas 点数计费与订阅机制均属于 NovelAI 官方商业行为，与飞牛官方及本项目开发者无关。

## 开源协议

本项目基于 MIT 协议开源。
