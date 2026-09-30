// 인스타그램 게시물 URL → input/ 폴더로 가져오기
//   사용법: node tools/fetch_url.mjs <인스타 게시물 URL> [--clean]
//   결과:   input/01.jpg, 02.jpg ... (게시물 이미지 전부)
//           input/caption_원본.txt   (원본 글)
//   --clean: 가져오기 전에 input/ 을 비운다 (참고디자인/ 폴더와 .gitkeep 은 남긴다)
//
// 실패하면 이유 코드와 쉬운 설명을 출력하고 exit code 1 로 끝난다.
//   PRIVATE(비공개 계정) / LOGIN_REQUIRED(로그인 필요) / VIDEO_ONLY(영상만 있음)
//   NOT_FOUND(없는 게시물) / BAD_URL(인스타 게시물 주소 아님) / NO_MEDIA(이미지를 못 찾음)

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT_DIR = path.join(ROOT, 'input');
const KEEP = new Set(['참고디자인', '.gitkeep']);

const REASONS = {
  BAD_URL: '인스타그램 게시물 주소가 아니에요. instagram.com/p/... 형태의 주소를 주세요.',
  PRIVATE: '비공개 계정의 게시물이라 가져올 수 없어요.',
  LOGIN_REQUIRED: '인스타그램이 로그인을 요구해서 가져올 수 없어요. (로그인 없이 볼 수 있는 게시물이 아니에요)',
  VIDEO_ONLY: '이 게시물은 영상(릴스)만 있어서 카드뉴스 이미지로 가져올 수 없어요.',
  NOT_FOUND: '게시물을 찾을 수 없어요. 삭제됐거나 주소가 잘못됐을 수 있어요.',
  NO_MEDIA: '게시물은 열렸지만 이미지를 찾지 못했어요.',
};

function fail(code, detail) {
  console.error(`실패 [${code}] ${REASONS[code]}${detail ? `\n  (${detail})` : ''}`);
  process.exit(1);
}

// ---------- 인자 ----------
const args = process.argv.slice(2);
const clean = args.includes('--clean');
const url = args.find((a) => !a.startsWith('--'));
if (!url) {
  console.error('사용법: node tools/fetch_url.mjs <인스타 게시물 URL> [--clean]');
  process.exit(1);
}
const m = url.match(/instagram\.com\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
if (!m) fail('BAD_URL', url);
const shortcode = m[2];
const postUrl = `https://www.instagram.com/p/${shortcode}/`;

// ---------- 응답 JSON 에서 게시물 찾기 ----------
// 인스타는 구조가 자주 바뀌어서, JSON 전체를 훑어 shortcode 가 같은 객체를 찾는다.
function findPost(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 40) return null;
  if ((obj.code === shortcode || obj.shortcode === shortcode) &&
      (obj.image_versions2 || obj.carousel_media || obj.display_url || obj.edge_sidecar_to_children)) {
    return obj;
  }
  for (const v of Object.values(obj)) {
    const found = findPost(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// 가장 큰 이미지를 고른다. 크기 정보가 없으면 첫 번째(보통 원본 크기)를 쓴다.
function bestCandidate(iv2, fallback = null) {
  const c = iv2?.candidates ?? [];
  if (c.length === 0) return fallback;
  return c.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a), c[0]).url ?? fallback;
}

// 게시물 객체 → { username, caption, items: [{ url, isVideo }] }
function parsePost(p) {
  const username = p.user?.username ?? p.owner?.username ?? '';
  const caption =
    p.caption?.text ??
    p.edge_media_to_caption?.edges?.[0]?.node?.text ??
    '';
  let items = [];
  if (Array.isArray(p.carousel_media)) {
    items = p.carousel_media.map((c) => ({ url: bestCandidate(c.image_versions2, c.display_uri), isVideo: c.media_type === 2 }));
  } else if (p.edge_sidecar_to_children?.edges) {
    items = p.edge_sidecar_to_children.edges.map((e) => ({ url: e.node.display_url, isVideo: !!e.node.is_video }));
  } else if (p.image_versions2) {
    items = [{ url: bestCandidate(p.image_versions2, p.display_uri), isVideo: p.media_type === 2 }];
  } else if (p.display_url) {
    items = [{ url: p.display_url, isVideo: !!p.is_video }];
  }
  return { username, caption, items: items.filter((i) => i.url) };
}

// ---------- 실행 ----------
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    locale: 'ko-KR',
    viewport: { width: 1280, height: 1600 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  let post = null;
  page.on('response', async (res) => {
    if (post) return;
    const ct = res.headers()['content-type'] ?? '';
    if (!ct.includes('json') && !ct.includes('javascript')) return;
    try {
      const found = findPost(JSON.parse(await res.text()));
      if (found) post = found;
    } catch { /* JSON 아님 */ }
  });

  const resp = await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (resp?.status() === 404) fail('NOT_FOUND', postUrl);
  await page.waitForTimeout(4000);

  if (page.url().includes('/accounts/login')) fail('LOGIN_REQUIRED');

  // 페이지 안에 박혀 있는 JSON 도 확인
  if (!post) {
    const blobs = await page.$$eval('script[type="application/json"]', (els) => els.map((e) => e.textContent));
    for (const b of blobs) {
      try { post = findPost(JSON.parse(b)); } catch { /* 무시 */ }
      if (post) break;
    }
  }

  // 그래도 없으면 공개 임베드 페이지로 한 번 더
  if (!post) {
    await page.goto(`${postUrl}embed/captioned/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    const blobs = await page.$$eval('script', (els) => els.map((e) => e.textContent ?? ''));
    for (const b of blobs) {
      const i = b.indexOf('{');
      if (i < 0 || !b.includes(shortcode)) continue;
      // contextJSON 처럼 문자열로 한 번 더 감싼 JSON 도 풀어 본다
      for (const mm of b.matchAll(/"contextJSON":("(?:[^"\\]|\\.)*")/g)) {
        try { post = findPost(JSON.parse(JSON.parse(mm[1]))); } catch { /* 무시 */ }
        if (post) break;
      }
      if (post) break;
    }
  }

  const bodyText = (await page.textContent('body').catch(() => '')) ?? '';
  if (!post) {
    if (/비공개 계정|This account is private|This Account is Private/i.test(bodyText)) fail('PRIVATE');
    if (/페이지를 사용할 수 없습니다|링크가 잘못되었거나 게시물이 삭제|isn't available|not available|link is broken|may have been removed/i.test(bodyText)) fail('NOT_FOUND');
    if (/로그인|Log in/i.test(bodyText) && !bodyText.includes(shortcode)) fail('LOGIN_REQUIRED');
    fail('NO_MEDIA', '인스타 페이지 구조가 바뀌었을 수 있어요');
  }

  const { username, caption, items } = parsePost(post);
  if (items.length === 0) fail('NO_MEDIA');
  if (items.every((i) => i.isVideo)) fail('VIDEO_ONLY');

  // ---------- 저장 ----------
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  if (clean) {
    for (const name of fs.readdirSync(INPUT_DIR)) {
      if (!KEEP.has(name)) fs.rmSync(path.join(INPUT_DIR, name), { recursive: true, force: true });
    }
  }

  let n = 0;
  const videoNos = [];
  for (const item of items) {
    n += 1;
    const file = `${String(n).padStart(2, '0')}.jpg`;
    const r = await context.request.get(item.url);
    if (!r.ok()) throw new Error(`이미지 다운로드 실패 (${r.status()}): ${file}`);
    fs.writeFileSync(path.join(INPUT_DIR, file), await r.body());
    if (item.isVideo) videoNos.push(file);
  }

  const header = [`출처: ${postUrl}`, username ? `작성자: @${username}` : null].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(INPUT_DIR, 'caption_원본.txt'), `${header}\n\n${caption}\n`, 'utf8');

  console.log(`완료: 이미지 ${n}장 + caption_원본.txt → input/`);
  if (videoNos.length) console.log(`참고: ${videoNos.join(', ')} 는 영상의 표지 이미지예요.`);
} catch (e) {
  console.error(`실패 [ERROR] 가져오는 중 문제가 생겼어요: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
