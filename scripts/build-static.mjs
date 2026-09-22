#!/usr/bin/env node
/**
 * ZISHU TRON INSIGHT — static site builder
 *
 * Reads published articles from Firebase Realtime Database and writes:
 *   /articles/<slug>/index.html   — one static page per article
 *   /articles-index.json          — lightweight index for homepage + search
 *   /sitemap.xml                  — all public URLs
 *   /rss.xml                      — recent 30 articles
 *   /404.html                     — SPA-ish fallback
 *
 * Runs in Node 18+. Uses the Firebase REST API (no Admin SDK needed → no
 * privileged credentials stored anywhere in the repo or client).
 *
 * Invoked by .github/workflows/publish.yml (cron + manual dispatch).
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const FIREBASE_DB = process.env.FIREBASE_DB_URL || 'https://stardust-official-default-rtdb.firebaseio.com';
const BASE_URL = process.env.SITE_BASE_URL || 'https://zishutron.github.io/zishu-insight';
const SITE_NAME = 'ZISHU TRON INSIGHT';
const SITE_DESCRIPTION = 'The official publishing platform of ZISHU TRON. Product announcements, engineering deep dives, and company updates.';
const MAX_RELATED = 3;
const DEFAULT_AUTHOR = 'ZISHU TRON';
const TEMPLATE_PATH = join(ROOT, 'article.html');
const ARTICLES_DIR = join(ROOT, 'articles');

// ---------- helpers ----------
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const escapeXml  = (s) => String(s ?? '').replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,90);

function estimateReadingTime(html){
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  return Math.max(1, Math.round(words / 220));
}

// ---------- Firebase REST ----------
async function fetchPublishedPosts(){
  const url = `${FIREBASE_DB}/posts.json?orderBy="status"&equalTo="published"`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`Firebase fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json() || {};
  return Object.entries(data).map(([id, p]) => ({ id, ...p }));
}

// ---------- Template rendering (tiny mustache-like engine) ----------
function renderTemplate(tpl, data){
  // Handle {{#KEY}}...{{/KEY}} conditionals and {{^KEY}}...{{/KEY}} inverted
  let out = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
    const val = data[key];
    if(!val) return '';
    if(Array.isArray(val)) return val.map(() => inner).join(''); // not used here
    return inner;
  });
  out = out.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
    return data[key] ? '' : inner;
  });
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(data[key] ?? ''));
  return out;
}

// ---------- Generate one article page ----------
async function renderArticle(post, tpl, allPosts){
  const slug = post.slug || slugify(post.title || post.id);
  const canonical = `${BASE_URL}/articles/${slug}/`;
  const publishedAt = post.publishedAt || post.createdAt || Date.now();
  const updatedAt = post.updatedAt || publishedAt;
  const author = post.authorName || DEFAULT_AUTHOR;
  const description = post.description || String(post.content || '').replace(/<[^>]+>/g,'').slice(0, 200).trim();
  const readingTime = post.readingTime || estimateReadingTime(post.content);

  // tags
  const tagsArr = Array.isArray(post.tags) ? post.tags
    : (post.tags && typeof post.tags === 'object' ? Object.values(post.tags) : []);
  const tagsHtml = tagsArr.length
    ? tagsArr.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')
    : '';

  // related articles (same category, exclude self, up to MAX_RELATED)
  let related = allPosts.filter(p => p.id !== post.id && p.slug);
  if(post.category){
    const sameCat = related.filter(p => p.category === post.category);
    if(sameCat.length) related = [...sameCat, ...related.filter(p => p.category !== post.category)];
  }
  related = related.sort((a,b) => (b.publishedAt||b.createdAt||0) - (a.publishedAt||a.createdAt||0)).slice(0, MAX_RELATED);
  const relatedHtml = related.map(p => `
    <a class="rel-card" href="../../articles/${encodeURIComponent(p.slug)}/">
      <h3>${escapeHtml(p.title || 'Untitled')}</h3>
      <p>${escapeHtml((p.description || '').slice(0,140))}</p>
      <div class="m">${new Date(p.publishedAt || p.createdAt || Date.now()).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'})} · ${p.readingTime || estimateReadingTime(p.content)} min read</div>
    </a>`).join('');

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": post.title,
    "description": description,
    "image": post.coverImage ? [post.coverImage] : undefined,
    "author": { "@type": "Person", "name": author },
    "publisher": {
      "@type": "Organization",
      "name": "ZISHU TRON",
      "url": BASE_URL + "/"
    },
    "datePublished": new Date(publishedAt).toISOString(),
    "dateModified": new Date(updatedAt).toISOString(),
    "mainEntityOfPage": { "@type": "WebPage", "@id": canonical },
    "url": canonical,
    "articleSection": post.category || undefined,
    "keywords": tagsArr.length ? tagsArr.join(', ') : undefined,
    "wordCount": String(post.content || '').replace(/<[^>]+>/g,' ').split(/\s+/).filter(Boolean).length
  };

  // breadcrumb
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": BASE_URL + "/" },
      ...(post.category ? [{ "@type": "ListItem", "position": 2, "name": post.category, "item": `${BASE_URL}/#${slugify(post.category)}` }] : []),
      { "@type": "ListItem", "position": post.category ? 3 : 2, "name": post.title, "item": canonical }
    ]
  };

  const data = {
    TITLE: post.title,
    DESCRIPTION: description,
    CANONICAL_URL: canonical,
    CANONICAL_URL_ENCODED: encodeURIComponent(canonical),
    TITLE_ENCODED: encodeURIComponent(post.title),
    ROBOTS: 'index,follow,max-image-preview:large,max-snippet:-1',
    AUTHOR: author,
    PUBLISHED_ISO: new Date(publishedAt).toISOString(),
    PUBLISHED_HUMAN: new Date(publishedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}),
    UPDATED_ISO: new Date(updatedAt).toISOString(),
    UPDATED_HUMAN: updatedAt !== publishedAt ? new Date(updatedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : '',
    CATEGORY: post.category || '',
    COVER_IMAGE: post.coverImage || '',
    READING_TIME: String(readingTime),
    CONTENT_HTML: sanitizeServerSide(post.content || ''),
    TAGS_HTML: tagsHtml,
    RELATED_HTML: relatedHtml,
    JSONLD: JSON.stringify([jsonLd, breadcrumbLd])
  };

  return { html: renderTemplate(tpl, data), slug, canonical, publishedAt, updatedAt, description, title: post.title, category: post.category, tags: tagsArr, author, readingTime, coverImage: post.coverImage || '' };
}

// Basic server-side sanitizer (mirrors client rules; strips scripts & event handlers)
function sanitizeServerSide(html){
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

// ---------- sitemap / rss / 404 ----------
function buildSitemap(articles){
  const now = new Date().toISOString();
  const urls = [
    { loc: `${BASE_URL}/`, lastmod: now, prio: '1.0', freq: 'daily' },
    ...articles.map(a => ({ loc: a.canonical, lastmod: new Date(a.updatedAt).toISOString(), prio: '0.8', freq: 'weekly' }))
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${escapeXml(u.loc)}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.prio}</priority>
  </url>`).join('\n')}
</urlset>`;
}

function buildRss(articles){
  const items = articles
    .sort((a,b) => b.publishedAt - a.publishedAt)
    .slice(0, 30)
    .map(a => `    <item>
      <title>${escapeXml(a.title)}</title>
      <link>${escapeXml(a.canonical)}</link>
      <guid isPermaLink="true">${escapeXml(a.canonical)}</guid>
      <pubDate>${new Date(a.publishedAt).toUTCString()}</pubDate>
      <description>${escapeXml(a.description)}</description>
      ${a.category ? `<category>${escapeXml(a.category)}</category>` : ''}
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(SITE_NAME)}</title>
    <link>${escapeXml(BASE_URL)}/</link>
    <description>${escapeXml(SITE_DESCRIPTION)}</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(BASE_URL)}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

function buildIndex(articles){
  const idx = articles
    .sort((a,b) => b.publishedAt - a.publishedAt)
    .map(a => ({
      id: a.id,
      slug: a.slug,
      title: a.title,
      description: a.description,
      category: a.category || '',
      tags: a.tags || [],
      coverImage: a.coverImage || '',
      authorName: a.author,
      publishedAt: a.publishedAt,
      readingTime: a.readingTime,
      featured: !!a.featured
    }));
  return { generatedAt: new Date().toISOString(), count: idx.length, articles: idx };
}

const FALLBACK_404 = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not found — ZISHU TRON INSIGHT</title><meta name="robots" content="noindex"><link rel="canonical" href="${BASE_URL}/"><style>body{font-family:-apple-system,system-ui,sans-serif;background:#faf9fd;color:#0f0a1f;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}a{color:#3b1e88}h1{font-size:2rem;margin-bottom:8px}p{color:#6b6288}</style></head><body><div><h1>404 — Not found</h1><p>This article may have been moved or unpublished.</p><p style="margin-top:20px"><a href="${BASE_URL}/">← Back to ZISHU TRON INSIGHT</a></p></div></body></html>`;

// ---------- main ----------
async function main(){
  console.log('[build] Fetching published articles…');
  const posts = await fetchPublishedPosts();
  console.log(`[build] ${posts.length} published article(s)`);

  const tpl = await readFile(TEMPLATE_PATH, 'utf8');

  // Clean previous generated article dirs (keep only what we regenerate)
  if(existsSync(ARTICLES_DIR)){
    await rm(ARTICLES_DIR, { recursive: true, force: true });
  }
  await mkdir(ARTICLES_DIR, { recursive: true });

  const rendered = [];
  for(const post of posts){
    if(!post.slug) post.slug = slugify(post.title || post.id);
    const out = await renderArticle(post, tpl, posts);
    const dir = join(ARTICLES_DIR, out.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), out.html, 'utf8');
    rendered.push({ ...out, id: post.id, featured: !!post.featured });
    process.stdout.write(`  ✓ /articles/${out.slug}/\n`);
  }

  // Index for the homepage
  await writeFile(join(ROOT, 'articles-index.json'), JSON.stringify(buildIndex(rendered), null, 2), 'utf8');

  // Sitemap
  await writeFile(join(ROOT, 'sitemap.xml'), buildSitemap(rendered), 'utf8');

  // RSS
  await writeFile(join(ROOT, 'rss.xml'), buildRss(rendered), 'utf8');

  // 404
  await writeFile(join(ROOT, '404.html'), FALLBACK_404, 'utf8');

  console.log(`[build] Done. ${rendered.length} article page(s) written.`);
}

main().catch((e) => {
  console.error('[build] FAILED:', e);
  process.exit(1);
});
