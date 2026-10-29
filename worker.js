// 旅记地图 · Cloudflare Worker（服务端代理）
// 职责：/api/config /api/extract /api/geocode /api/parse-link；静态文件由 GitHub Pages 托管。
// 部署：wrangler deploy；密钥用 `wrangler secret put`：
//   LLM_API_KEY（必填，阿里百炼 qwen-flash）、AMAP_KEY（可选，高德地理编码）

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen-flash';

const DEMO = {
  region: '杭州',
  places: [
    { name: '西湖', type: '景点' }, { name: '断桥', type: '景点' }, { name: '河坊街', type: '商圈' },
    { name: '灵隐寺', type: '景点' }, { name: '龙井村', type: '景点' }, { name: '满觉陇', type: '住宿' },
    { name: '杭州东站', type: '交通' }, { name: '万象城', type: '商圈' },
  ],
};

// —— 防滥用：来源校验 + 按 IP 限流（内存级，冷启动/多实例会重置；更强防护可再加 Turnstile 或 WAF 限流规则）——
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10; // 每个 IP 每分钟最多 10 次请求
const rlHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { rlHits.set(ip, arr); return true; }
  arr.push(now); rlHits.set(ip, arr);
  if (rlHits.size > 5000) { const old = [...rlHits.keys()].slice(0, 1000); old.forEach((k) => rlHits.delete(k)); }
  return false;
}
function originAllowed(origin, env) {
  if (!origin) return true;
  const allow = (env.ALLOWED_ORIGINS || 'https://hudelia6-bot.github.io,http://localhost,http://127.0.0.1')
    .split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
  return allow.some((a) => origin === a || origin.startsWith(a + ':') || origin.startsWith(a + '/'));
}

// 坐标系：高德/国内用 GCJ-02，苹果/谷歌用 WGS-84。
const A = 6378245.0, EE = 0.00669342162296594323;
const outOfChina = (lng, lat) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
function transformLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}
function transformLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}
function wgs2gcj(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}
function gcj2wgs(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let wgLng = lng, wgLat = lat;
  for (let i = 0; i < 8; i++) {
    const [tLng, tLat] = wgs2gcj(wgLng, wgLat);
    const dLng = tLng - lng, dLat = tLat - lat;
    if (Math.abs(dLng) < 1e-7 && Math.abs(dLat) < 1e-7) break;
    wgLng -= dLng; wgLat -= dLat;
  }
  return [wgLng, wgLat];
}

async function geocode(name, amapKey) {
  if (!amapKey || !name) return null;
  const u = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(name)}&key=${amapKey}`;
  try {
    const r = await fetch(u); const d = await r.json();
    if (d.status === '1' && d.geocodes && d.geocodes[0] && d.geocodes[0].location) {
      const [lng, lat] = d.geocodes[0].location.split(',').map(Number);
      const [wLng, wLat] = gcj2wgs(lng, lat);
      return { lng, lat, wgs: [wLat, wLng] };
    }
  } catch {}
  return null;
}

function unesc(s) {
  if (!s) return '';
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\t/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function pickUrlFromText(s) { const m = (s || '').match(/https?:\/\/[^\s"'<>]+/i); return m ? m[0].replace(/[），。、；;】)]+$/, '').trim() : ''; }
async function parseLink(rawUrl) {
  let target = pickUrlFromText(rawUrl) || (rawUrl || '').trim();
  if (!target) return { error: '请先粘贴笔记链接' };
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let html;
  try {
    const resp = await fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    html = await resp.text();
  } catch (e) {
    return { error: '链接打不开：' + e.message };
  }
  const metaOf = (key) => {
    const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + key + '["\'][^>]+content=["\']([^"\']*)["\']', 'i'))
           || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + key + '["\']', 'i'));
    return m ? unesc(m[1]) : '';
  };
  let title = '', desc = '';
  const tm = html.match(/"title":"((?:[^"\\]|\\.)*)"/);
  const dm = html.match(/"desc":"((?:[^"\\]|\\.)*)"/);
  if (tm) title = unesc(tm[1]);
  if (dm) desc = unesc(dm[1]);
  if (!title) { const tt = html.match(/<title[^>]*>([^<]+)<\/title>/i); title = (tt ? tt[1] : '') || metaOf('og:title'); }
  if (!desc) desc = metaOf('og:description') || metaOf('description');
  title = (title || '').replace(/\s*[—\-]\s*小红书.*$/i, '').trim();
  desc = (desc || '').trim();
  const text = [title, desc].filter(Boolean).join('\n').trim();
  if (!text) return { error: '没解析到正文：小红书常需要登录，可能被拦截。请手动复制粘贴笔记内容。' };
  let host = ''; try { host = new URL(target).hostname; } catch {}
  return { title, text, source: host };
}

const SYSTEM_PROMPT = '你是地点抽取器。从旅行笔记中完成两件事：\n' +
  '1. 判断笔记主要涉及的城市或国家/地区，作为 region（如「杭州」「巴黎」「日本关西」）。\n' +
  '2. 抽取文中所有「具体地点」，作为 places。\n\n' +
  '抽取规则（务必遵守）：\n' +
  '- 只抽取可在地图上定位的地点：景点、餐厅店名、酒店名、商铺名、车站、街区、商圈等。\n' +
  '- 必须是「具体地名或完整店名」，例如「卢浮宫」「刘姥姥蟹黄包(南京东路店)」「满觉陇」。\n' +
  '- 菜名、品类、物品、活动一律不抽取：「蟹黄包」「奶茶」「火锅」「樱花」等都不是地点，除非以完整店名出现（如「刘姥姥蟹黄包」）。\n' +
  '- 景点用通用官方名；店铺尽量保留品牌+店名全称。\n' +
  '- 若用户提供「笔记自带定位」，作为 places 第一个元素，type 为「自带定位」。\n' +
  '- 不要编造文中不存在的地点，不要输出泛化词。\n\n' +
  '只返回一个 JSON 对象：{"region":"...","places":[{"name":"地点名","type":"景点|餐饮|住宿|交通|商圈|其他"}]}';

async function extractPlaces(text, geo, env) {
  const base = (env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const key = env.LLM_API_KEY || '';
  if (!key || !base) return { ...DEMO, demo: true };
  const model = env.LLM_MODEL || DEFAULT_MODEL;
  const user = '笔记自带定位：' + (geo || '无') + '\n\n笔记正文：\n' + text;
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`LLM HTTP ${r.status}: ${t.slice(0, 120)}`); }
  const d = await r.json();
  let raw = (d.choices && d.choices[0] && d.choices[0].message.content) || '';
  raw = raw.replace(/```json|```/g, '').trim();
  const obj = JSON.parse(raw);
  if (Array.isArray(obj)) return { region: '', places: obj, demo: false };
  const region = (obj.region || '').toString().trim();
  const places = Array.isArray(obj.places) ? obj.places : [];
  return { region, places, demo: false };
}

function json(obj, status = 200) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
    const origin = request.headers.get('Origin');
    if (!originAllowed(origin, env)) return json({ error: 'forbidden origin' }, 403);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) return json({ error: '请求过于频繁，请稍后再试' }, 429);
    try {
      if (p === '/api/config') return json({ llm: !!env.LLM_API_KEY, amap: !!env.AMAP_KEY, model: env.LLM_MODEL || DEFAULT_MODEL });
      if (p === '/api/extract' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const out = await extractPlaces((b.text || '').trim(), (b.geo || '').trim(), env);
        const amapKey = env.AMAP_KEY || '';
        const enriched = await Promise.all(out.places.map(async (pl) => {
          const c = await geocode(pl.name, amapKey);
          return c ? { ...pl, lng: c.lng, lat: c.lat, wgs: c.wgs } : pl;
        }));
        return json({ region: out.region, places: enriched, demo: !!out.demo });
      }
      if (p === '/api/parse-link' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const out = await parseLink(b.url || '');
        return json(out, out.error ? 422 : 200);
      }
      if (p === '/api/geocode' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const names = Array.isArray(b.names) ? b.names : [];
        const amapKey = env.AMAP_KEY || '';
        const out = [];
        for (const n of names) out.push({ name: n, coord: await geocode(n, amapKey) });
        return json({ results: out });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message || 'server error' }, 500);
    }
  }
};
