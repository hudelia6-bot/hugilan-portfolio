# 旅记地图 · 不装 App，把旅行笔记变成地图收藏

粘贴一篇小红书 / 公众号旅行笔记，AI 抽出地点，一键打开苹果、高德、谷歌地图收藏。PWA 支持「添加到主屏幕」。

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
  npx wrangler secret put LLM_API_KEY
  npx wrangler secret put AMAP_KEY
  ```
  环境变量：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`AMAP_KEY`。
- 页面「模型配置」里填入 Worker 地址（如 `https://xxx.workers.dev`）即可调真实接口；未配置时自动演示模式。
