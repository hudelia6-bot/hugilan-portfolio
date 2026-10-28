# 个人网站 · 胡贵兰

带着工程和数据底子，做 AI 应用的业务落地。包含个人主页与「旅记地图」demo。

## 目录
- `index.html` — 个人主页
- `demo/` — 旅记地图 demo（PWA，可添加到主屏幕）
- `worker.js` — Cloudflare Worker 服务端代理（LLM 抽取 + 高德地理编码）

## 本地开发
```bash
cd 个人网站 && node server.mjs
# 打开 http://127.0.0.1:8765/
```

## 部署
- 静态站：GitHub Pages（本仓库根目录）
- 服务端：`worker.js` 部署到 Cloudflare Worker
  ```bash
  npx wrangler deploy
  wrangler secret put LLM_API_KEY
  wrangler secret put AMAP_KEY
  ```
  环境变量：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`AMAP_KEY`。
- demo 页首次打开后，在「模型配置」里填入 Worker 地址（如 `https://xxx.workers.dev`）即可调真实接口。
