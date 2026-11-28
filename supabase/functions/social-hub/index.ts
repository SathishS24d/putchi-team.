import { createClient } from "jsr:@supabase/supabase-js@2";
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// deno-lint-ignore-file no-explicit-any
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const G = "https://graph.facebook.com/v25.0";
const TH = "https://graph.threads.net/v1.0";
const LI_VER = "202510";
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const istDay = (off = 0) => new Date(Date.now() + 5.5 * 3600e3 - off * 864e5).toISOString().slice(0, 10);
const MANUAL = ["x", "pinterest", "whatsapp", "sharechat", "moj", "snapchat", "other"];

async function secret(k: string) { const { data } = await admin.from("app_secrets").select("value").eq("key", k).maybeSingle(); return data?.value as string | undefined; }
async function setting(k: string, d = "") { const { data } = await admin.from("app_settings").select("value").eq("key", k).maybeSingle(); return (data?.value as string | undefined) ?? d; }

// ---------- errors ----------
function friendlyMeta(m: string) {
  if (/API access deactivated|developer registration/i.test(m)) return "META_DEV: Meta has switched off API access for the Facebook account that owns your Meta app, because its developer registration is not complete. Fix: log in to developers.facebook.com with that account → finish the registration steps it shows (verify phone, accept terms) → then generate a new token and reconnect here. Until then nothing can sync or post to Instagram/Facebook automatically.";
  if (/Session has expired|Error validating access token|expired/i.test(m)) return "TOKEN_EXPIRED: The Meta token has expired. Reconnect with a new long-lived or System User token.";
  if (/permission|\(#10\)|\(#200\)/i.test(m)) return "PERMISSION: The token is missing a permission. It needs: instagram_basic, instagram_content_publish, instagram_manage_insights, pages_show_list, pages_read_engagement, pages_manage_posts, business_management. (" + m.slice(0, 160) + ")";
  return m;
}
async function fj(url: string, init?: RequestInit, kind = "meta") {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  const t = await r.text(); let d: any = {}; try { d = JSON.parse(t); } catch (_) { d = { raw: t }; }
  if (!r.ok || d?.error) {
    const e = d?.error; const msg = typeof e === "string" ? e : (e?.error_user_msg || e?.message || d?.message || d?.error_description || `Request failed (${r.status})`);
    const err: any = new Error(kind === "meta" ? friendlyMeta(String(msg)) : String(msg)); err.code = e?.code; err.sub = e?.error_subcode; err.status = r.status; throw err;
  }
  return d;
}
const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString();
const gget = (path: string, p: Record<string, unknown>, tok: string) => fj(`${G}/${path}?${qs({ ...p, access_token: tok })}`);
const gpost = (path: string, p: Record<string, unknown>, tok: string) => fj(`${G}/${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: qs({ ...p, access_token: tok }) });

// ---------- tokens ----------
async function tokenOf(acc: any): Promise<any> {
  const { data } = await admin.from("social_tokens").select("data").eq("account_id", acc.id).maybeSingle();
  if (data?.data) return data.data;
  const { data: s } = await admin.from("social_secrets").select("secret").eq("account_id", acc.id).maybeSingle();
  if (s?.secret) return acc.platform === "youtube" ? { api_key: s.secret } : { token: s.secret };
  return null;
}
async function saveToken(id: number, data: any) { await admin.from("social_tokens").upsert({ account_id: id, data, updated_at: now() }); }

// ---------- META discovery / connect ----------
async function metaDiscover(token: string) {
  const out: any = { pages: [], perms: [], warnings: [] };
  let me: any;
  try { me = await gget("me", { fields: "id,name" }, token); } catch (e) { throw e; }
  out.user = me;
  try { const p = await gget("me/permissions", {}, token); out.perms = (p.data || []).filter((x: any) => x.status === "granted").map((x: any) => x.permission); } catch (_) { /* page token */ }
  const igf = "instagram_business_account{id,username,name,followers_count,profile_picture_url}";
  try {
    const a = await gget("me/accounts", { fields: `id,name,access_token,followers_count,fan_count,picture{url},${igf}`, limit: 100 }, token);
    out.pages = a.data || [];
  } catch (_) {
    try { const p = await gget("me", { fields: `id,name,followers_count,fan_count,picture{url},${igf}` }, token); p.access_token = token; out.pages = [p]; } catch (e2) { out.warnings.push(String((e2 as Error).message)); }
  }
  const need = ["instagram_basic", "instagram_content_publish", "instagram_manage_insights", "pages_show_list", "pages_read_engagement", "pages_manage_posts"];
  if (out.perms.length) out.missing = need.filter((x) => !out.perms.includes(x));
  return out;
}
async function upsertAccount(platform: string, ext: string, row: any) {
  const { data: ex } = await admin.from("social_accounts").select("id").eq("platform", platform).eq("external_id", ext).maybeSingle();
  if (ex) { await admin.from("social_accounts").update(row).eq("id", ex.id); return ex.id as number; }
  const { data, error } = await admin.from("social_accounts").insert({ platform, external_id: ext, ...row }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as number;
}
async function metaConnect(token: string, pick: { type: string; id: string }[]) {
  const d = await metaDiscover(token); const ids: number[] = [];
  for (const p of d.pages) {
    const ptok = p.access_token || token;
    if (pick.find((x) => x.type === "facebook" && x.id === p.id)) {
      const id = await upsertAccount("facebook", p.id, { name: p.name, followers: p.followers_count ?? p.fan_count ?? null, avatar: p.picture?.data?.url || null, auto_sync: false, can_publish: true, status: "ok", error: null });
      await saveToken(id, { token: ptok, page_id: p.id, user_token: token }); ids.push(id);
    }
    const ig = p.instagram_business_account;
    if (ig && pick.find((x) => x.type === "instagram" && x.id === ig.id)) {
      const id = await upsertAccount("instagram", ig.id, { name: ig.name || ig.username, handle: ig.username, followers: ig.followers_count ?? null, avatar: ig.profile_picture_url || null, auto_sync: true, can_publish: true, status: "ok", error: null });
      await saveToken(id, { token: ptok, page_id: p.id, user_token: token });
      await admin.from("social_secrets").upsert({ account_id: id, secret: ptok }); // keeps older app versions able to sync
      ids.push(id);
    }
  }
  return ids;
}

// ---------- SYNC ----------
type SyncOut = { followers: number | null; name?: string; handle?: string; avatar?: string; posts: any[]; daily?: any[]; meta?: any; warnings: string[] };

async function igMediaInsights(id: string, product: string, tok: string) {
  const sets = product === "REELS"
    ? [["reach", "views", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time", "reels_skip_rate"], ["reach", "views", "likes", "comments", "shares", "saved", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"], ["reach", "shares", "saved"]]
    : [["reach", "views", "likes", "comments", "shares", "saved", "total_interactions", "follows", "profile_visits"], ["reach", "views", "shares", "saved"], ["reach", "saved"]];
  for (const s of sets) {
    try { const r = await gget(`${id}/insights`, { metric: s.join(",") }, tok); const o: any = {}; for (const m of r.data || []) o[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? null; return o; } catch (_) { /* try smaller */ }
  }
  return {};
}
async function syncInstagram(acc: any, t: any): Promise<SyncOut> {
  const tok = t.token, id = acc.external_id; const w: string[] = [];
  const me = await gget(id, { fields: "username,name,followers_count,follows_count,media_count,profile_picture_url,biography,website" }, tok);
  let media: any[] = []; let url: string | null = `${G}/${id}/media?${qs({ fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url", limit: 50, access_token: tok })}`;
  for (let i = 0; i < 2 && url; i++) { const r = await fj(url); media = media.concat(r.data || []); url = r.paging?.next || null; }
  const posts = media.map((x) => ({ post_id: x.id, url: x.permalink, title: (x.caption || x.media_product_type || "Post").split("\n")[0].slice(0, 140), caption: (x.caption || "").slice(0, 2200), posted_at: x.timestamp, media_type: x.media_type, product_type: x.media_product_type, likes: x.like_count || 0, comments: x.comments_count || 0, thumb: x.thumbnail_url || (x.media_type === "IMAGE" ? x.media_url : null) || null } as any));
  const recent = posts.slice(0, 45);
  for (let i = 0; i < recent.length; i += 8) {
    await Promise.all(recent.slice(i, i + 8).map(async (p) => {
      const m = await igMediaInsights(p.post_id, p.product_type, tok);
      if (m.reach != null) p.reach = m.reach; if (m.views != null) p.views = m.views; if (m.shares != null) p.shares = m.shares; if (m.saved != null) p.saves = m.saved;
      if (m.likes != null) p.likes = m.likes; if (m.comments != null) p.comments = m.comments;
      if (m.ig_reels_avg_watch_time != null) p.avg_watch_ms = Math.round(m.ig_reels_avg_watch_time); if (m.ig_reels_video_view_total_time != null) p.total_watch_ms = Math.round(m.ig_reels_video_view_total_time);
      if (m.reels_skip_rate != null) p.skip_rate = Number(m.reels_skip_rate); if (m.follows != null) p.follows = m.follows; if (m.profile_visits != null) p.profile_visits = m.profile_visits;
    }));
  }
  const daily: any[] = []; const meta: any = { bio: me.biography || "", website: me.website || "", media_count: me.media_count, follows_count: me.follows_count };
  try {
    const since = Math.floor(Date.now() / 1000) - 28 * 86400, until = Math.floor(Date.now() / 1000);
    const r = await gget(`${id}/insights`, { metric: "reach", period: "day", since, until }, tok);
    for (const v of r.data?.[0]?.values || []) daily.push({ day: String(v.end_time).slice(0, 10), reach: v.value });
  } catch (e) { w.push("reach: " + (e as Error).message.slice(0, 80)); }
  for (const off of [1, 0]) {
    const d0 = new Date(istDay(off) + "T00:00:00+05:30"); const s = Math.floor(d0.getTime() / 1000), u = s + 86400;
    try {
      const r = await gget(`${id}/insights`, { metric: "views,profile_views,website_clicks,accounts_engaged,total_interactions", period: "day", metric_type: "total_value", since: s, until: u }, tok);
      const row: any = { day: istDay(off) }; for (const m of r.data || []) { const v = m.total_value?.value ?? null; if (m.name === "views") row.views = v; if (m.name === "profile_views") row.profile_views = v; if (m.name === "website_clicks") row.website_clicks = v; if (m.name === "accounts_engaged") row.engaged = v; if (m.name === "total_interactions") row.interactions = v; }
      try { const f = await gget(`${id}/insights`, { metric: "follows_and_unfollows", period: "day", metric_type: "total_value", breakdown: "follow_type", since: s, until: u }, tok); for (const b of f.data?.[0]?.total_value?.breakdowns?.[0]?.results || []) { if (b.dimension_values?.[0] === "FOLLOWER") row.follows = b.value; if (b.dimension_values?.[0] === "NON_FOLLOWER") row.unfollows = b.value; } } catch (_) { /* */ }
      const ex = daily.find((x) => x.day === row.day); if (ex) Object.assign(ex, row); else daily.push(row);
    } catch (e) { if (off === 1) w.push("daily: " + (e as Error).message.slice(0, 80)); }
  }
  try { const r = await gget(`${id}/insights`, { metric: "online_followers", period: "lifetime" }, tok); const v = r.data?.[0]?.values; if (v?.length) meta.online = v[v.length - 1].value; } catch (_) { /* <100 followers */ }
  meta.demo = {};
  for (const b of ["age", "gender", "city"]) {
    try { const r = await gget(`${id}/insights`, { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", timeframe: "this_month", breakdown: b }, tok); meta.demo[b] = (r.data?.[0]?.total_value?.breakdowns?.[0]?.results || []).map((x: any) => [x.dimension_values?.[0], x.value]).sort((a: any, c: any) => c[1] - a[1]).slice(0, 12); } catch (_) { /* */ }
  }
  try { const r = await gget(`${id}/content_publishing_limit`, { fields: "quota_usage,config" }, tok); meta.publish_quota = r.data?.[0] || null; } catch (_) { /* */ }
  return { followers: me.followers_count ?? null, name: me.name || me.username, handle: me.username, avatar: me.profile_picture_url, posts, daily, meta, warnings: w };
}
async function syncFacebook(acc: any, t: any): Promise<SyncOut> {
  const tok = t.token, id = acc.external_id; const w: string[] = [];
  const pg = await gget(id, { fields: "name,followers_count,fan_count,picture{url},about" }, tok);
  const r = await gget(`${id}/posts`, { fields: "id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)", limit: 40 }, tok);
  const posts = (r.data || []).map((x: any) => ({ post_id: x.id, url: x.permalink_url, title: (x.message || "Post").split("\n")[0].slice(0, 140), caption: (x.message || "").slice(0, 2200), posted_at: x.created_time, likes: x.reactions?.summary?.total_count || 0, comments: x.comments?.summary?.total_count || 0, shares: x.shares?.count || 0, thumb: x.full_picture || null, media_type: "POST" }));
  return { followers: pg.followers_count ?? pg.fan_count ?? null, name: pg.name, avatar: pg.picture?.data?.url, posts, meta: { about: pg.about || "" }, warnings: w };
}
async function googleAccess(t: any) {
  if (!t.refresh_token || !t.client_id || !t.client_secret) return null;
  const r = await fj("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: qs({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: "refresh_token" }) }, "google");
  return r.access_token as string;
}
async function syncYouTube(acc: any, t: any): Promise<SyncOut> {
  const w: string[] = []; const key = t.api_key; const at = await googleAccess(t).catch((e) => { w.push("oauth: " + e.message); return null; });
  const ext = String(acc.external_id || "").trim();
  const auth = at ? { headers: { Authorization: "Bearer " + at } } : undefined;
  const sel = at && !ext ? "mine=true" : ext.startsWith("@") ? `forHandle=${encodeURIComponent(ext)}` : `id=${encodeURIComponent(ext)}`;
  const k = key ? `&key=${key}` : "";
  const c = await fj(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&${sel}${k}`, auth, "google");
  const ch = c.items?.[0]; if (!ch) throw new Error("Channel not found. Check the handle or ID");
  const up = ch.contentDetails.relatedPlaylists.uploads;
  const pl = await fj(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${up}${k}`, auth, "google");
  const ids = (pl.items || []).map((i: any) => i.contentDetails.videoId).join(",");
  const v = ids ? await fj(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids}${k}`, auth, "google") : { items: [] };
  const posts = (v.items || []).map((x: any) => ({ post_id: x.id, url: `https://www.youtube.com/watch?v=${x.id}`, title: x.snippet.title, caption: (x.snippet.description || "").slice(0, 2200), posted_at: x.snippet.publishedAt, views: +x.statistics.viewCount || 0, likes: +x.statistics.likeCount || 0, comments: +x.statistics.commentCount || 0, thumb: x.snippet.thumbnails?.medium?.url || null, media_type: "VIDEO" } as any));
  if (at) {
    try {
      const a = await fj(`https://youtubeanalytics.googleapis.com/v2/reports?${qs({ ids: "channel==MINE", startDate: istDay(120), endDate: istDay(0), metrics: "views,averageViewDuration,averageViewPercentage,subscribersGained,shares", dimensions: "video", sort: "-views", maxResults: 50 })}`, auth, "google");
      for (const row of a.rows || []) { const p = posts.find((x: any) => x.post_id === row[0]); if (p) { p.avg_watch_ms = Math.round(row[2] * 1000); p.follows = row[4]; p.shares = row[5]; p.retention_pct = row[3]; } }
    } catch (e) { w.push("analytics: " + (e as Error).message.slice(0, 80)); }
  }
  return { followers: +ch.statistics.subscriberCount || 0, name: ch.snippet.title, avatar: ch.snippet.thumbnails?.default?.url, handle: ch.snippet.customUrl, posts, warnings: w };
}
async function syncThreads(acc: any, t: any): Promise<SyncOut> {
  const tok = t.token; const w: string[] = [];
  const me = await fj(`${TH}/me?${qs({ fields: "id,username,threads_profile_picture_url", access_token: tok })}`);
  let followers: number | null = null;
  try { const f = await fj(`${TH}/${me.id}/threads_insights?${qs({ metric: "followers_count", access_token: tok })}`); followers = f.data?.[0]?.total_value?.value ?? null; } catch (e) { w.push((e as Error).message.slice(0, 80)); }
  const r = await fj(`${TH}/${me.id}/threads?${qs({ fields: "id,text,timestamp,permalink,media_type,thumbnail_url", limit: 30, access_token: tok })}`);
  const posts = (r.data || []).map((x: any) => ({ post_id: x.id, url: x.permalink, title: (x.text || "Thread").split("\n")[0].slice(0, 140), caption: x.text || "", posted_at: x.timestamp, media_type: x.media_type, thumb: x.thumbnail_url || null } as any));
  await Promise.all(posts.slice(0, 20).map(async (p: any) => { try { const m = await fj(`${TH}/${p.post_id}/insights?${qs({ metric: "views,likes,replies,reposts,quotes,shares", access_token: tok })}`); for (const x of m.data || []) { const v = x.values?.[0]?.value ?? x.total_value?.value ?? 0; if (x.name === "views") p.views = v; if (x.name === "likes") p.likes = v; if (x.name === "replies") p.comments = v; if (x.name === "shares" || x.name === "reposts") p.shares = (p.shares || 0) + v; } } catch (_) { /* */ } }));
  await saveToken(acc.id, { ...t, user_id: me.id });
  return { followers, name: me.username, handle: me.username, avatar: me.threads_profile_picture_url, posts, warnings: w };
}
async function liFetch(path: string, tok: string, init?: RequestInit) {
  return fj(`https://api.linkedin.com/rest/${path}`, { ...init, headers: { Authorization: "Bearer " + tok, "LinkedIn-Version": LI_VER, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json", ...(init?.headers || {}) } }, "linkedin");
}
async function syncLinkedIn(acc: any, t: any): Promise<SyncOut> {
  const org = acc.external_id; const w: string[] = []; let followers: number | null = null;
  try { const n = await liFetch(`networkSizes/${encodeURIComponent("urn:li:organization:" + org)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, t.token); followers = n.firstDegreeSize ?? null; } catch (e) { w.push((e as Error).message.slice(0, 100)); }
  let posts: any[] = [];
  try { const p = await liFetch(`posts?author=${encodeURIComponent("urn:li:organization:" + org)}&q=author&count=30`, t.token); posts = (p.elements || []).map((x: any) => ({ post_id: x.id, url: `https://www.linkedin.com/feed/update/${x.id}`, title: String(x.commentary || "Post").split("\n")[0].slice(0, 140), caption: x.commentary || "", posted_at: new Date(x.publishedAt || x.createdAt || Date.now()).toISOString(), media_type: "POST" })); } catch (e) { w.push((e as Error).message.slice(0, 100)); }
  return { followers, posts, warnings: w };
}
async function syncOne(acc: any) {
  const t = await tokenOf(acc);
  if (!t) return { id: acc.id, ok: true, skipped: true };
  try {
    const fn = acc.platform === "instagram" ? syncInstagram : acc.platform === "facebook" ? syncFacebook : acc.platform === "youtube" ? syncYouTube : acc.platform === "threads" ? syncThreads : acc.platform === "linkedin" ? syncLinkedIn : null;
    if (!fn) return { id: acc.id, ok: true, skipped: true };
    const r = await fn(acc, t);
    if (r.posts.length) {
      const rows = r.posts.map((p) => { const o: any = { account_id: acc.id, updated_at: now() }; for (const k of ["post_id", "url", "title", "caption", "posted_at", "views", "likes", "comments", "shares", "reach", "thumb", "media_type", "product_type", "saves", "skip_rate", "avg_watch_ms", "total_watch_ms", "follows", "profile_visits"]) if (p[k] !== undefined) o[k] = p[k]; return o; });
      for (let i = 0; i < rows.length; i += 200) { const { error } = await admin.from("social_posts").upsert(rows.slice(i, i + 200), { onConflict: "account_id,post_id" }); if (error) r.warnings.push(error.message); }
    }
    if (r.daily?.length) await admin.from("social_daily").upsert(r.daily.map((d) => ({ account_id: acc.id, ...d })), { onConflict: "account_id,day" });
    if (r.followers != null) await admin.from("social_followers").upsert({ account_id: acc.id, day: istDay(0), followers: r.followers }, { onConflict: "account_id,day" });
    const upd: any = { last_sync: now(), status: "ok", error: r.warnings.length ? r.warnings.slice(0, 3).join(" | ").slice(0, 300) : null };
    if (r.followers != null) upd.followers = r.followers; if (r.handle) upd.handle = r.handle; if (r.avatar) upd.avatar = r.avatar;
    if (r.meta) upd.meta = { ...(acc.meta || {}), ...r.meta };
    await admin.from("social_accounts").update(upd).eq("id", acc.id);
    return { id: acc.id, ok: true, posts: r.posts.length, warnings: r.warnings };
  } catch (e) {
    const msg = String((e as Error).message || e);
    await admin.from("social_accounts").update({ status: "error", error: msg.slice(0, 500), last_sync: now() }).eq("id", acc.id);
    return { id: acc.id, ok: false, error: msg };
  }
}
async function syncAll(only?: number) {
  let q = admin.from("social_accounts").select("*"); if (only) q = q.eq("id", only);
  const { data } = await q; const res = [];
  for (const a of data || []) res.push(await syncOne(a));
  return res;
}

// ---------- PUBLISHING ----------
async function notifySocial(title: string, body: string, ref: string, only?: string | null) {
  const { data: ppl } = await admin.from("profiles").select("id,role,modules,active");
  const ids = (ppl || []).filter((p: any) => p.active && (only ? p.id === only : (p.role === "founder" || (p.modules || []).includes("social")))).map((p: any) => p.id);
  if (ids.length) await admin.from("notifications").insert(ids.map((u: string) => ({ user_id: u, title, body: body.slice(0, 400), kind: "social", ref })));
}
const isVid = (m: any) => m?.type === "video" || /\.(mp4|mov|m4v|webm)(\?|$)/i.test(m?.url || "");

async function igStep(item: any, acc: any, t: any, r: any) {
  const tok = t.token, ig = acc.external_id; const media = item.media || [];
  const cap = [item.caption || ""].join("");
  if (r.state === "pending") {
    if (item.kind === "text") return { state: "error", error: "Instagram needs a photo or video" };
    if (!media.length) return { state: "error", error: "No media attached" };
    if (item.kind === "carousel") {
      const kids: string[] = [];
      for (const m of media.slice(0, 10)) { const c = await gpost(`${ig}/media`, isVid(m) ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: "true" } : { image_url: m.url, is_carousel_item: "true" }, tok); kids.push(c.id); }
      return { state: "children", children: kids };
    }
    const p: any = { caption: item.kind === "story" ? undefined : cap };
    if (item.kind === "story") { p.media_type = "STORIES"; if (isVid(media[0])) p.video_url = media[0].url; else p.image_url = media[0].url; }
    else if (item.kind === "reel" || item.kind === "video" || isVid(media[0])) { p.media_type = "REELS"; p.video_url = media[0].url; p.share_to_feed = "true"; if (item.cover_url) p.cover_url = item.cover_url; if (item.trial) p.trial_params = { graduation_strategy: "SS_PERFORMANCE" }; }
    else p.image_url = media[0].url;
    const c = await gpost(`${ig}/media`, p, tok);
    return { state: "processing", container: c.id, tries: 0 };
  }
  if (r.state === "children") {
    for (const k of r.children) { const s = await gget(k, { fields: "status_code,status" }, tok); if (s.status_code === "ERROR") return { state: "error", error: "Carousel item failed: " + (s.status || "") }; if (s.status_code !== "FINISHED") return { ...r, tries: (r.tries || 0) + 1 }; }
    const c = await gpost(`${ig}/media`, { media_type: "CAROUSEL", children: r.children.join(","), caption: cap }, tok);
    return { state: "processing", container: c.id, tries: 0 };
  }
  if (r.state === "processing") {
    const s = await gget(r.container, { fields: "status_code,status" }, tok);
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") return { state: "error", error: "Instagram could not process the media: " + (s.status || s.status_code) + ". Check the video is MP4 (H.264/AAC), 9:16, 3s–3min." };
    if (s.status_code !== "FINISHED") { if ((r.tries || 0) > 36) return { state: "error", error: "Instagram took too long to process the video" }; return { ...r, tries: (r.tries || 0) + 1 }; }
    const pub = await gpost(`${ig}/media_publish`, { creation_id: r.container }, tok);
    let url = ""; try { url = (await gget(pub.id, { fields: "permalink" }, tok)).permalink; } catch (_) { /* */ }
    if (item.first_comment) { try { await gpost(`${pub.id}/comments`, { message: item.first_comment }, tok); } catch (_) { /* */ } }
    return { state: "done", post_id: pub.id, url };
  }
  return r;
}
async function fbStep(item: any, acc: any, t: any, r: any) {
  const tok = t.token, pg = acc.external_id, media = item.media || [];
  if (r.state !== "pending") return r;
  if (item.kind === "story") return { state: "manual", note: "Facebook stories must be posted from the app" };
  let res: any;
  if (!media.length || item.kind === "text") res = await gpost(`${pg}/feed`, { message: item.caption || "" }, tok);
  else if (item.kind === "carousel" && media.length > 1) {
    const ids: string[] = [];
    for (const m of media.filter((x: any) => !isVid(x)).slice(0, 10)) { const ph = await gpost(`${pg}/photos`, { url: m.url, published: "false" }, tok); ids.push(ph.id); }
    const p: any = { message: item.caption || "" }; ids.forEach((id, i) => p[`attached_media[${i}]`] = { media_fbid: id });
    res = await gpost(`${pg}/feed`, p, tok);
  } else if (isVid(media[0])) res = await gpost(`${pg}/videos`, { file_url: media[0].url, description: item.caption || "", title: (item.title || "").slice(0, 100) || undefined }, tok);
  else res = await gpost(`${pg}/photos`, { url: media[0].url, caption: item.caption || "" }, tok);
  const pid = res.post_id || res.id;
  return { state: "done", post_id: pid, url: `https://www.facebook.com/${pid}` };
}
async function ytStep(item: any, acc: any, t: any, r: any) {
  if (r.state !== "pending") return r;
  const media = item.media || []; if (!media.length || !isVid(media[0])) return { state: "skip", note: "YouTube only takes videos" };
  const at = await googleAccess(t); if (!at) return { state: "manual", note: "Add YouTube upload access (OAuth) in Accounts to auto-post" };
  const vr = await fetch(media[0].url); if (!vr.ok) throw new Error("Could not read the video file");
  const buf = new Uint8Array(await vr.arrayBuffer()); if (buf.length > 250 * 1024 * 1024) return { state: "manual", note: "Video is over 250 MB — upload from YouTube Studio" };
  const lines = String(item.caption || "").split("\n");
  const title = String(item.title || lines[0] || "New video").replace(/#\w+/g, "").trim().slice(0, 95) || "New video";
  const desc = (item.caption || "") + (/#shorts/i.test(item.caption || "") ? "" : "\n\n#Shorts");
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { Authorization: "Bearer " + at, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/*", "X-Upload-Content-Length": String(buf.length) }, body: JSON.stringify({ snippet: { title, description: desc.slice(0, 4900), categoryId: "26" }, status: { privacyStatus: "public", selfDeclaredMadeForKids: false } }) });
  if (!init.ok) throw new Error("YouTube: " + (await init.text()).slice(0, 200));
  const loc = init.headers.get("Location"); if (!loc) throw new Error("YouTube did not return an upload address");
  const up = await fetch(loc, { method: "PUT", headers: { "Content-Type": "video/*", "Content-Length": String(buf.length) }, body: buf });
  const j = await up.json().catch(() => ({})); if (!up.ok || !j.id) throw new Error("YouTube upload failed: " + JSON.stringify(j).slice(0, 200));
  return { state: "done", post_id: j.id, url: `https://www.youtube.com/shorts/${j.id}`, note: j.status?.privacyStatus === "private" ? "Uploaded as PRIVATE: your Google Cloud project is unverified, so YouTube keeps API uploads private until it is verified." : undefined };
}
async function thStep(item: any, acc: any, t: any, r: any) {
  const tok = t.token, uid = t.user_id || "me", media = item.media || [];
  const text = String(item.caption || "").slice(0, 500);
  if (r.state === "pending") {
    let p: any;
    if (!media.length || item.kind === "text") p = { media_type: "TEXT", text };
    else if (item.kind === "carousel" && media.length > 1) {
      const kids: string[] = [];
      for (const m of media.slice(0, 20)) { const c = await fj(`${TH}/${uid}/threads`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: qs(isVid(m) ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: "true", access_token: tok } : { media_type: "IMAGE", image_url: m.url, is_carousel_item: "true", access_token: tok }) }); kids.push(c.id); }
      await sleep(8000);
      p = { media_type: "CAROUSEL", children: kids.join(","), text };
    } else p = isVid(media[0]) ? { media_type: "VIDEO", video_url: media[0].url, text } : { media_type: "IMAGE", image_url: media[0].url, text };
    const c = await fj(`${TH}/${uid}/threads`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: qs({ ...p, access_token: tok }) });
    return { state: "processing", container: c.id, tries: 0 };
  }
  if (r.state === "processing") {
    const s = await fj(`${TH}/${r.container}?${qs({ fields: "status,error_message", access_token: tok })}`);
    if (s.status === "ERROR") return { state: "error", error: s.error_message || "Threads could not process the media" };
    if (s.status && s.status !== "FINISHED") return { ...r, tries: (r.tries || 0) + 1 };
    const pub = await fj(`${TH}/${uid}/threads_publish`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: qs({ creation_id: r.container, access_token: tok }) });
    let url = ""; try { url = (await fj(`${TH}/${pub.id}?${qs({ fields: "permalink", access_token: tok })}`)).permalink; } catch (_) { /* */ }
    return { state: "done", post_id: pub.id, url };
  }
  return r;
}
async function liStep(item: any, acc: any, t: any, r: any) {
  if (r.state !== "pending") return r;
  const body = { author: "urn:li:organization:" + acc.external_id, commentary: String(item.caption || "").slice(0, 2900), visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false };
  const res = await fetch("https://api.linkedin.com/rest/posts", { method: "POST", headers: { Authorization: "Bearer " + t.token, "LinkedIn-Version": LI_VER, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("LinkedIn: " + (await res.text()).slice(0, 200));
  const id = res.headers.get("x-restli-id") || "";
  return { state: "done", post_id: id, url: id ? `https://www.linkedin.com/feed/update/${id}` : "", note: (item.media || []).length ? "Posted as text only — attach the media on LinkedIn if needed" : undefined };
}
async function processItem(id: number) {
  const until = new Date(Date.now() + 110000).toISOString();
  const { data: locked } = await admin.from("social_queue").update({ locked_until: until }).eq("id", id).or(`locked_until.is.null,locked_until.lt.${now()}`).select("*").maybeSingle();
  if (!locked) return { id, busy: true };
  const item = locked; const results = { ...(item.results || {}) };
  if (item.status === "scheduled") await admin.from("social_queue").update({ status: "publishing" }).eq("id", id);
  const { data: accs } = await admin.from("social_accounts").select("*").in("id", item.account_ids || []);
  const manualNotes: string[] = [];
  for (const acc of accs || []) {
    let r = results[acc.id] || { state: "pending" };
    if (["done", "error", "manual", "skip"].includes(r.state)) continue;
    try {
      const t = await tokenOf(acc);
      if (MANUAL.includes(acc.platform) || !t || !acc.can_publish) r = { state: "manual", note: "Post manually" };
      else if (acc.platform === "instagram") r = await igStep(item, acc, t, r);
      else if (acc.platform === "facebook") r = await fbStep(item, acc, t, r);
      else if (acc.platform === "youtube") r = await ytStep(item, acc, t, r);
      else if (acc.platform === "threads") r = await thStep(item, acc, t, r);
      else if (acc.platform === "linkedin") r = await liStep(item, acc, t, r);
      else r = { state: "manual", note: "Post manually" };
    } catch (e) { r = { state: "error", error: String((e as Error).message).slice(0, 400) }; }
    if (r.state === "manual") manualNotes.push(acc.name + " (" + acc.platform + ")");
    results[acc.id] = { ...r, at: now() };
  }
  const st = Object.values(results).map((x: any) => x.state);
  const busy = st.some((s) => ["pending", "processing", "children"].includes(s));
  const okN = st.filter((s) => ["done", "manual", "skip"].includes(s)).length, errN = st.filter((s) => s === "error").length;
  const status = busy ? "publishing" : errN === 0 ? "published" : okN > 0 ? "partial" : "failed";
  const upd: any = { results, status, locked_until: null, updated_at: now() };
  if (!busy) upd.published_at = now();
  if (!busy && errN) upd.error = Object.values(results).filter((x: any) => x.state === "error").map((x: any) => x.error).join(" | ").slice(0, 500);
  await admin.from("social_queue").update(upd).eq("id", id);
  if (manualNotes.length) await notifySocial("📲 Post this manually now", `"${(item.title || item.caption || "").slice(0, 60)}" is due on: ${manualNotes.join(", ")}. Open Social → Plan to copy the caption and media.`, "q" + id, item.created_by);
  if (!busy) {
    if (item.reel_id && okN) await admin.from("social_reels").update({ status: "posted", updated_at: now() }).eq("id", item.reel_id);
    if (errN) await notifySocial("⚠️ Post failed", `"${(item.title || item.caption || "").slice(0, 60)}": ${upd.error}`.slice(0, 380), "q" + id, item.created_by);
  }
  return { id, status };
}
async function runDue() {
  const { data } = await admin.from("social_queue").select("id").or(`and(status.eq.scheduled,scheduled_at.lte.${now()}),status.eq.publishing`).order("scheduled_at").limit(15);
  const out = []; for (const x of data || []) out.push(await processItem(x.id));
  return out;
}

// ---------- AI ----------
function toAnthropicSchema(x: any): any { return x; }
async function aiOpenAI(key: string, opts: any) {
  const model = await setting("social_model", await setting("seo_model", "gpt-5-mini"));
  const body: Record<string, unknown> = { model, input: opts.images?.length ? [{ role: "user", content: [{ type: "input_text", text: opts.input }, ...opts.images.map((u: string) => ({ type: "input_image", image_url: u }))] }] : opts.input };
  if (opts.instructions) body.instructions = opts.instructions;
  if (opts.web) body.tools = [{ type: "web_search", user_location: { type: "approximate", country: "IN" } }];
  if (/^(gpt-5|o\d)/.test(model)) body.reasoning = { effort: opts.effort || "low" };
  if (opts.schema) body.text = { format: { type: "json_schema", name: opts.schema.name, schema: opts.schema.schema, strict: true } };
  let last = "";
  for (let a = 0; a < 3; a++) {
    const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify(body), signal: AbortSignal.timeout(230000) });
    const j = await r.json().catch(() => ({}));
    const m = String(j?.error?.message || "") + " " + String(j?.error?.code || "");
    if (/insufficient_quota|billing|credit/i.test(m)) { const e: any = new Error("NO_CREDIT: OpenAI account has no credit. Add billing at platform.openai.com → Settings → Billing."); e.fallback = true; throw e; }
    if (r.status === 429 || r.status >= 500) { last = m || ("OpenAI error " + r.status); await sleep(3000 * (a + 1)); continue; }
    if (!r.ok) { if (r.status === 401) { const e: any = new Error("OpenAI key is not valid."); e.fallback = true; throw e; } throw new Error(j?.error?.message || ("OpenAI error " + r.status)); }
    let text = ""; for (const o of j.output || []) if (o.type === "message") for (const c of o.content || []) if (c.type === "output_text") text += c.text || "";
    return text;
  }
  throw new Error("OpenAI is busy: " + last.slice(0, 160));
}
async function aiClaude(key: string, opts: any) {
  const model = await setting("social_claude_model", "claude-sonnet-5-5");
  const tools: any[] = [];
  if (opts.web) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "IN" } });
  if (opts.schema) tools.push({ name: "submit_" + opts.schema.name, description: "Submit the final answer in the required structure.", input_schema: toAnthropicSchema(opts.schema.schema) });
  const sys = (opts.instructions || "") + (opts.schema ? `\n\nWhen you are done${opts.web ? " researching" : ""}, call the tool submit_${opts.schema.name} exactly once with the complete answer.` : "");
  const ucontent: any = opts.images?.length ? [{ type: "text", text: opts.input }, ...opts.images.map((u: string) => ({ type: "image", source: { type: "url", url: u } }))] : opts.input;
  const body: any = { model, max_tokens: 16000, system: sys, messages: [{ role: "user", content: ucontent }] };
  if (tools.length) body.tools = tools;
  if (opts.schema && !opts.web) body.tool_choice = { type: "tool", name: "submit_" + opts.schema.name };
  let last = "";
  for (let a = 0; a < 3; a++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal: AbortSignal.timeout(280000) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429 || r.status === 529 || r.status >= 500) { last = j?.error?.message || ("Claude error " + r.status); await sleep(4000 * (a + 1)); continue; }
    if (!r.ok) { const m = j?.error?.message || ("Claude error " + r.status); if (/credit|billing/i.test(m)) throw new Error("NO_CREDIT: Claude account has no credit. Add credits at console.anthropic.com → Billing."); if (r.status === 401) throw new Error("Claude key is not valid."); throw new Error(m); }
    if (opts.schema) {
      const tu = (j.content || []).find((c: any) => c.type === "tool_use" && c.name === "submit_" + opts.schema.name);
      if (tu) return JSON.stringify(tu.input);
      if (opts.web && a < 2) { body.messages = [{ role: "user", content: ucontent }, { role: "assistant", content: j.content.filter((c: any) => c.type === "text") .length ? j.content.filter((c: any) => c.type === "text") : [{ type: "text", text: "Research done." }] }, { role: "user", content: "Now submit the final answer with the tool." }]; body.tool_choice = { type: "tool", name: "submit_" + opts.schema.name }; body.tools = tools.filter((t) => t.name !== "web_search"); continue; }
      throw new Error("Claude did not return the structured answer");
    }
    return (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  }
  throw new Error("Claude is busy: " + last.slice(0, 160));
}
async function ai(opts: { input: string; instructions?: string; web?: boolean; schema?: { name: string; schema: unknown }; effort?: string; images?: string[] }): Promise<string> {
  if (opts.images?.length) { try { return await aiCore(opts); } catch (e) { if (/image|url|download|fetch|invalid_request|media/i.test(String((e as Error).message))) return await aiCore({ ...opts, images: [] }); throw e; } }
  return await aiCore(opts);
}
async function aiCore(opts: { input: string; instructions?: string; web?: boolean; schema?: { name: string; schema: unknown }; effort?: string; images?: string[] }) {
  const oa = await secret("openai_key"), an = await secret("anthropic_key");
  const pref = await setting("social_ai", "auto");
  const order = pref === "claude" ? ["claude", "openai"] : ["openai", "claude"];
  let lastErr: any = null;
  for (const eng of order) {
    try {
      if (eng === "openai" && oa) { const t = await aiOpenAI(oa, opts); await admin.from("app_settings").delete().eq("key", "social_ai_error"); return t; }
      if (eng === "claude" && an) { const t = await aiClaude(an, opts); await admin.from("app_settings").delete().eq("key", "social_ai_error"); return t; }
    } catch (e) { lastErr = e; if (!(e as any).fallback && !/NO_CREDIT|not valid/.test(String((e as Error).message))) break; }
  }
  if (!oa && !an) lastErr = new Error("NO_KEY: Add an OpenAI or Claude API key in Social → Accounts → AI engine.");
  const msg = String(lastErr?.message || lastErr || "AI failed");
  if (/NO_CREDIT|NO_KEY|not valid/.test(msg)) await admin.from("app_settings").upsert({ key: "social_ai_error", value: msg.slice(0, 300), updated_at: now() });
  throw new Error(msg.replace(/^(NO_CREDIT|NO_KEY): /, ""));
}
const S = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
const str = { type: "string" }, num = { type: "number" }, arr = (i: unknown) => ({ type: "array", items: i });
const FORMATS = ["Talking-head tip", "Problem → solution demo", "Before/after transformation", "POV / relatable skit", "Myth vs fact", "Day-in-the-life", "Customer story / UGC", "Try-on / styling haul", "Behind the scenes", "Listicle (3 things)", "Reaction / green screen", "Trend remix", "Founder story", "Product deep-dive", "Comparison / test", "Educational carousel", "Q&A reply to comment"];

const PLAYBOOK = `ENGINEERED VIRALITY PLAYBOOK (2026, use these rules):
- Instagram's own head (Mosseri) says the 3 ranking signals that matter most are watch time, likes per reach and sends per reach (DM shares). Sends per reach drives reach to NON-followers most. Design every reel around a reason to SEND it to someone ("send this to a mom who...", relatable truth, useful hack, surprising fact).
- First 1.5 seconds decide the scroll. Instagram reports reels_skip_rate = % who leave in first 3 seconds. Open with movement + a person on screen + spoken words in the first 3 seconds (speech in first 3s measurably lifts retention) + bold on-screen text that states the payoff or tension.
- Structure: Hook (0-2s) → Build/tension → Shift/twist → Payoff near the END (keeps watch time) → loop back to start where possible. Promise the payoff in the hook and deliver it late.
- Cuts every 1.5-3s, burned-in captions (most watch muted), no dead air, vertical 9:16, 7-60s (45-60s performed best in large studies when the content holds; short 7-15s loops for humour). Max 3 minutes.
- ORIGINALITY: Instagram removes reposted/watermarked/unoriginal content from recommendations. Never reuse TikTok-watermarked clips. Remix trends with Putchi's own footage and angle.
- Captions: first 125 characters are the hook + keyword; Instagram now allows max 5 hashtags — use 3-5 specific ones. Keywords in caption and on-screen text help search/discovery.
- Trial Reels: test new or risky formats with non-followers first; graduate winners.
- Engagement: brand average engagement on Instagram is about 0.45-0.5% (2026 benchmarks); judge per-reach rates, not raw counts.
- India: strong evening activity (~7-9:30 PM IST weekdays, Saturday evening); confirm with the account's own online-followers data.
- Repurpose every reel to YouTube Shorts (≤3 min vertical), Facebook Reels and a Threads text post.
- Study OUTLIERS: posts that beat the account's median by 3x+; reverse-engineer hook, pacing, topic and repeat the pattern as a series. Write 10 hook variants, pick the strongest.`;

async function brandCtx() {
  const brief = await setting("social_brief", "");
  let types = "", top = "";
  try { const { data } = await admin.from("shop_products").select("ptype").eq("active", true).limit(3000); types = [...new Set((data || []).map((x: any) => x.ptype).filter(Boolean))].slice(0, 25).join(", "); } catch (_) { /* */ }
  try {
    const { data } = await admin.from("shop_products_daily").select("title,units").gte("day", istDay(30)).limit(5000);
    const m: Record<string, number> = {}; for (const r of data || []) m[r.title] = (m[r.title] || 0) + (r.units || 0);
    top = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, u]) => `${t} (${u} sold)`).join("; ");
  } catch (_) { /* */ }
  let pb = ""; try { const raw = await setting("social_playbook", ""); if (raw) { const j = JSON.parse(raw); pb = `\nLEARNED FROM OUR OWN REELS (follow these, they come from our real data): works: ${(j.what_works || []).join("; ")} | fails: ${(j.what_fails || []).join("; ")} | rules: ${(j.rules || []).join("; ")} | best formats: ${(j.best_formats || []).join("; ")} | best times: ${(j.best_times || []).join("; ")}`; } } catch (_) { /* */ }
  return pb + `\nBRAND: The Putchi — Indian maternity, nursing/feeding, postpartum and baby/kids wear brand with an online store (theputchi.com) and stores in Chennai, Tamil Nadu. Audience: expecting and new mothers in India (mostly 22-38), their families; Tamil + English speaking, South India core, all-India online.
${brief ? "TEAM BRIEF (follow this): " + brief + "\n" : ""}Product types: ${types || "maternity dresses, feeding kurtis, nursing wear, baby clothes"}.
Best sellers last 30 days: ${top || "n/a"}.`;
}
function rate(a: number, b: number) { return b > 0 ? a / b : null; }
function median(xs: number[]) { const s = xs.filter((x) => x != null && !isNaN(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }
async function perfData(days = 90) {
  const { data: accs } = await admin.from("social_accounts").select("*");
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: posts } = await admin.from("social_posts").select("*").gte("posted_at", since).order("posted_at", { ascending: false }).limit(1500);
  const { data: fol } = await admin.from("social_followers").select("*").gte("day", istDay(days)).order("day");
  const { data: daily } = await admin.from("social_daily").select("*").gte("day", istDay(days)).order("day");
  const per: any[] = [];
  for (const a of accs || []) {
    const ps = (posts || []).filter((p: any) => p.account_id === a.id);
    const f = (fol || []).filter((x: any) => x.account_id === a.id);
    const d = (daily || []).filter((x: any) => x.account_id === a.id);
    const views = ps.map((p: any) => p.views || p.reach || 0);
    const med = median(views) || 0;
    const reels = ps.filter((p: any) => p.product_type === "REELS");
    const sumR = (k: string) => ps.reduce((t: number, p: any) => t + (p[k] || 0), 0);
    const reach = sumR("reach");
    const weeks = Math.max(1, days / 7);
    const byWeek: Record<string, number> = {}; ps.forEach((p: any) => { const w = String(p.posted_at).slice(0, 10); const k = w.slice(0, 8) + String(Math.ceil(Number(w.slice(8, 10)) / 7)); byWeek[k] = (byWeek[k] || 0) + 1; });
    const fmt: Record<string, number> = {}; ps.forEach((p: any) => { const k = p.product_type || p.media_type || "POST"; fmt[k] = (fmt[k] || 0) + 1; });
    const hours: Record<string, { n: number; v: number }> = {}; ps.forEach((p: any) => { const h = new Date(new Date(p.posted_at).getTime() + 5.5 * 3600e3).getUTCHours(); const o = hours[h] || (hours[h] = { n: 0, v: 0 }); o.n++; o.v += (p.views || p.reach || 0) / Math.max(med, 1); });
    const lastPost = ps[0]?.posted_at || null;
    const gaps: number[] = []; for (let i = 1; i < ps.length; i++) gaps.push((new Date(ps[i - 1].posted_at).getTime() - new Date(ps[i].posted_at).getTime()) / 864e5);
    const f14 = f.filter((x: any) => x.day >= istDay(14));
    const pace = f14.length > 1 ? (f14[f14.length - 1].followers - f14[0].followers) / Math.max(1, (new Date(f14[f14.length - 1].day).getTime() - new Date(f14[0].day).getTime()) / 864e5) : null;
    const follows = sumR("follows") || d.reduce((t: number, x: any) => t + (x.follows || 0), 0);
    const viewsSum = sumR("views") || d.reduce((t: number, x: any) => t + (x.views || 0), 0);
    const top = ps.map((p: any) => ({ p, s: (p.views || p.reach || 0) / Math.max(med, 1) })).sort((x: any, y: any) => y.s - x.s);
    const slim = (p: any) => ({ when: String(p.posted_at).slice(0, 16), type: p.product_type || p.media_type, title: (p.caption || p.title || "").slice(0, 160), views: p.views, reach: p.reach, likes: p.likes, comments: p.comments, sends: p.shares, saves: p.saves, skip_rate: p.skip_rate, avg_watch_s: p.avg_watch_ms ? Math.round(p.avg_watch_ms / 100) / 10 : null, follows: p.follows, x_median: Math.round(((p.views || p.reach || 0) / Math.max(med, 1)) * 10) / 10, hashtags: ((p.caption || "").match(/#\w+/g) || []).length });
    per.push({
      id: a.id, platform: a.platform, name: a.name, handle: a.handle, followers: a.followers, status: a.status, error: a.error, connected: a.status !== "manual", can_publish: a.can_publish,
      bio: a.meta?.bio, website: a.meta?.website, online: a.meta?.online, demo: a.meta?.demo,
      posts: ps.length, posts_per_week: Math.round(ps.length / weeks * 10) / 10, last_post: lastPost, days_since_last: lastPost ? Math.round((Date.now() - new Date(lastPost).getTime()) / 864e5) : null, longest_gap_days: gaps.length ? Math.round(Math.max(...gaps)) : null,
      format_mix: fmt, median_views: med,
      avg_skip_rate: median(reels.map((p: any) => p.skip_rate).filter((x: any) => x != null)),
      avg_watch_s: (() => { const m = median(reels.map((p: any) => p.avg_watch_ms).filter(Boolean)); return m ? Math.round(m / 100) / 10 : null; })(),
      sends_per_1k_reach: reach ? Math.round(sumR("shares") / reach * 10000) / 10 : null,
      saves_per_1k_reach: reach ? Math.round(sumR("saves") / reach * 10000) / 10 : null,
      likes_per_1k_reach: reach ? Math.round(sumR("likes") / reach * 10000) / 10 : null,
      engagement_rate_pct: reach ? Math.round((sumR("likes") + sumR("comments") + sumR("shares") + sumR("saves")) / reach * 10000) / 100 : null,
      follows_per_1k_views: viewsSum && follows ? Math.round(follows / viewsSum * 10000) / 10 : null,
      follower_pace_per_day: pace != null ? Math.round(pace * 10) / 10 : null,
      captions_over_5_hashtags: ps.filter((p: any) => ((p.caption || "").match(/#\w+/g) || []).length > 5).length,
      outliers: top.filter((x: any) => x.s >= 3).slice(0, 6).map((x: any) => slim(x.p)), best: top.slice(0, 6).map((x: any) => slim(x.p)), worst: top.slice(-4).map((x: any) => slim(x.p)),
      hour_index: Object.fromEntries(Object.entries(hours).map(([h, o]) => [h, Math.round(o.v / o.n * 100) / 100])),
      daily_recent: d.slice(-14),
    });
  }
  return per;
}

const ISSUE = S({ severity: { type: "string", enum: ["critical", "high", "medium", "low"] }, area: str, problem: str, evidence: str, where: str, fix: arr(str), impact: str });
async function doDiagnose(rid: number) {
  try {
    const per = await perfData(90);
    const out = await ai({ effort: "medium", instructions: `You are the head of social media growth auditing a brand's accounts. Be specific, blunt and practical, like a senior consultant. Use ONLY the numbers given; never invent metrics. When data is missing (e.g. account not connected), say what is missing and that it blocks diagnosis. Each issue must say EXACTLY where it is corrected: a precise place such as "Reel opening (first 1.5 s)", "Instagram bio line 1", "Caption first line", "Posting schedule (Social → Plan)", "Meta developer account (developers.facebook.com)", "Account settings → Professional account type", "Editing: cut pacing". Fix = 2-5 concrete steps. Order by impact. Max 12 issues. Also list wins to keep doing.\n${PLAYBOOK}`, input: (await brandCtx()) + "\n\nACCOUNT DATA (last 90 days):\n" + JSON.stringify(per).slice(0, 60000), schema: { name: "diag", schema: S({ health: num, summary: str, issues: arr(ISSUE), wins: arr(str), quick_wins_this_week: arr(str) }) } });
    const rep = JSON.parse(out); rep.data = per.map((p) => ({ id: p.id, platform: p.platform, name: p.name, followers: p.followers, posts_per_week: p.posts_per_week, median_views: p.median_views, avg_skip_rate: p.avg_skip_rate, avg_watch_s: p.avg_watch_s, sends_per_1k_reach: p.sends_per_1k_reach, saves_per_1k_reach: p.saves_per_1k_reach, engagement_rate_pct: p.engagement_rate_pct, follows_per_1k_views: p.follows_per_1k_views, follower_pace_per_day: p.follower_pace_per_day, days_since_last: p.days_since_last }));
    await admin.from("social_reports").update({ status: "ready", report: rep }).eq("id", rid);
  } catch (e) { await admin.from("social_reports").update({ status: "error", error: String((e as Error).message).slice(0, 500) }).eq("id", rid); }
}

const IDEA = S({ title: str, pillar: str, format: { type: "string", enum: FORMATS }, hook: str, concept: str, why_viral: str, send_trigger: str, length_s: num, effort: { type: "string", enum: ["low", "medium", "high"] }, needs: str, trend_ref: str });
async function doIdeas(rid: number, b: any, uid: string | null) {
  try {
    const per = await perfData(90);
    const best = per.flatMap((p) => p.outliers.length ? p.outliers : p.best.slice(0, 3)).slice(0, 10);
    let goal = ""; if (b.goal_id) { const { data: g } = await admin.from("social_goals").select("*").eq("id", b.goal_id).maybeSingle(); if (g?.plan) goal = "GOAL PLAN FORMATS TO FOLLOW: " + JSON.stringify({ formats: g.plan.formats, series: g.plan.series }).slice(0, 5000); }
    const { data: have } = await admin.from("social_reels").select("title").order("id", { ascending: false }).limit(80);
    const n = Math.min(Math.max(Number(b.count) || 8, 3), 15);
    const out = await ai({ effort: "medium", web: b.trends !== false, instructions: `You are a viral short-form video strategist for Indian D2C brands. ${b.trends !== false ? "First search the web for what is trending RIGHT NOW on Instagram Reels in India (audio, formats, festivals, moments in the next 2-3 weeks, mom/parenting/fashion trends) and use real current trends. Put the trend name in trend_ref (or 'evergreen')." : "Use evergreen ideas; trend_ref='evergreen'."} Every idea must be filmable by a small team in Chennai with phones, original (not reposted), and engineered for sends. Hooks must be the exact words spoken/shown in the first 2 seconds.\n${PLAYBOOK}`, input: `${await brandCtx()}\n${goal}\nTheir best/outlier posts so far: ${JSON.stringify(best).slice(0, 8000)}\nAvoid repeating: ${(have || []).map((x: any) => x.title).join(" | ").slice(0, 3000)}\n${b.pillar ? "Content pillar to focus on: " + b.pillar + "\n" : ""}${b.notes ? "Team notes: " + b.notes + "\n" : ""}Give ${n} reel ideas.`, schema: { name: "ideas", schema: S({ ideas: arr(IDEA) }) } });
    const ideas = JSON.parse(out).ideas || [];
    const rows = ideas.map((x: any, i: number) => ({ title: x.title, pillar: x.pillar, format: x.format, status: "idea", source: b.source || "ai", idea: x, goal_id: b.goal_id || null, created_by: uid, due_date: b.dates?.[i] || null }));
    const { data: ins } = rows.length ? await admin.from("social_reels").insert(rows).select("id") : { data: [] } as any;
    await admin.from("social_reports").update({ status: "ready", report: { ids: (ins || []).map((x: any) => x.id), count: rows.length } }).eq("id", rid);
    return (ins || []).map((x: any) => x.id);
  } catch (e) { await admin.from("social_reports").update({ status: "error", error: String((e as Error).message).slice(0, 500) }).eq("id", rid); return []; }
}

const SCORE = S({ score: num, grade: str, verdict: str, breakdown: arr(S({ criterion: str, score: num, max: num, note: str })), fixes: arr(str), predicted_skip_rate: str, predicted_sends: str });
const SCRIPT = S({
  length_s: num, objective: str, target_viewer: str,
  hooks: arr(S({ type: str, spoken: str, on_screen_text: str, visual: str })), best_hook: num,
  beats: arr(S({ time: str, visual: str, shot: str, voiceover: str, on_screen_text: str, sfx_music: str })),
  shot_list: arr(str), props_wardrobe: arr(str), location: str, talent: str,
  audio: S({ type: str, suggestion: str }), edit_notes: arr(str),
  loop_ending: str, caption: str, hashtags: arr(str), cta: str, cover_text: str, first_comment: str,
  best_post_time_ist: str, trial_reel: S({ use: { type: "boolean" }, why: str }),
  repurpose: S({ youtube_title: str, threads_text: str, facebook_note: str }),
  compliance: str,
});
async function scoreReel(text: string) {
  const out = await ai({ effort: "medium", instructions: `You are a strict virality reviewer. Score this reel plan out of 100 using this rubric: Hook strength (stops scroll in <1.5s, person+speech+text in first 3s) 20; Retention design (open loop, pacing, payoff late, loop ending, right length) 20; Shareability / send trigger 20; Value or emotion 10; Originality 10; Clarity & visual quality plan 5; Caption & discovery (keyword in first line, 3-5 hashtags max) 5; CTA (send/save/comment) 5; Brand fit 5. Be harsh: average content scores 50-65; 85+ only if genuinely likely to outperform. Fixes = top 3-5 specific rewrites (give the exact new line where possible).\n${PLAYBOOK}`, input: text.slice(0, 15000), schema: { name: "score", schema: SCORE } });
  return JSON.parse(out);
}
async function doScript(id: number, notes?: string) {
  try {
    const { data: r } = await admin.from("social_reels").select("*").eq("id", id).single();
    const out = await ai({ effort: "medium", instructions: `You are an award-winning short-form video director and copywriter. Turn the idea into a complete, ready-to-shoot production pack for a phone shoot. Write 10 different hook options (types: curiosity gap, bold claim, relatable pain, pattern interrupt visual, POV, question, number/list, mistake warning, before/after reveal, Tamil-English mix) and choose the best index. Beats must be second-by-second with exact spoken lines (natural Indian English; add Tamil phrases only where it helps relatability), on-screen text and shot type. Caption: first line = hook + keyword, ≤ 2,000 chars, 3-5 hashtags in the hashtags field only (not inside caption). Include a send-trigger CTA. Health topics: keep general, no medical claims. compliance = any claim/music-rights risks.\n${PLAYBOOK}`, input: `${await brandCtx()}\nIDEA: ${JSON.stringify({ title: r.title, format: r.format, pillar: r.pillar, ...r.idea })}\n${notes || r.notes ? "Team notes: " + (notes || r.notes) : ""}`, schema: { name: "script", schema: SCRIPT } });
    const sc = JSON.parse(out);
    let score = null; try { score = await scoreReel(JSON.stringify({ idea: r.idea, script: sc })); } catch (_) { /* */ }
    await admin.from("social_reels").update({ script: sc, score, status: ["idea", "scripted"].includes(r.status) ? "scripted" : r.status, generating: false, error: null, updated_at: now() }).eq("id", id);
  } catch (e) { await admin.from("social_reels").update({ generating: false, error: String((e as Error).message).slice(0, 400) }).eq("id", id); }
}
async function doOutlier(rid: number, b: any, uid: string | null) {
  try {
    const out = await ai({ effort: "medium", web: !!b.url, instructions: `You reverse-engineer viral short-form videos. ${b.url ? "Look up the link if you can." : ""} Explain precisely WHY it worked (hook mechanics, retention devices, emotion, send trigger, format, timing/trend) and then adapt the pattern into 3 ORIGINAL Putchi reel ideas (never copy; transform it).\n${PLAYBOOK}`, input: `${await brandCtx()}\nREFERENCE: ${b.url || ""}\nWhat the team saw / transcript / caption: ${b.text || ""}\nViews/likes if known: ${b.stats || ""}`, schema: { name: "outlier", schema: S({ why_it_worked: arr(str), pattern: str, hook_formula: str, ideas: arr(IDEA) }) } });
    const j = JSON.parse(out);
    const rows = (j.ideas || []).map((x: any) => ({ title: x.title, pillar: x.pillar, format: x.format, status: "idea", source: "outlier", idea: { ...x, inspired_by: b.url || "" }, created_by: uid }));
    const { data: ins } = rows.length ? await admin.from("social_reels").insert(rows).select("id") : { data: [] } as any;
    await admin.from("social_reports").update({ status: "ready", report: { ...j, ids: (ins || []).map((x: any) => x.id), url: b.url || "" } }).eq("id", rid);
  } catch (e) { await admin.from("social_reports").update({ status: "error", error: String((e as Error).message).slice(0, 500) }).eq("id", rid); }
}


// ---------- REEL REVIEWS (AI social media manager) ----------
async function selfCall(body: any) {
  const k = await secret("cron_key");
  try { await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/social-hub`, { method: "POST", headers: { "Content-Type": "application/json", "x-cron-key": k || "" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); } catch (_) { /* fire and forget */ }
}
async function probeDuration(url: string): Promise<number | null> {
  const find = (buf: Uint8Array) => {
    for (let i = 4; i < buf.length - 32; i++) {
      if (buf[i] === 0x6d && buf[i + 1] === 0x76 && buf[i + 2] === 0x68 && buf[i + 3] === 0x64) { // 'mvhd'
        const dv = new DataView(buf.buffer, buf.byteOffset + i + 4); const ver = dv.getUint8(0);
        if (ver === 1) { const ts = dv.getUint32(20); const du = Number(dv.getBigUint64(24)); return ts ? du / ts : null; }
        const ts = dv.getUint32(12); const du = dv.getUint32(16); return ts ? du / ts : null;
      }
    }
    return null;
  };
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-1048575" }, signal: AbortSignal.timeout(20000) });
    const total = Number((r.headers.get("content-range") || "").split("/")[1]) || 0;
    const d = find(new Uint8Array(await r.arrayBuffer())); if (d) return Math.round(d * 10) / 10;
    if (total > 1048576) { const r2 = await fetch(url, { headers: { Range: `bytes=${Math.max(0, total - 1048576)}-${total - 1}` }, signal: AbortSignal.timeout(20000) }); const d2 = find(new Uint8Array(await r2.arrayBuffer())); if (d2) return Math.round(d2 * 10) / 10; }
  } catch (_) { /* */ }
  return null;
}
function med(xs: any[]) { const s = xs.filter((x) => x != null && !isNaN(x)).map(Number).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }
const per1k = (a: any, b: any) => (b ? Math.round((Number(a || 0) / Number(b)) * 10000) / 10 : null);
function reelMetrics(p: any) {
  const reach = p.reach || null, views = p.views || null;
  return { views, reach, likes: p.likes, comments: p.comments, sends: p.shares, saves: p.saves, skip_rate: p.skip_rate, avg_watch_s: p.avg_watch_ms ? Math.round(p.avg_watch_ms / 100) / 10 : null, duration_s: p.duration_s, watched_pct: p.avg_watch_ms && p.duration_s ? Math.round((p.avg_watch_ms / 1000) / p.duration_s * 100) : null, likes_per_1k_reach: per1k(p.likes, reach), comments_per_1k_reach: per1k(p.comments, reach), sends_per_1k_reach: per1k(p.shares, reach), saves_per_1k_reach: per1k(p.saves, reach), hashtags: ((p.caption || "").match(/#[\w஀-௿]+/g) || []).length, caption_chars: (p.caption || "").length, posted_ist: new Date(new Date(p.posted_at).getTime() + 5.5 * 3600e3).toISOString().slice(0, 16).replace("T", " "), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(new Date(p.posted_at).getTime() + 5.5 * 3600e3).getUTCDay()] };
}
const REVIEW = S({
  verdict: { type: "string", enum: ["outlier", "above usual", "average", "below usual", "flop"] },
  one_line: str,
  bottleneck: { type: "string", enum: ["hook (first 3s)", "retention (watch time)", "engagement (likes/comments)", "shareability (sends/saves)", "distribution (reach)", "timing", "packaging (cover/caption)", "none"] },
  why: arr(str), evidence: arr(str), what_worked: arr(str),
  corrections: arr(S({ where: str, problem: str, fix: str })),
  rewrite: S({ hook_line: str, on_screen_text: str, caption_first_line: str, cover_text: str, ideal_length_s: num, best_post_time_ist: str }),
  next_reel: S({ title: str, format: { type: "string", enum: FORMATS }, hook: str, concept: str, why: str }),
  lesson: str, confidence: { type: "string", enum: ["high", "medium", "low"] },
});
async function reviewPost(postId: number) {
  const { data: p } = await admin.from("social_posts").select("*").eq("id", postId).single();
  if (!p) throw new Error("Post not found");
  const { data: acc } = await admin.from("social_accounts").select("*").eq("id", p.account_id).single();
  let thumb = p.thumb as string | null;
  if (acc.platform === "instagram") {
    try {
      const t = await tokenOf(acc);
      const m = await gget(p.post_id, { fields: "media_url,thumbnail_url,media_type,media_product_type,caption" }, t.token);
      if (m.thumbnail_url || m.media_url) thumb = m.thumbnail_url || (m.media_type === "IMAGE" ? m.media_url : thumb);
      if (!p.duration_s && m.media_type === "VIDEO" && m.media_url) { const d = await probeDuration(m.media_url); if (d) { p.duration_s = d; await admin.from("social_posts").update({ duration_s: d }).eq("id", postId); } }
      if (thumb && thumb !== p.thumb) await admin.from("social_posts").update({ thumb }).eq("id", postId);
    } catch (_) { /* use stored data */ }
  }
  const since = new Date(Date.now() - 120 * 864e5).toISOString();
  const { data: peers } = await admin.from("social_posts").select("*").eq("account_id", p.account_id).gte("posted_at", since).order("posted_at", { ascending: false }).limit(80);
  const same = (peers || []).filter((x: any) => (p.product_type ? x.product_type === p.product_type : true));
  const base = { views: med(same.map((x: any) => x.views || x.reach)), reach: med(same.map((x: any) => x.reach)), skip_rate: med(same.map((x: any) => x.skip_rate)), avg_watch_s: (() => { const m = med(same.map((x: any) => x.avg_watch_ms)); return m ? Math.round(m / 100) / 10 : null; })(), likes_per_1k_reach: med(same.map((x: any) => per1k(x.likes, x.reach))), sends_per_1k_reach: med(same.map((x: any) => per1k(x.shares, x.reach))), saves_per_1k_reach: med(same.map((x: any) => per1k(x.saves, x.reach))), comments_per_1k_reach: med(same.map((x: any) => per1k(x.comments, x.reach))) };
  const mine = reelMetrics(p);
  const xMed = base.views ? Math.round(((p.views || p.reach || 0) / base.views) * 100) / 100 : null;
  const tops = same.map((x: any) => ({ x, r: (x.views || x.reach || 0) / Math.max(base.views || 1, 1) })).sort((a: any, b: any) => b.r - a.r).slice(0, 4).map((o: any) => ({ caption: (o.x.caption || o.x.title || "").slice(0, 140), x_usual: Math.round(o.r * 10) / 10, skip_rate: o.x.skip_rate, avg_watch_s: o.x.avg_watch_ms ? Math.round(o.x.avg_watch_ms / 100) / 10 : null, sends: o.x.shares, posted_ist: reelMetrics(o.x).posted_ist }));
  const online = acc.meta?.online ? Object.entries(acc.meta.online).sort((a: any, b: any) => b[1] - a[1]).slice(0, 4).map(([h]) => ((Number(h) + 13) % 24) + ":00 IST").join(", ") : "unknown";
  const out = await ai({
    effort: "medium", images: thumb ? [thumb] : [],
    instructions: `You are the Putchi brand's senior social media manager and content creator, personally accountable for growth. Review ONE published ${acc.platform} ${p.product_type || p.media_type || "post"} like a post-mortem. Be specific to THIS post, never generic. Use the numbers: compare every metric to the account's usual (median) for the same format. Diagnose the funnel in order: 1) Hook — skip rate (share of viewers who left in the first 3 s), 2) Retention — avg watch time and % of video watched, 3) Engagement — likes/comments per 1K reach, 4) Shareability — sends and saves per 1K reach (sends drive reach to non-followers most), 5) Distribution — views vs usual, 6) Timing — posted time vs when followers are online, 7) Packaging — cover image (attached, judge it: is the subject/text clear at thumbnail size?), caption first line, hashtag count (max 5 allowed). The bottleneck is the EARLIEST stage clearly worse than usual. If it did well, explain exactly why so it can be repeated. Corrections must name the exact place (e.g. "Opening 0-1.5 s", "On-screen text", "Cover", "Caption line 1", "Posting time", "Length", "Ending/CTA") and give the exact replacement line where possible. Write the rewrite as if remaking this same reel. next_reel = the single best follow-up reel to post next, based on this result. lesson = one reusable rule for this account (max 20 words). If data is missing (e.g. no skip rate), say so in evidence and lower confidence.\n${PLAYBOOK}`,
    input: `${await brandCtx()}\n\nPOST: ${JSON.stringify({ caption: (p.caption || p.title || "").slice(0, 1500), url: p.url, type: p.product_type || p.media_type })}\nTHIS POST METRICS: ${JSON.stringify(mine)}\nACCOUNT USUAL (median, same format, last 120 days): ${JSON.stringify(base)}\nViews vs usual: ${xMed ?? "unknown"}x\nFollowers: ${acc.followers}. Followers most online: ${online}.\nTOP RECENT POSTS FOR CONTRAST: ${JSON.stringify(tops)}`,
    schema: { name: "review", schema: REVIEW },
  });
  const rev = JSON.parse(out); rev.metrics = mine; rev.usual = base; rev.x_usual = xMed; rev.at = now();
  await admin.from("social_posts").update({ review: rev, reviewed_at: now() }).eq("id", postId);
  return rev;
}
async function reviewPending(limit = 15, force = false, deadline = Date.now() + 65000): Promise<any[] & { left?: number }> {
  const { data: accs } = await admin.from("social_accounts").select("id,platform").in("platform", ["instagram", "facebook", "youtube"]);
  const ids = (accs || []).map((a: any) => a.id); if (!ids.length) return [];
  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString(), since = new Date(Date.now() - 90 * 864e5).toISOString();
  const { data: ps } = await admin.from("social_posts").select("id,account_id,product_type,media_type,posted_at,reviewed_at,views,reach").in("account_id", ids).lte("posted_at", cutoff).gte("posted_at", since).order("posted_at", { ascending: false }).limit(200);
  const ig = (accs || []).filter((a: any) => a.platform === "instagram").map((a: any) => a.id);
  const todo = (ps || []).filter((p: any) => {
    const vid = p.product_type === "REELS" || p.media_type === "VIDEO" || !ig.includes(p.account_id);
    if (!vid && ig.includes(p.account_id) && p.product_type !== "FEED") return false;
    if (force || !p.reviewed_at) return true;
    const age = Date.now() - new Date(p.posted_at).getTime(), revAge = new Date(p.reviewed_at).getTime() - new Date(p.posted_at).getTime();
    return revAge < 3 * 864e5 && age > 5 * 864e5; // final re-review once numbers settle
  }).slice(0, limit);
  const done: any = [];
  let i = 0;
  while (i < todo.length && Date.now() < deadline) {
    const batch = todo.slice(i, i + 3); i += batch.length;
    await Promise.all(batch.map(async (p: any) => { try { const r = await reviewPost(p.id); done.push({ id: p.id, verdict: r.verdict }); } catch (e) { const m = String((e as Error).message).slice(0, 200); done.push({ id: p.id, error: m }); await admin.from("social_posts").update({ review: { error: m, at: now() }, reviewed_at: now() }).eq("id", p.id); } }));
  }
  done.left = todo.length - i;
  return done;
}
async function updatePlaybook() {
  const { data: ps } = await admin.from("social_posts").select("title,caption,posted_at,product_type,review").not("review", "is", null).order("posted_at", { ascending: false }).limit(60);
  if (!ps || ps.length < 3) return null;
  const rows = ps.map((p: any) => ({ when: String(p.posted_at).slice(0, 10), type: p.product_type, caption: (p.caption || p.title || "").slice(0, 100), verdict: p.review.verdict, x_usual: p.review.x_usual, bottleneck: p.review.bottleneck, lesson: p.review.lesson, skip: p.review.metrics?.skip_rate, watch: p.review.metrics?.avg_watch_s, sends1k: p.review.metrics?.sends_per_1k_reach }));
  const out = await ai({ effort: "medium", instructions: "You maintain the brand's living content playbook from its OWN post reviews. Merge the lessons into clear, specific rules backed by the data (mention numbers). Keep only what the evidence supports; drop one-off noise. Max 8 items per list.", input: JSON.stringify(rows).slice(0, 40000), schema: { name: "playbook", schema: S({ summary: str, what_works: arr(str), what_fails: arr(str), best_formats: arr(str), best_hooks: arr(str), best_times: arr(str), rules: arr(str), biggest_problem_now: str }) } });
  const pb = JSON.parse(out); pb.updated_at = now(); pb.based_on = rows.length;
  await admin.from("app_settings").upsert({ key: "social_playbook", value: JSON.stringify(pb), updated_at: now() });
  return pb;
}
async function manager() {
  await syncAll();
  await selfCall({ action: "review_all", limit: 15, then: "manager2" });
}
async function manager2() {
  try { await updatePlaybook(); } catch (_) { /* */ }
  await selfCall({ action: "manager3" });
}
async function manager3() {
  let pb: any = null;
  if (!pb) { try { pb = JSON.parse(await setting("social_playbook", "") || "null"); } catch (_) { pb = null; } }
  // keep the next 7 days stocked with scripted reels
  const today = istDay(0); const days: string[] = []; for (let i = 0; i < 7; i++) days.push(istDay(-i));
  const { data: goal } = await admin.from("social_goals").select("*").eq("status", "active").order("id", { ascending: false }).limit(1).maybeSingle();
  const perWeek = Math.min(Math.max(Math.round(goal?.plan?.weekly_mix?.reels || 5), 3), 14);
  const { data: pipe } = await admin.from("social_reels").select("id,due_date,status,script").in("status", ["idea", "scripted", "approved", "filming", "editing", "ready", "scheduled"]).gte("due_date", today);
  const have = (pipe || []).length; const need = Math.max(0, perWeek - have);
  let created: number[] = [];
  if (need > 0) {
    const taken = new Set((pipe || []).map((r: any) => r.due_date)); const free = days.filter((d) => !taken.has(d)); const dates = (free.length ? free : days).slice(0, need);
    const { data: rep } = await admin.from("social_reports").insert({ kind: "ideas", status: "working" }).select("id").single();
    created = await doIdeas(rep!.id, { count: Math.max(3, need), goal_id: goal?.id || null, source: "manager", dates, trends: true }, null);
  }
  const { data: unscripted } = await admin.from("social_reels").select("id").in("status", ["idea"]).gte("due_date", today).is("script", null).order("due_date").limit(3);
  for (const r of unscripted || []) { await admin.from("social_reels").update({ generating: true }).eq("id", r.id); await selfCall({ action: "script", reel_id: r.id }); }
  // daily brief
  const since = new Date(Date.now() - 36 * 3600e3).toISOString();
  const { data: fresh } = await admin.from("social_posts").select("id,title,review,reviewed_at").gte("reviewed_at", since).not("review", "is", null).order("reviewed_at", { ascending: false }).limit(8);
  const { data: todays } = await admin.from("social_reels").select("id,title,status").eq("due_date", today).not("status", "in", "(posted,dropped)");
  const { data: sched } = await admin.from("social_queue").select("id,title,scheduled_at").eq("status", "scheduled").gte("scheduled_at", new Date(today + "T00:00:00+05:30").toISOString()).lt("scheduled_at", new Date(istDay(-1) + "T00:00:00+05:30").toISOString());
  const brief = { date: today, reviewed: (fresh || []).map((p: any) => ({ id: p.id, title: (p.title || "").slice(0, 80), verdict: p.review.verdict, one_line: p.review.one_line, bottleneck: p.review.bottleneck })), today_reels: (todays || []).map((r: any) => ({ id: r.id, title: r.title, status: r.status })), today_posts: (sched || []).map((q: any) => ({ id: q.id, title: q.title, at: q.scheduled_at })), new_ideas: created.length, pipeline_next_7_days: have + created.length, target_per_week: perWeek, playbook_focus: pb?.biggest_problem_now || null };
  await admin.from("social_reports").insert({ kind: "brief", status: "ready", report: brief });
  const parts: string[] = [];
  if (brief.reviewed.length) parts.push(`Reviewed ${brief.reviewed.length} reel(s): ` + brief.reviewed.slice(0, 2).map((r: any) => `"${r.title.slice(0, 30)}" ${r.verdict}`).join(", "));
  if (brief.today_reels.length) parts.push(`${brief.today_reels.length} reel(s) to shoot/finish today`);
  if (brief.today_posts.length) parts.push(`${brief.today_posts.length} post(s) going live today`);
  if (created.length) parts.push(`${created.length} new scripted ideas added`);
  if (pb?.biggest_problem_now) parts.push(`Focus: ${pb.biggest_problem_now}`);
  if (parts.length) await notifySocial("🧑‍💼 Your social media manager", parts.join(" · "), "brief");
  return brief;
}
// ---------- GOALS / AUTOPILOT ----------
function goalMath(g: any, acc: any, per: any) {
  const today = new Date(istDay(0)); const end = new Date(g.end_date);
  const daysLeft = Math.max(1, Math.round((end.getTime() - today.getTime()) / 864e5));
  const cur = g.metric === "followers" ? (acc?.followers ?? g.start_value ?? 0) : (g.start_value ?? 0);
  const gap = Math.max(0, Number(g.target) - cur);
  const perDay = gap / daysLeft;
  const pace = per?.follower_pace_per_day ?? null;
  const conv = per?.follows_per_1k_views ?? null;
  const convUsed = conv || 2; // fallback assumption: ~2 follows per 1,000 views
  const viewsNeededPerDay = g.metric === "followers" ? Math.round(perDay / convUsed * 1000) : null;
  const start = new Date(g.start_date); const total = Math.max(1, (end.getTime() - start.getTime()) / 864e5);
  const elapsed = Math.max(0, (today.getTime() - start.getTime()) / 864e5);
  const sv = Number(g.start_value ?? cur);
  const expectedNow = Math.round(sv + (Number(g.target) - sv) * (elapsed / total));
  return { current: cur, target: Number(g.target), gap, days_left: daysLeft, needed_per_day: Math.round(perDay), needed_per_week: Math.round(perDay * 7), current_pace_per_day: pace, pace_ratio: pace ? Math.round(pace / Math.max(perDay, 0.01) * 100) / 100 : null, follows_per_1k_views: conv, follows_per_1k_views_assumed: !conv, views_needed_per_day: viewsNeededPerDay, views_needed_per_month: viewsNeededPerDay ? viewsNeededPerDay * 30 : null, median_views_per_post: per?.median_views ?? null, expected_by_today: expectedNow, behind_by: Math.max(0, expectedNow - cur) };
}
async function doPlan(gid: number, autopilotIdeas = true) {
  try {
    const { data: g } = await admin.from("social_goals").select("*").eq("id", gid).single();
    const { data: acc } = g.account_id ? await admin.from("social_accounts").select("*").eq("id", g.account_id).single() : { data: null } as any;
    const all = await perfData(90); const per = all.find((p) => p.id === g.account_id) || null;
    const math = goalMath(g, acc, per);
    const weeks = Math.max(1, Math.ceil(math.days_left / 7));
    const PLAN = S({
      verdict: { type: "string", enum: ["on track", "achievable", "stretch", "very aggressive", "unrealistic without paid + collabs"] }, honest_note: str, north_star: str,
      phases: arr(S({ name: str, weeks: str, focus: str, followers_target: num, weekly_views_target: num })),
      weekly_mix: S({ reels: num, carousels: num, trial_reels: num, stories_per_day: num, lives_per_month: num, collabs_per_month: num, youtube_shorts: num }),
      formats: arr(S({ name: str, structure: str, why: str, length_s: str, per_week: num, example_hooks: arr(str) })),
      series: arr(S({ name: str, premise: str, cadence: str, episode_ideas: arr(str) })),
      posting_slots_ist: arr(S({ day: str, time: str, what: str })),
      levers: arr(S({ lever: str, detail: str, budget_hint: str })),
      kpis: arr(S({ metric: str, target: str, why: str })),
      milestones: arr(S({ week: num, date: str, target: num })),
      this_week: arr(str), stop_doing: arr(str), rules: arr(str),
    });
    const out = await ai({ effort: "high", web: true, instructions: `You are a growth strategist who has scaled Indian brand accounts to millions of followers. Build an exact, honest operating plan to hit the goal. Use the MATH given (do not change the numbers); if the target is unrealistic organically, say so plainly in honest_note and show what it would take (volume, collabs with creators, paid amplification of winning reels, giveaways, cross-platform). Give EXACT formats with structures and example hooks tailored to this brand, a weekly content mix, posting slots in IST, series concepts, KPIs that predict growth (skip rate, avg watch time, sends per 1k reach, follows per 1k views), and weekly milestones (${Math.min(weeks, 30)} entries, dates YYYY-MM-DD, cumulative target on that date). Search the web for current growth tactics and India trends if useful.\n${PLAYBOOK}`, input: `${await brandCtx()}\nGOAL: ${g.title || ""} — ${g.metric} target ${g.target} on ${acc ? acc.platform + " " + (acc.handle || acc.name) : "all accounts"} by ${g.end_date} (started ${g.start_date} at ${g.start_value ?? "?"}).\nMATH: ${JSON.stringify(math)}\nACCOUNT PERFORMANCE: ${JSON.stringify(per || all).slice(0, 25000)}`, schema: { name: "plan", schema: PLAN } });
    const plan = JSON.parse(out); plan.math = math;
    await admin.from("social_goals").update({ plan, plan_at: now(), planning: false, error: null }).eq("id", gid);
    if (autopilotIdeas && g.autopilot) await selfCall({ action: "autopilot_goal", goal_id: gid });
  } catch (e) { await admin.from("social_goals").update({ planning: false, error: String((e as Error).message).slice(0, 400) }).eq("id", gid); }
}
async function weekIdeas(g: any) {
  const mix = g.plan?.weekly_mix || {}; const n = Math.min(Math.max(Math.round((mix.reels || 5) + (mix.carousels || 0)), 3), 14);
  const slots: string[] = []; const base = new Date(istDay(-1));
  for (let i = 0; i < n; i++) { const d = new Date(base.getTime() + Math.floor(i * 7 / n) * 864e5); slots.push(d.toISOString().slice(0, 10)); }
  const { data: rep } = await admin.from("social_reports").insert({ kind: "ideas", status: "working" }).select("id").single();
  const ids = await doIdeas(rep!.id, { count: n, goal_id: g.id, source: "autopilot", dates: slots, trends: true }, null);
  for (const id of ids.slice(0, 4)) { await admin.from("social_reels").update({ generating: true }).eq("id", id); await selfCall({ action: "script", reel_id: id }); }
  if (ids.length) await notifySocial("🎯 Autopilot planned next week", `${ids.length} reel ideas for "${g.title || "your goal"}" are in Social → Reels with shoot dates. The first ${Math.min(4, ids.length)} already have full scripts.`, "g" + g.id);
}
async function autopilot() {
  await syncAll();
  const { data: goals } = await admin.from("social_goals").select("*").eq("status", "active");
  for (const g of goals || []) {
    if (new Date(g.end_date) < new Date(istDay(0))) { await admin.from("social_goals").update({ status: "missed" }).eq("id", g.id); continue; }
    const { data: acc } = g.account_id ? await admin.from("social_accounts").select("*").eq("id", g.account_id).single() : { data: null } as any;
    if (acc && g.metric === "followers" && (acc.followers || 0) >= Number(g.target)) { await admin.from("social_goals").update({ status: "done" }).eq("id", g.id); await notifySocial("🏆 Goal reached!", `${g.title || "Follower goal"} hit ${g.target}.`, "g" + g.id); continue; }
    if (!g.autopilot) continue;
    const per = (await perfData(30)).find((p) => p.id === g.account_id);
    const m = goalMath(g, acc, per);
    const stale = !g.plan_at || (Date.now() - new Date(g.plan_at).getTime()) > 27 * 864e5;
    if (stale || (m.behind_by > m.needed_per_week * 2)) { await admin.from("social_goals").update({ planning: true }).eq("id", g.id); await selfCall({ action: "plan", goal_id: g.id }); }
    else await selfCall({ action: "autopilot_goal", goal_id: g.id });
    await notifySocial("📊 Weekly goal check", `${g.title || "Goal"}: ${m.current.toLocaleString("en-IN")} / ${m.target.toLocaleString("en-IN")}. Need ${m.needed_per_week.toLocaleString("en-IN")} a week; ${m.behind_by ? "behind plan by " + m.behind_by.toLocaleString("en-IN") : "on plan"}.`, "g" + g.id);
  }
  await selfCall({ action: "diagnose" });
}

// ---------- HTTP ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    let uid: string | null = null; let isMgr = false;
    const cron = req.headers.get("x-cron-key");
    if (cron) { if (cron !== await secret("cron_key")) return J({ error: "bad key" }, 401); isMgr = true; }
    else {
      const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: ud } = await admin.auth.getUser(tok); if (!ud?.user) return J({ error: "Please sign in again" }, 401);
      const { data: me } = await admin.from("profiles").select("role,active,modules").eq("id", ud.user.id).single();
      if (!(me?.active && (me.role === "admin" || me.role === "founder" || (me.modules || []).includes("social")))) return J({ error: "Not allowed" }, 403);
      uid = ud.user.id; isMgr = me.role === "admin" || me.role === "founder";
    }
    const act = String(b.action || "");
    const bg = (p: Promise<unknown>) => EdgeRuntime.waitUntil(p);

    if (act === "meta_discover") { const t = String(b.token || "").trim(); if (!t) return J({ error: "Paste the token" }, 400); const d = await metaDiscover(t); return J({ ok: true, user: d.user, perms: d.perms, missing: d.missing || [], warnings: d.warnings, pages: d.pages.map((p: any) => ({ id: p.id, name: p.name, followers: p.followers_count ?? p.fan_count ?? null, ig: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username, followers: p.instagram_business_account.followers_count } : null })) }); }
    if (act === "meta_connect") { const ids = await metaConnect(String(b.token || "").trim(), b.pick || []); const res = []; for (const id of ids) { const { data: a } = await admin.from("social_accounts").select("*").eq("id", id).single(); res.push(await syncOne(a)); } return J({ ok: true, ids, results: res }); }
    if (act === "connect") {
      const pl = String(b.platform || ""); const name = String(b.name || pl).slice(0, 60);
      if (pl === "youtube") { if (!b.api_key && !b.refresh_token) return J({ error: "Add an API key or OAuth details" }, 400); const id = b.account_id || await upsertAccount("youtube", String(b.external_id || "").trim(), { name, auto_sync: false, can_publish: !!b.refresh_token, status: "ok" }); await saveToken(id, { api_key: b.api_key || null, client_id: b.client_id || null, client_secret: b.client_secret || null, refresh_token: b.refresh_token || null }); await admin.from("social_accounts").update({ can_publish: !!b.refresh_token }).eq("id", id); const { data: a } = await admin.from("social_accounts").select("*").eq("id", id).single(); return J({ ok: true, id, result: await syncOne(a) }); }
      if (pl === "threads") { if (!b.token) return J({ error: "Paste the Threads token" }, 400); const me = await fj(`${TH}/me?${qs({ fields: "id,username", access_token: b.token })}`); const id = await upsertAccount("threads", me.id, { name: me.username || name, handle: me.username, auto_sync: false, can_publish: true, status: "ok" }); await saveToken(id, { token: b.token, user_id: me.id }); const { data: a } = await admin.from("social_accounts").select("*").eq("id", id).single(); return J({ ok: true, id, result: await syncOne(a) }); }
      if (pl === "linkedin") { if (!b.token || !b.external_id) return J({ error: "Add the token and organisation ID" }, 400); const id = await upsertAccount("linkedin", String(b.external_id).trim(), { name, auto_sync: false, can_publish: true, status: "ok" }); await saveToken(id, { token: b.token }); const { data: a } = await admin.from("social_accounts").select("*").eq("id", id).single(); return J({ ok: true, id, result: await syncOne(a) }); }
      const id = await upsertAccount(pl || "other", String(b.external_id || name).trim(), { name, handle: b.handle || null, auto_sync: false, can_publish: false, status: "manual" }); return J({ ok: true, id });
    }
    if (act === "disconnect") { if (!isMgr) return J({ error: "Only founders can remove accounts" }, 403); await admin.from("social_accounts").delete().eq("id", Number(b.account_id)); return J({ ok: true }); }
    if (act === "sync") { if (!cron && !b.account_id) { bg(syncAll()); return J({ ok: true, background: true }); } return J({ ok: true, results: await syncAll(b.account_id ? Number(b.account_id) : undefined) }); }
    if (act === "run_due") return J({ ok: true, results: await runDue() });
    if (act === "publish_now") { const id = Number(b.queue_id); const { data: q } = await admin.from("social_queue").select("status,account_ids").eq("id", id).single(); if (!q) return J({ error: "Not found" }, 404); if (!q.account_ids?.length) return J({ error: "Pick at least one account" }, 400); if (["draft", "scheduled", "failed", "partial"].includes(q.status)) { if (q.status === "failed" || q.status === "partial") { const { data: full } = await admin.from("social_queue").select("results").eq("id", id).single(); const r = full?.results || {}; for (const k of Object.keys(r)) if (r[k].state === "error") delete r[k]; await admin.from("social_queue").update({ results: r }).eq("id", id); } await admin.from("social_queue").update({ status: "scheduled", scheduled_at: now(), error: null }).eq("id", id); } const r = await processItem(id); return J({ ok: true, ...r }); }
    if (act === "brief") { await admin.from("app_settings").upsert({ key: "social_brief", value: String(b.brief || "").slice(0, 4000), updated_at: now() }); return J({ ok: true }); }
    if (act === "diagnose") { const { data: r } = await admin.from("social_reports").insert({ kind: "diagnosis", status: "working", created_by: uid }).select("id").single(); bg(doDiagnose(r!.id)); return J({ ok: true, id: r!.id }); }
    if (act === "ideas") { const { data: r } = await admin.from("social_reports").insert({ kind: "ideas", status: "working", created_by: uid }).select("id").single(); bg(doIdeas(r!.id, b, uid)); return J({ ok: true, id: r!.id }); }
    if (act === "outlier") { const { data: r } = await admin.from("social_reports").insert({ kind: "outlier", status: "working", created_by: uid }).select("id").single(); bg(doOutlier(r!.id, b, uid)); return J({ ok: true, id: r!.id }); }
    if (act === "script") { const id = Number(b.reel_id); await admin.from("social_reels").update({ generating: true, error: null, notes: b.notes ?? undefined }).eq("id", id); bg(doScript(id, b.notes)); return J({ ok: true }); }
    if (act === "score") { const id = Number(b.reel_id); const { data: r } = await admin.from("social_reels").select("*").eq("id", id).single(); const s = await scoreReel(JSON.stringify({ idea: r.idea, script: r.script, notes: b.text || r.notes })); await admin.from("social_reels").update({ score: s, updated_at: now() }).eq("id", id); return J({ ok: true, score: s }); }
    if (act === "score_text") { return J({ ok: true, score: await scoreReel(String(b.text || "")) }); }
    if (act === "caption") { const out = await ai({ instructions: `Write a scroll-stopping caption for this post. First line = hook + main keyword (≤125 chars). Natural Indian English, warm, mom-to-mom tone. End with a send/save CTA. Give 3-5 specific hashtags separately. ${PLAYBOOK}`, input: (await brandCtx()) + "\nPOST: " + String(b.text || "").slice(0, 3000), schema: { name: "cap", schema: S({ caption: str, hashtags: arr(str), first_comment: str }) } }); return J({ ok: true, ...JSON.parse(out) }); }
    if (act === "plan") { const id = Number(b.goal_id); await admin.from("social_goals").update({ planning: true, error: null }).eq("id", id); bg(doPlan(id, b.ideas !== false)); return J({ ok: true }); }
    if (act === "goal_math") { const { data: g } = await admin.from("social_goals").select("*").eq("id", Number(b.goal_id)).single(); const { data: acc } = g.account_id ? await admin.from("social_accounts").select("*").eq("id", g.account_id).single() : { data: null } as any; const per = (await perfData(30)).find((p) => p.id === g.account_id); return J({ ok: true, math: goalMath(g, acc, per) }); }
    if (act === "autopilot") { if (cron) { bg(autopilot()); return J({ ok: true }); } const id = Number(b.goal_id); const { data: g } = await admin.from("social_goals").select("*").eq("id", id).single(); bg(weekIdeas(g)); return J({ ok: true }); }
    if (act === "review") { const id = Number(b.post_id); bg(reviewPost(id).catch(async (e) => { await admin.from("social_posts").update({ review: { error: String((e as Error).message).slice(0, 300), at: now() } }).eq("id", id); })); return J({ ok: true }); }
    if (act === "review_all") { const chain = Number(b.chain) || 0; bg((async () => { const lim = Math.min(Number(b.limit) || 40, 60); const d = await reviewPending(lim, !!b.force && chain === 0, Date.now() + 65000); if ((d.left || 0) > 0 && chain < 25) await selfCall({ action: "review_all", limit: d.left, chain: chain + 1, then: b.then }); else if (b.then === "manager2") await selfCall({ action: "manager2" }); else await selfCall({ action: "playbook" }); })()); return J({ ok: true }); }
    if (act === "manager2") { if (!cron) return J({ error: "Not allowed" }, 403); bg(manager2()); return J({ ok: true }); }
    if (act === "autopilot_goal") { if (!cron) return J({ error: "Not allowed" }, 403); const { data: g } = await admin.from("social_goals").select("*").eq("id", Number(b.goal_id)).single(); if (g) bg(weekIdeas(g)); return J({ ok: true }); }
    if (act === "manager3") { if (!cron) return J({ error: "Not allowed" }, 403); bg(manager3()); return J({ ok: true }); }
    if (act === "playbook") { bg(updatePlaybook()); return J({ ok: true }); }
    if (act === "manager") { bg(manager()); return J({ ok: true }); }
    if (act === "ready") { const oa = !!(await secret("openai_key")), an = !!(await secret("anthropic_key")); return J({ ok: true, openai: oa, anthropic: an, engine: await setting("social_ai", "auto"), ai_error: await setting("social_ai_error", "") || null }); }
    if (act === "set_ai_key") { if (!isMgr) return J({ error: "Only admin or founder can change AI keys" }, 403); if (b.provider === "engine") { await admin.from("app_settings").upsert({ key: "social_ai", value: String(b.engine || "auto"), updated_at: now() }); return J({ ok: true }); } const prov = b.provider === "openai" ? "openai_key" : "anthropic_key"; const k = String(b.key || "").trim(); if (!k) await admin.from("app_secrets").delete().eq("key", prov); else { if (prov === "anthropic_key" && !/^sk-ant-/.test(k)) return J({ error: "Claude keys start with sk-ant-" }, 400); if (prov === "openai_key" && !/^sk-/.test(k)) return J({ error: "OpenAI keys start with sk-" }, 400); await admin.from("app_secrets").upsert({ key: prov, value: k }); } if (b.engine) await admin.from("app_settings").upsert({ key: "social_ai", value: String(b.engine), updated_at: now() }); await admin.from("app_settings").delete().eq("key", "social_ai_error"); return J({ ok: true }); }
    if (act === "test") { const t = await ai({ input: "Reply with the single word OK." }); return J({ ok: true, reply: t.slice(0, 20) }); }
    return J({ error: "unknown action" }, 400);
  } catch (e) { return J({ error: String((e as Error).message || e) }, 500); }
});
