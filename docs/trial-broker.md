# 推荐码 Soniox 体验服务

`trial/` 是公开静态站的最小付费能力控制面。它只校验推荐码、限流计数并签发 Soniox
临时 Key；浏览器拿到临时 Key 后直接连接 Soniox，音频和字幕不经过这个 Worker。

它必须和 `relay/` 分开部署。字幕 relay 的职责仍然只是转发端到端加密的房间数据，不能持有
Soniox 长期 Key。

## 权益规则

- 推荐码是**共享密码**，不是一次性券：同一个码可以给多个人、反复使用。
- 密码存在 Worker Secret 里，前端代码中没有任何秘密。
- 每天签发上限由 `TRIAL_DAILY_LIMIT` 控制（默认 20）。按 Soniox 约 0.12 AUD/小时算，
  一次体验约 0.06 AUD，20 次的上限把失控的一天封在 1.2 AUD 左右。
- 单个来源地址每天最多 `TRIAL_DAILY_PER_ADDRESS` 次（默认 3），防止一个人把当天名额
  刷光，让码对你真正想分享的人仍然可用。同一个 NAT 后面的人共享这个额度，所以不是 1。
- 密码错误**不消耗**任何名额——先验密码再计数，否则乱猜就能把配额耗光。
- 单 IP 十分钟内最多 10 次尝试。
- 刻意不做浏览器指纹：对隐私不友好、跨浏览器不可靠，而且换个无痕窗口就绕过了——
  只会困住老实人。上面两条服务端配额才是真正起作用的部分。
- 临时 Key 的启用窗口是 60 秒，`single_use` 为 `true`。
- 每条 Soniox WebSocket 最长运行 1800 秒，由 Soniox 服务端强制关闭。
- 停止、刷新或断线后不恢复剩余分钟。

想换密码就重新 `wrangler secret put TRIAL_PASSWORDS`，旧密码立刻失效——这是唯一的
“作废”操作，不需要查表或核销。

## 创建 D1

```bash
npx wrangler d1 create live-caption-trials
```

把返回的 `database_id` 填到 `trial/wrangler.jsonc`，然后应用 schema：

```bash
npx wrangler d1 migrations apply live-caption-trials --remote --config trial/wrangler.jsonc
```

## 配置 Secrets

为试用流使用独立的 Soniox Project/API Key，并在 Soniox 设置项目预算上限。长期 Key 通过
Wrangler 隐藏输入，不要写入 `.env`、命令参数或仓库：

```bash
npx wrangler secret put SONIOX_API_KEY --config trial/wrangler.jsonc
```

推荐码本身也是 Secret，逗号分隔可以同时有多个（比如按分享渠道区分）：

```bash
npx wrangler secret put TRIAL_PASSWORDS --config trial/wrangler.jsonc
# 提示符里输入，例如：LAUNCH2026,FRIENDS2026
```

速率限制表里的 IP 需要一个盐，至少 32 字节，只用于哈希地址：

```bash
npx wrangler secret put TRIAL_RATE_SALT --config trial/wrangler.jsonc
```

## 分享方式

把密码放进链接，对方点开即可，不用手输：

```
https://jimmygplus.github.io/live-caption/?k=LAUNCH2026
```

前端读到 `?k=` 后会立刻把它从地址栏移除，所以不会留在浏览器历史、截图或对方转发的链接里。

## 部署

```bash
npx wrangler deploy --config trial/wrangler.jsonc
```

把 Worker 地址写入 `public/trial-config.js` 的 `TRIAL_BROKER_URL`，再部署 GitHub Pages。
Worker 只接受 `ALLOWED_ORIGINS` 中的 Origin；增加正式域名时必须同时更新配置并重新部署。

## 安全和运维

- D1 只保存两类计数：按 IP 哈希的十分钟窗口，和每日总量。没有码表，没有兑换记录。
- IP 只以 HMAC 形式入库，原始地址不落库，过期窗口每日清理。
- Worker 不保存临时 Key，日志只记布尔值和长度，不记密钥内容。
- 上游失败不回滚当日计数：近似的上限比精确的上限便宜得多，也够用。
- 共享密码无法识别“同一个人”，也无法阻止转发。它防的是随机访客，不是决心滥用的人；
  真正兜底的是每日上限和 Soniox 侧的项目预算。
- 需要账户、可恢复分钟数或邀请奖励时，应在商业版实现额度账本，而不是给密码加规则。
