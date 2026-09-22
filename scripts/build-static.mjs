#!/usr/bin/env node
/**
 * ZISHU TRON INSIGHT — static site builder
 *
 * - Fetches published articles from Firebase Realtime Database
 * - Generates one static HTML page per article in /articles/<slug>/
 * - Injects homepage SSR HTML into index.html (between markers)
 * - Generates /articles-index.json (for search)
 * - Generates sitemap.xml, rss.xml, 404.html
 *
 * This is what makes the site crawlable by AI crawlers (which don't run JS).
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------- Config ----------
const FIREBASE_DB = (process.env.FIREBASE_DB_URL || 'https://stardust-official-default-rtdb.firebaseio.com')
  .trim()
  .replace(/\/+$/, '');
const BASE_URL = (process.env.SITE_BASE_URL || 'https://zishutron.github.io/zishu-insight')
  .trim()
  .replace(/\/+$/, '');

const SITE_NAME = 'ZISHU TRON INSIGHT';
const SITE_DESCRIPTION = 'The official publishing platform of ZISHU TRON. Product announcements, engineering deep dives, and company updates.';
const MAX_RELATED = 3;
const MAX_HOMEPAGE_ARTICLES = 50;
const DEFAULT_AUTHOR = 'ZISHU TRON';
const TEMPLATE_PATH = join(ROOT, 'article.html');
const INDEX_HTML_PATH = join(ROOT, 'index.html');
const ARTICLES_DIR = join(ROOT, 'articles');

// ---------- Helpers ----------
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const escapeXml = (s) => String(s ?? '').replace(/[<>&'"]/g, c => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
}[c]));

const slugify = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s-]/g, '')
  .trim()
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 90);

function estimateReadingTime(html){
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  return Math.max(1, Math.round(words / 220));
}

function formatDate(ts){
  if(!ts) return '';
  return new Date(ts).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});
}

function truncate(str, n){
  if(!str) return '';
  return str.length > n ? str.slice(0, n-1).trim() + '…' : str;
}

// ---------- Firebase REST ----------
async function fetchPublishedPosts(){
  const url = `${FIREBASE_DB}/posts.json?orderBy="status"&equalTo="published"`;
  const res = await fetch(url);
  if(!res.ok){
    const text = await res.text().catch(() => '');
    throw new Error(`Firebase fetch failed: ${res.status} ${res.statusText} ${text}`);
  }
  const data = await res.json() || {};
  return Object.entries(data).map(([id, p]) => ({ id, ...p }));
}

// ---------- Server-side sanitizer ----------
function sanitizeServerSide(html){
  let out = String(html || '');
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|input|button|noscript|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|input|button|noscript|link|meta)[^>]*\/?>/gi, '');
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  out = out.replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"');
  out = out.replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
  return out;
}

// ---------- Markdown inline formatting ----------
function transformMarkdownFormatting(html){
  let out = String(html || '');
  const codePlaceholders = [];
  out = out.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, (m) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(m);
    return `\u0000CODEBLOCK${idx}\u0000`;
  });
  out = out.replace(/<code>([\s\S]*?)<\/code>/gi, (m) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(m);
    return `\u0000CODEINLINE${idx}\u0000`;
  });
  out = out.replace(/==([^=\n]+?)==/g, '<mark>$1</mark>');
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  out = out.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codePlaceholders[Number(i)]);
  out = out.replace(/\u0000CODEINLINE(\d+)\u0000/g, (_, i) => codePlaceholders[Number(i)]);
  return out;
}

// ---------- Link cards ----------
function transformLinksToCards(html){
  const lines = html.split('\n');
  const out = [];
  for(const line of lines){
    const trimmed = line.trim();
    const mdMatch = trimmed.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if(mdMatch){ out.push(makeLinkCard(mdMatch[2], mdMatch[1])); continue; }
    const bareInP = trimmed.match(/^<p>\s*(https?:\/\/[^\s<]+)\s*<\/p>$/i);
    if(bareInP){ out.push(makeLinkCard(bareInP[1])); continue; }
    const bare = trimmed.match(/^(https?:\/\/[^\s<]+)$/);
    if(bare){ out.push(makeLinkCard(bare[1])); continue; }
    out.push(line);
  }
  return out.join('\n');
}

function makeLinkCard(url, customLabel){
  let label = customLabel || '';
  let icon = '🌐';
  let title = label;
  const displayUrl = url;
  try{
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;
    if(!title){
      if(path && path !== '/'){
        const parts = path.split('/').filter(Boolean);
        const last = parts[parts.length - 1];
        if(last && !last.includes('.')) title = last.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        else title = host;
      } else title = host;
    }
    if(/\.apk($|\?)/i.test(url) || /apk/i.test(url)){ label = label || 'Android App'; icon = '📱'; }
    else if(/play\.google\.com/i.test(host)){ label = label || 'Google Play'; icon = '▶'; }
    else if(/apps\.apple\.com/i.test(host)){ label = label || 'App Store'; icon = '🍎'; }
    else if(/github\.com/i.test(host)){ label = label || 'GitHub'; icon = '⚡'; }
    else if(/\.(zip|tar|gz|dmg|exe)($|\?)/i.test(url) || /download/i.test(url)){ label = label || 'Download'; icon = '⬇'; }
    else if(host.includes('zishu') || host.includes('zishutron')){ label = label || 'Official Website'; icon = '🌐'; }
    else { label = label || 'Website'; icon = '🌐'; }
  }catch(e){ label = label || 'Link'; }
  const arrowSvg = `<svg class="lc-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
  return `<a class="link-card" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">`
    + `<div class="lc-icon" aria-hidden="true">${icon}</div>`
    + `<div class="lc-body">`
      + `<div class="lc-label">${escapeHtml(label)}</div>`
      + `<div class="lc-title">${escapeHtml(title)}</div>`
      + `<div class="lc-url">${escapeHtml(displayUrl)}</div>`
    + `</div>` + arrowSvg + `</a>`;
}

// ---------- Template renderer ----------
function renderTemplate(tpl, data){
  let out = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => data[key] ? inner : '');
  out = out.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => data[key] ? '' : inner);
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = data[key];
    return v === undefined || v === null ? '' : String(v);
  });
  return out;
}

// ---------- Render one article page ----------
async function renderArticle(post, tpl, allPosts){
  const slug = post.slug || slugify(post.title || post.id);
  const canonical = `${BASE_URL}/articles/${slug}/`;
  const publishedAt = post.publishedAt || post.createdAt || Date.now();
  const updatedAt = post.updatedAt || publishedAt;
  const author = post.authorName || DEFAULT_AUTHOR;
  const description = post.description || String(post.content || '').replace(/<[^>]+>/g,'').slice(0, 200).trim();
  const readingTime = post.readingTime || estimateReadingTime(post.content);

  const tagsArr = Array.isArray(post.tags) ? post.tags
    : (post.tags && typeof post.tags === 'object' ? Object.values(post.tags) : []);
  const tagsHtml = tagsArr.length ? tagsArr.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('') : '';

  let related = allPosts.filter(p => p.id !== post.id && p.slug);
  if(post.category){
    const sameCat = related.filter(p => p.category === post.category);
    if(sameCat.length) related = [...sameCat, ...related.filter(p => p.category !== post.category)];
  }
  related = related.sort((a,b) => (b.publishedAt||b.createdAt||0) - (a.publishedAt||a.createdAt||0)).slice(0, MAX_RELATED);
  const relatedHtml = related.map(p => `
    <a class="rel-card" href="../../articles/${encodeURIComponent(p.slug)}/">
      <h3>${escapeHtml(p.title || 'Untitled')}</h3>
      <p>${escapeHtml((p.description || '').slice(0, 140))}</p>
      <div class="m">${formatDate(p.publishedAt || p.createdAt)} · ${p.readingTime || estimateReadingTime(p.content)} min read</div>
    </a>`).join('');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": post.title,
    "description": description,
    "author": { "@type": "Person", "name": author },
    "publisher": { "@type": "Organization", "name": "ZISHU TRON", "url": BASE_URL + "/" },
    "datePublished": new Date(publishedAt).toISOString(),
    "dateModified": new Date(updatedAt).toISOString(),
    "mainEntityOfPage": { "@type": "WebPage", "@id": canonical },
    "url": canonical,
    "wordCount": String(post.content || '').replace(/<[^>]+>/g,' ').split(/\s+/).filter(Boolean).length
  };
  if(post.coverImage) jsonLd.image = [post.coverImage];
  if(post.category) jsonLd.articleSection = post.category;
  if(tagsArr.length) jsonLd.keywords = tagsArr.join(', ');

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": BASE_URL + "/" },
      ...(post.category ? [{ "@type": "ListItem", "position": 2, "name": post.category, "item": `${BASE_URL}/#${slugify(post.category)}` }] : []),
      { "@type": "ListItem", "position": post.category ? 3 : 2, "name": post.title, "item": canonical }
    ]
  };

  const rawContent = post.content || '';
  const safeContent = sanitizeServerSide(rawContent);
  const formattedContent = transformMarkdownFormatting(safeContent);
  const finalContent = transformLinksToCards(formattedContent);

  const data = {
    TITLE: escapeHtml(post.title || ''),
    DESCRIPTION: escapeHtml(description),
    CANONICAL_URL: canonical,
    CANONICAL_URL_ENCODED: encodeURIComponent(canonical),
    TITLE_ENCODED: encodeURIComponent(post.title || ''),
    ROBOTS: 'index,follow,max-image-preview:large,max-snippet:-1',
    AUTHOR: escapeHtml(author),
    PUBLISHED_ISO: new Date(publishedAt).toISOString(),
    PUBLISHED_HUMAN: new Date(publishedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}),
    UPDATED_ISO: new Date(updatedAt).toISOString(),
    UPDATED_HUMAN: updatedAt !== publishedAt ? new Date(updatedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : '',
    CATEGORY: post.category ? escapeHtml(post.category) : '',
    COVER_IMAGE: post.coverImage ? escapeHtml(post.coverImage) : '',
    READING_TIME: String(readingTime),
    CONTENT_HTML: finalContent,
    TAGS_HTML: tagsHtml,
    RELATED_HTML: relatedHtml,
    JSONLD: JSON.stringify([jsonLd, breadcrumbLd])
  };

  const html = renderTemplate(tpl, data);

  return {
    html, slug, canonical,
    id: post.id,
    title: post.title || 'Untitled',
    description,
    category: post.category || '',
    tags: tagsArr,
    author,
    readingTime,
    coverImage: post.coverImage || '',
    publishedAt,
    updatedAt,
    pinned: !!post.pinned
  };
}

// ---------- Homepage SSR rendering ----------
function renderHomepageCards(articles){
  const nonPinned = articles.filter(a => !a.pinned);
  if(nonPinned.length === 0) return '';
  return nonPinned.map(a => {
    const url = `articles/${encodeURIComponent(a.slug)}/`;
    const tag = a.category ? `<span class="tag">${escapeHtml(a.category)}</span>` : '';
    const hasImage = !!a.coverImage;
    const thumb = hasImage
      ? `<div class="card-thumb" aria-hidden="true"><img src="${escapeHtml(a.coverImage)}" alt="" loading="lazy" decoding="async"></div>`
      : '';
    return `
      <a class="card${hasImage ? '' : ' no-image'}" href="${escapeHtml(url)}">
        <div class="card-body">
          ${tag}
          <h3>${escapeHtml(a.title)}</h3>
          <p class="excerpt">${escapeHtml(truncate(a.description || '', 220))}</p>
          <div class="meta">
            <span>${escapeHtml(a.author || 'ZISHU TRON')}</span>
            <span class="dot">·</span>
            <span>${formatDate(a.publishedAt)}</span>
            <span class="dot">·</span>
            <span>${a.readingTime || 1} min read</span>
          </div>
        </div>
        ${thumb}
      </a>`;
  }).join('\n');
}

function renderHomepagePinned(articles){
  const pinned = articles.find(a => a.pinned);
  if(!pinned) return '';
  const url = `articles/${encodeURIComponent(pinned.slug)}/`;
  const hasImage = !!pinned.coverImage;
  const img = hasImage
    ? `<div class="pinned-img"><img src="${escapeHtml(pinned.coverImage)}" alt="" loading="eager"></div>`
    : '';
  const cat = pinned.category ? `<span class="pinned-cat">${escapeHtml(pinned.category)}</span>` : '';
  const pinIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
  return `
    <a class="pinned-card${hasImage ? '' : ' no-image'}" href="${escapeHtml(url)}">
      <div class="pinned-body">
        <span class="pinned-badge">${pinIcon} Pinned</span>
        ${cat}
        <h2>${escapeHtml(pinned.title)}</h2>
        <p>${escapeHtml(truncate(pinned.description || '', 220))}</p>
        <div class="pinned-meta">By ${escapeHtml(pinned.author || 'ZISHU TRON')} · ${formatDate(pinned.publishedAt)} · ${pinned.readingTime || 1} min read</div>
      </div>
      ${img}
    </a>`;
}

// ---------- Sitemap / RSS / index ----------
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
  const items = articles.sort((a,b) => b.publishedAt - a.publishedAt).slice(0, 30).map(a => `    <item>
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
  const idx = articles.sort((a,b) => b.publishedAt - a.publishedAt).map(a => ({
    id: a.id, slug: a.slug, title: a.title, description: a.description,
    category: a.category || '', tags: a.tags || [], coverImage: a.coverImage || '',
    authorName: a.author, publishedAt: a.publishedAt, readingTime: a.readingTime,
    pinned: !!a.pinned
  }));
  return { generatedAt: new Date().toISOString(), count: idx.length, articles: idx };
}

const FALLBACK_404 = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not found — ZISHU TRON INSIGHT</title><meta name="robots" content="noindex"><link rel="canonical" href="${BASE_URL}/"><style>body{font-family:-apple-system,system-ui,sans-serif;background:#fafaf9;color:#0c0a09;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}a{color:#d97706}h1{font-size:2rem;margin-bottom:8px;font-family:Georgia,serif}p{color:#78716c}</style></head><body><div><h1>404 — Not found</h1><p>This article may have been moved or unpublished.</p><p style="margin-top:20px"><a href="${BASE_URL}/">← Back to ZISHU TRON INSIGHT</a></p></div></body></html>`;

// ---------- Main ----------
async function main(){
  console.log('[build] Fetching published articles…');
  console.log(`[build] Firebase: ${FIREBASE_DB}`);
  console.log(`[build] Base URL: ${BASE_URL}`);

  const posts = await fetchPublishedPosts();
  console.log(`[build] ${posts.length} published article(s)`);

  const tpl = await readFile(TEMPLATE_PATH, 'utf8');

  // Clean previous generated article dirs
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
    rendered.push(out);
    process.stdout.write(`  ✓ /articles/${out.slug}/\n`);
  }

  // ===== Write index JSON, sitemap, rss, 404 =====
  await writeFile(join(ROOT, 'articles-index.json'), JSON.stringify(buildIndex(rendered), null, 2), 'utf8');
  await writeFile(join(ROOT, 'sitemap.xml'), buildSitemap(rendered), 'utf8');
  await writeFile(join(ROOT, 'rss.xml'), buildRss(rendered), 'utf8');
  await writeFile(join(ROOT, '404.html'), FALLBACK_404, 'utf8');

  // ===== SSR injection into index.html =====
  console.log('[build] Injecting SSR HTML into index.html…');
  let homeHtml = await readFile(INDEX_HTML_PATH, 'utf8');

  // Sort articles: newest first
  const sortedRendered = [...rendered].sort((a,b) => b.publishedAt - a.publishedAt).slice(0, MAX_HOMEPAGE_ARTICLES);

  // 1) Pinned slot
  const pinnedHtml = renderHomepagePinned(sortedRendered);
  const pinnedReplaced = homeHtml.replace(
    /<!-- PINNED_START -->[\s\S]*?<!-- PINNED_END -->/,
    `<!-- PINNED_START -->\n${pinnedHtml}\n<!-- PINNED_END -->`
  );
  if(pinnedReplaced === homeHtml && pinnedHtml){
    console.warn('[build] WARNING: PINNED markers not found in index.html — skipping pinned injection');
  }
  homeHtml = pinnedReplaced;

  // 2) Articles feed
  const cardsHtml = renderHomepageCards(sortedRendered);
  const cardsReplaced = homeHtml.replace(
    /<!-- ARTICLES_START -->[\s\S]*?<!-- ARTICLES_END -->/,
    `<!-- ARTICLES_START -->\n${cardsHtml}\n<!-- ARTICLES_END -->`
  );
  if(cardsReplaced === homeHtml && cardsHtml){
    console.warn('[build] WARNING: ARTICLES markers not found in index.html — skipping cards injection');
  }
  homeHtml = cardsReplaced;

  await writeFile(INDEX_HTML_PATH, homeHtml, 'utf8');
  console.log(`[build] Homepage SSR injected (${sortedRendered.length} articles)`);

  console.log(`[build] Done. ${rendered.length} article page(s) written.`);
}

main().catch((e) => {
  console.error('[build] FAILED:', e);
  process.exit(1);
});
