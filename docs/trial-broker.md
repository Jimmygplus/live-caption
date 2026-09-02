# 推荐码 Soniox 体验服务

`trial/` 是公开静态站的最小付费能力控制面。它只接收推荐码、核销 D1 额度并签发 Soniox
临时 Key；浏览器拿到临时 Key 后直接连接 Soniox，音频和字幕不经过这个 Worker。

它必须和 `relay/` 分开部署。字幕 relay 的职责仍然只是转发端到端加密的房间数据，不能持有
Soniox 长期 Key。

## 权益规则

- 推荐码默认只可兑换一次，也可以在 D1 中显式设置 `max_redemptions`。
- 临时 Key 的启用窗口是 60 秒，`single_use` 为 `true`。
- 每条 Soniox WebSocket 最长运行 1800 秒，由 Soniox 服务端强制关闭。
- 停止、刷新或断线后不恢复剩余分钟。
- `client_reference_id` 由 Worker 生成并绑定到临时 Key，可关联 Soniox usage logs。

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

推荐码使用另一个至少 32 字节的 HMAC Secret。保存到仓库外、限制文件权限，并把同一个值
交给 Worker 和离线推荐码生成器：

```bash
mkdir -p ~/.config/live-caption
openssl rand -hex -out ~/.config/live-caption/trial-code-hmac-key 32
chmod 600 ~/.config/live-caption/trial-code-hmac-key
npx wrangler secret put TRIAL_CODE_HMAC_KEY --config trial/wrangler.jsonc \
  < ~/.config/live-caption/trial-code-hmac-key
```

## 生成并导入推荐码

代码和 SQL 必须输出到仓库外。以下示例生成 20 个在指定日期到期的一次性码：

```bash
TRIAL_CODE_HMAC_KEY="$(<~/.config/live-caption/trial-code-hmac-key)" \
node trial/scripts/generate-codes.mjs \
  --count 20 \
  --campaign launch \
  --expires 2026-10-01T00:00:00Z \
  --codes /private/tmp/live-caption-launch-codes.txt \
  --sql /private/tmp/live-caption-launch-codes.sql

npx wrangler d1 execute live-caption-trials --remote --config trial/wrangler.jsonc \
  --file /private/tmp/live-caption-launch-codes.sql
```

`--codes` 文件是可兑换能力，权限默认为 600。交付后应移入密码管理器并删除临时文件；不要
贴进 Issue、CI 日志、analytics 或提交到 Git。

## 部署

```bash
npx wrangler deploy --config trial/wrangler.jsonc
```

把 Worker 地址写入 `public/trial-config.js` 的 `TRIAL_BROKER_URL`，再部署 GitHub Pages。
Worker 只接受 `ALLOWED_ORIGINS` 中的 Origin；增加正式域名时必须同时更新配置并重新部署。

## 安全和运维

- D1 只保存推荐码 HMAC、活动、次数、到期时间和脱敏兑换记录。
- IP 只以 HMAC 形式进入十分钟速率限制桶；原始地址不落库，旧桶每日清理。
- Soniox 上游失败会把兑换标记为 `upstream_failed` 并返还推荐码次数。
- Soniox usage logs 通过 `trial_<redemption-id>` 关联用量；Worker 不保存临时 Key。
- 推荐码只能控制兑换次数，不能可靠识别“同一个人”。需要邀请人奖励、账户或可恢复分钟数时，
  应在商业版实现账户和额度账本，而不是依赖浏览器指纹。
