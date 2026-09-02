# Live Caption & Translation

面向现场会议、线上通话与无障碍参与的实时字幕工具。浏览器接收麦克风、标签页或系统声音，持续显示原文与译文；参与者也可以扫码查看字幕或用文字加入对话。

在线版本：<https://jimmygplus.github.io/live-caption/>

## 主要能力

- 实时字幕与双向翻译，原文和译文始终分层显示。
- 会前音频体检：检测说话音量、环境底噪、削波和静音，并给出可选的收音门限。
- 一次性推荐码可兑换一次最长 30 分钟的 Soniox 高质量字幕体验。
- 支持系统默认麦克风、指定麦克风、标签页音频和系统声音。
- 字幕直播间：可扫码直接加入，也可输入短地址和 10 位房间码，经主持人核对后安全加入。
- 定稿字幕可修正；修正会同步到主持端、扫码端和导出文件。
- 列表、影院、单行横滚、全屏和置顶浮窗等显示模式。
- 字号比例锁、时间戳、发言人、行业术语和短／中／长分段。
- 本地恢复以及 TXT、Markdown、SRT 导出。

## 运行模式

同一套前端支持两种部署方式：

| 模式 | 适合场景 | 字幕与翻译 | 多端参与 |
|---|---|---|---|
| 静态站点 | GitHub Pages、Cloudflare Pages、公开分享 | 用户配置自己的密钥，或用推荐码取得一次性 Soniox 临时 Key | 通过独立 Cloudflare relay 同步端到端加密数据 |
| Node 服务 | 本地运行、私有部署、服务端密钥 | 服务端签发 Soniox 临时令牌，并可代理腾讯云、混元或 Claude 翻译 | 提供进程内文字输入房间 |

静态模式没有构建步骤，`public/` 本身就是完整站点。应用探测不到 `./api/config` 时会自动进入静态模式。

## 快速开始

需要 Node.js 22 或更高版本。项目没有第三方运行时依赖，因此无需安装依赖包。

```bash
cp .env.example .env
npm start
```

然后打开 <http://localhost:5175>。未配置 Soniox 时会回退到浏览器语音识别；完整实时字幕体验建议配置 `SONIOX_API_KEY`。

常用环境变量：

| 变量 | 用途 |
|---|---|
| `SONIOX_API_KEY` | Soniox 实时字幕；Node 模式只向浏览器签发短时令牌 |
| `ANTHROPIC_API_KEY` | Claude 定稿句翻译 |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | 腾讯 TMT 与混元翻译，仅 Node 模式使用 |
| `PUBLIC_URL` | 扫码入口应使用的外部可访问地址 |
| `PORT` | 本地端口，默认 `5175` |

完整选项和注释见 [`.env.example`](.env.example)。

## 项目结构

```text
live-caption/
├── public/                       # 无构建步骤的浏览器应用
│   ├── index.html                # 主持端页面与可访问语义结构
│   ├── app.js                    # 会话、字幕、翻译、音频和 UI 编排
│   ├── styles.css                # 桌面、手机、剧场与对话框样式
│   ├── pcm-worklet.js            # PCM 转换、门限处理和电平采样
│   ├── audio-check.js            # 会前体检分类与自适应门限模型
│   ├── audio-source.js           # 输入设备偏好与无信号状态
│   ├── caption-state.js          # 字幕修正、revision 与状态投影
│   ├── font-size.js              # 原文／译文字号比例约束
│   ├── input.html/css/js         # 扫码参与端
│   ├── j.html + join.css/js      # 无法扫码时的短码加入页
│   ├── audience-crypto.js        # 字幕直播间端到端加密
│   ├── join-crypto.js            # 临时 ECDH 密钥包装与核对码
│   ├── trial-code.js             # 推荐码格式与安全 POST 兑换客户端
│   ├── trial-config.js           # 独立试用兑换 Worker 地址
│   ├── qr.js                     # 本地二维码编码
│   ├── relay-config.js           # 静态站 relay 地址
│   └── glossaries.json           # 内置行业词库
├── server.js                     # 零依赖静态服务器与 Node API
├── providers/translate.js        # 可插拔的服务端翻译 provider
├── relay/
│   ├── src/index.js              # Cloudflare Durable Object relay
│   └── wrangler.jsonc            # relay 部署配置
├── trial/
│   ├── src/index.js              # 推荐码核销与 Soniox 临时 Key broker
│   ├── migrations/               # D1 推荐码、兑换和速率限制表
│   ├── scripts/generate-codes.mjs # 离线生成推荐码与导入 SQL
│   └── wrangler.jsonc            # 独立 Worker 与 D1 绑定
├── docs/caption-room-protocol.md # 多端房间协议与安全模型
├── test/                         # Node 单元、协议与回归测试
├── .github/workflows/pages.yml   # GitHub Pages CI/CD
├── .env.example                  # 本地服务配置模板
└── package.json                  # 启动与测试命令
```

前端把可独立验证的规则拆成纯模块，例如音频体检、音频源选择、字号约束和字幕 revision；`app.js` 负责把这些规则与浏览器 API、网络和 DOM 连接起来。

## 数据流

```text
麦克风 / 标签页 / 系统声音
          │
          ▼
AudioWorklet ── 电平与峰值 ──→ 会前体检 / 音量条 / 收音门限
          │
          └── 16 kHz PCM ───→ Soniox WebSocket
                                  │
                                  └── 原文 token + 译文 token

主持端 ── AES-GCM 字幕密文 ──→ 临时 relay ──→ 扫码端本地解密
  ▲                                  │
  └──────── 文字发言密文 + ACK ──────┘
```

推荐码体验走另一条独立控制链：浏览器以 POST 把推荐码发给 Trial Worker，Worker 在 D1
原子核销并用长期 Soniox Key 签发单次临时 Key；随后音频仍由浏览器直接连接 Soniox。
Trial Worker 不代理音频，字幕直播间 relay 也不持有厂商密钥。

字幕识别和翻译是两层独立能力。Soniox 可以在同一条流中返回原文与内联译文；腾讯、混元和 Claude provider 则接收已经定稿的完整句子。这样可以替换翻译服务而不改动音频与字幕管线。

## 会前音频体检

体检使用当前选择的输入设备，并显示实际设备、当前手动门限和音频处理设置。流程分为两段：

1. 保持安静 2.5 秒，测量环境底噪。
2. 用平常音量说一句话 4 秒，测量语音电平、峰值和信噪关系。

模型会区分收音良好、语音偏小、背景噪声偏高、削波和静音。建议门限以环境底噪为起点，同时受测试语音强度约束，避免为了压噪而截掉较轻的说话声。

建议值不会自动生效。用户明确点击“采用建议值”后才写入现有门限滑块，之后仍可手动修改或关闭。检测只保留聚合结果；不录音、不上传，也不保存逐帧电平历史。

## 扫码字幕直播间

主持端点击“扫码加入”创建临时房间。能扫码的参与者仍可直接加入；无法扫码时，可打开主持人展示的短地址并输入 10 位房间码。参与页与主持端会显示相同的六位验证码，主持人核对并批准后，真实加入密钥才会通过临时 ECDH 密钥加密传给参与者。

短地址只包含房间码，不包含字幕解密密钥，也不会把完整邀请链接交给第三方短链服务。参与端把文字发言放在字幕历史之前，最近字幕只提供上下文，完整记录可按需展开。

GitHub Pages 使用 `relay/` 中的 Cloudflare Durable Object。字幕和文字在浏览器本地以 AES-GCM 加密，中继只处理房间标识、密文、序号和确认状态。房间凭证位于 URL fragment，参与端读取后会从地址栏移除。主持端刷新同一标签页时可从 `sessionStorage` 恢复会话；结束房间或到期后 relay 会删除临时状态。

协议、角色、重试和威胁边界见 [`docs/caption-room-protocol.md`](docs/caption-room-protocol.md)。

## 推荐码体验

静态站可以让用户输入一次性推荐码，兑换一次最长 30 分钟的 Soniox 字幕。推荐码只在用户
点击“开始”时通过 POST 核销，不进入 URL、浏览器持久存储或 analytics。Soniox 临时 Key
必须在 60 秒内启用、只能建立一条流，并由 Soniox 服务端在 1800 秒时终止。

第一版是一段连续体验：主动停止、刷新或断线都会结束本次权益，不保留剩余分钟。自有密钥、
浏览器语音识别和 Node `/api/token` 不受影响。部署、Secrets 和推荐码生成见
[`docs/trial-broker.md`](docs/trial-broker.md)。

## 无障碍与隐私

- 主持端和参与端均支持键盘操作、清晰焦点、状态播报和手机触控尺寸。
- 原文是主字幕，译文是补充信息；字号、颜色和布局不会互相替换。
- 参与端会明确区分主持人在线、暂时离开和直播间结束。
- 静态模式的厂商密钥只保存在当前浏览器，不进入字幕 relay。
- Node 模式的 Soniox 长期密钥留在服务端，浏览器只获得短时令牌。
- 音频直接发送给所选字幕厂商，不经过字幕直播间 relay。

## 测试

```bash
npm test
```

测试覆盖音频体检的安静语音、嘈杂房间、削波与静音样本，以及字幕 revision、布局、扫码加密房间、短码 ECDH 批准／拒绝流程、推荐码原子核销与上游失败补偿、relay 状态和腾讯 TC3 签名。

浏览器回归可用无麦克风的调试入口注入固定数据：

```js
__lc.audioCheck({
  ambientFrames: [{ rms: 0.002, peak: 0.006 }],
  speechFrames: [{ rms: 0.05, peak: 0.3 }],
})
```

## 部署

### GitHub Pages

仓库的 [`.github/workflows/pages.yml`](.github/workflows/pages.yml) 会在 `main` 更新后发布 `public/`，并为静态资源加提交版本号以避免旧缓存混用。

### Cloudflare Pages

连接仓库，构建命令留空，输出目录设为 `public`。

### 字幕直播间 relay

```bash
npx wrangler login
npx wrangler deploy --config relay/wrangler.jsonc
```

部署后将 Worker 地址配置到 `public/relay-config.js`。不要提交私有路径、访问令牌或房间凭证。

### 推荐码 Trial Worker

Trial Worker 与字幕 relay 独立部署，长期 Soniox Key 和推荐码 HMAC Key 只保存为 Worker
Secrets。完整命令见 [`docs/trial-broker.md`](docs/trial-broker.md)。生产地址配置到
`public/trial-config.js`；未配置时前端不会显示推荐码入口。

## 运行边界

- 麦克风需要安全上下文：HTTPS 或 `localhost`。
- 浏览器语音识别主要依赖 Chrome / Edge，且自身不提供翻译。
- 标签页和系统声音捕获能力取决于浏览器与操作系统；不支持时可选择虚拟音频设备。
- 静态站的跨设备字幕依赖已配置的 relay；GitHub Pages 本身不提供服务器能力。
- Node 进程内文字房间不提供静态 relay 的跨设备字幕回放。
- 单条 Soniox 流有服务时长限制；应用会自动重连并保留已完成字幕。
