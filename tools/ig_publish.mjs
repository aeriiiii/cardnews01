// 카드뉴스 시리즈 → 내 인스타그램 캐러셀 발행 (Instagram API with Instagram Login, graph.instagram.com)
//
//   미리보기: node tools/ig_publish.mjs <시리즈폴더명>          ← 아무것도 올리지 않고 장수·파일·캡션만 보여준다
//   발행:     node tools/ig_publish.mjs <시리즈폴더명> --yes    ← 사용자가 "진행"이라고 답한 뒤에만
//   (--force: 이미 발행한 시리즈를 다시 올릴 때)
//
//   1) 폴더의 card_*.png 전부를 파일명 순서대로 JPEG 로 바꾼다 (인스타 API 는 JPEG 만 받는다)
//   2) 임시 공개 주소에 올린다 (API 는 인터넷 주소의 이미지만 가져간다)
//        litterbox.catbox.moe — 1시간 뒤 자동 삭제 (0x0.st 는 업로드 중단, 2026-09)
//   3) 카드별 컨테이너 → 캐러셀 컨테이너(caption.txt) → 준비 확인 → 발행
//   4) 결과를 <시리즈폴더>/published.json 에 남긴다 (같은 시리즈 중복 발행 방지)
//   토큰은 .env 에서 읽고 화면에 출력하지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://graph.instagram.com/v23.0';
const HOST = 'https://litterbox.catbox.moe/resources/internals/api.php';
const UA = 'cardnews-publisher/1.0';

function fail(msg) { console.error(`실패: ${msg}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 입력 ----------
const args = process.argv.slice(2);
const yes = args.includes('--yes');
const force = args.includes('--force');
const name = (args.find((a) => !a.startsWith('--')) || '').replace(/^output[\\/]/, '').replace(/[\\/]+$/, '');
if (!name) fail('사용법: node tools/ig_publish.mjs <시리즈폴더명> [--yes]');
const dir = path.join(ROOT, 'output', name);
if (!fs.existsSync(dir)) fail(`시리즈 폴더가 없어요: output/${name}`);

const pngs = fs.readdirSync(dir).filter((f) => /^card_\d+.*\.png$/i.test(f)).sort();
if (pngs.length < 2) fail(`캐러셀에는 PNG 가 2장 이상 필요해요 (지금 ${pngs.length}장).`);
if (pngs.length > 10) fail(`캐러셀은 10장까지만 돼요 (지금 ${pngs.length}장).`);
const captionFile = path.join(dir, 'caption.txt');
const caption = fs.existsSync(captionFile) ? fs.readFileSync(captionFile, 'utf8').trim() : '';
if (!caption) fail('caption.txt 가 없거나 비어 있어요.');
if (caption.length > 2200) fail(`캡션이 2200자를 넘어요 (${caption.length}자).`);
const tags = (caption.match(/#[^\s#]+/g) || []).length;
if (tags > 30) fail(`해시태그가 30개를 넘어요 (${tags}개).`);

const record = path.join(dir, 'published.json');
if (fs.existsSync(record) && !force) {
  const r = JSON.parse(fs.readFileSync(record, 'utf8'));
  fail(`이미 발행한 시리즈예요: ${r.permalink || r.media_id}  (다시 올리려면 --force)`);
}

// ---------- 미리보기 ----------
if (!yes) {
  console.log(`[미리보기] output/${name}`);
  console.log(`카드 ${pngs.length}장: ${pngs.join(', ')}`);
  console.log(`캡션 ${caption.length}자, 해시태그 ${tags}개`);
  console.log('----- caption.txt -----');
  console.log(caption);
  console.log('-----------------------');
  console.log('아직 아무것도 올리지 않았어요. 발행하려면 --yes 를 붙여 다시 실행하세요.');
  process.exit(0);
}

// 내 컴퓨터: .env 파일 / 클라우드: 환경변수(비밀 설정)
const envFile = path.join(ROOT, '.env');
const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const fromEnv = (k) => process.env[k]?.trim() || (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
const TOKEN = fromEnv('IG_ACCESS_TOKEN');
const USER = fromEnv('IG_USER_ID');
if (!TOKEN || !USER) fail('IG_ACCESS_TOKEN 과 IG_USER_ID 가 필요해요 (.env 또는 환경변수). 먼저 node tools/ig_check.mjs 를 실행하세요.');

async function ig(method, pathname, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = method === 'GET' ? `${API}${pathname}?${body}` : `${API}${pathname}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`${e.error_user_msg || e.message || `HTTP ${res.status}`}${e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''}`);
  }
  return data;
}

async function waitReady(id, label) {
  for (let i = 0; i < 60; i++) {
    const { status_code, status } = await ig('GET', `/${id}`, { fields: 'status_code,status' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`${label} 준비 실패: ${status || status_code}`);
    await sleep(3000);
  }
  throw new Error(`${label} 준비가 3분 안에 끝나지 않았어요.`);
}

// ---------- 1) PNG → JPEG ----------
console.log(`1/4 PNG ${pngs.length}장을 JPEG 로 변환`);
const jpegs = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  for (const f of pngs) {
    const b64 = fs.readFileSync(path.join(dir, f)).toString('base64');
    await page.setContent(`<html><body style="margin:0"><img src="data:image/png;base64,${b64}" style="display:block;width:1080px;height:1350px"></body></html>`);
    await page.waitForFunction(() => document.images[0]?.complete);
    jpegs.push({ name: f.replace(/\.png$/i, '.jpg'), data: await page.screenshot({ type: 'jpeg', quality: 95 }) });
  }
} finally {
  await browser.close();
}

// ---------- 2) 임시 공개 주소 ----------
const uploaded = []; // { url }
async function cleanup() {
  if (uploaded.length) console.log(`임시 파일 ${uploaded.length}개는 litterbox 에서 1시간 뒤 자동 삭제돼요.`);
}

let exitCode = 0;
try {
  console.log('2/4 임시 공개 주소 만들기 (litterbox.catbox.moe, 1시간 뒤 자동 삭제)');
  // litterbox 는 가끔 일시적인 서버 오류(5xx)를 낸다 → 쉬었다가 최대 3번 시도
  async function uploadOnce(j) {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', '1h');
    form.append('fileToUpload', new Blob([j.data], { type: 'image/jpeg' }), j.name);
    const res = await fetch(HOST, { method: 'POST', body: form, headers: { 'User-Agent': UA } }).catch(() => null);
    if (!res) return { ok: false, retry: true, why: '임시 호스팅에 연결하지 못했어요' };
    const body = (await res.text()).trim();
    if (res.ok && /^https:\/\/\S+\.jpe?g$/i.test(body)) return { ok: true, url: body };
    const why = /^</.test(body) ? `임시 호스팅 서버 오류 (HTTP ${res.status})` : `HTTP ${res.status} ${body.slice(0, 80)}`;
    return { ok: false, retry: res.status >= 500 || res.status === 429, why };
  }
  for (const j of jpegs) {
    let r;
    for (let attempt = 1; attempt <= 3; attempt++) {
      r = await uploadOnce(j);
      if (r.ok || !r.retry) break;
      if (attempt < 3) { console.log(`  ${j.name}: ${r.why} → ${attempt * 5}초 뒤 다시 시도`); await sleep(attempt * 5000); }
    }
    if (!r.ok) throw new Error(`임시 호스팅 업로드 실패 (${j.name}): ${r.why}. 3번 시도했어요. 잠시 뒤 다시 눌러 주세요.`);
    const url = r.url;
    uploaded.push({ url });
    const check = await fetch(url, { headers: { 'User-Agent': UA } });
    const type = check.headers.get('content-type') || '';
    await check.arrayBuffer();
    if (!check.ok || !/image\/jpe?g/.test(type)) throw new Error(`임시 주소가 JPEG 로 열리지 않아요: ${url} (${type})`);
  }

  // ---------- 3) 컨테이너 ----------
  console.log('3/4 인스타 컨테이너 만들기');
  const children = [];
  for (const [i, u] of uploaded.entries()) {
    const { id } = await ig('POST', `/${USER}/media`, { image_url: u.url, is_carousel_item: 'true' });
    await waitReady(id, `${i + 1}번 카드`);
    children.push(id);
  }
  const { id: carousel } = await ig('POST', `/${USER}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
  await waitReady(carousel, '캐러셀');

  // ---------- 4) 발행 ----------
  console.log('4/4 발행');
  const { id: mediaId } = await ig('POST', `/${USER}/media_publish`, { creation_id: carousel });
  const info = await ig('GET', `/${mediaId}`, { fields: 'permalink,timestamp' }).catch(() => ({}));
  fs.writeFileSync(record, JSON.stringify({
    media_id: mediaId,
    permalink: info.permalink || null,
    published_at: info.timestamp || new Date().toISOString(),
    cards: pngs,
  }, null, 2), 'utf8');
  console.log(`발행 완료: ${info.permalink || `media_id ${mediaId}`}`);
} catch (e) {
  console.error(`실패: ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
