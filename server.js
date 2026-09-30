// 카드뉴스 공장 웹 화면 (내 컴퓨터 전용)
//   실행: node server.js  →  http://localhost:3737
//   - 만들기: 링크면 tools/fetch_url.mjs 로 input/ 을 채운 뒤, claude -p 로 CLAUDE.md 작업 순서대로 제작
//   - 아카이브: output/ 의 시리즈 목록
//   - 상세: 카드 PNG + 캡션 + 수정 요청 (claude -p 로 해당 카드만 고쳐 다시 렌더)

const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = __dirname;
const OUTPUT = path.join(ROOT, 'output');
const PORT = 3737;
const ACCENT = '#005cf0';

// ---------- claude 실행 파일 찾기 ----------
// 1) CLAUDE_BIN 환경변수  2) PATH 의 claude  3) VS Code 확장에 들어 있는 최신 claude.exe
function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  const onPath = which.status === 0 && which.stdout.split(/\r?\n/).find(Boolean);
  if (onPath) return onPath.trim();
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(extDir)) {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const found = fs.readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .map((d) => path.join(extDir, d, 'resources', 'native-binary', exe))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (found[0]) return found[0];
  }
  return null;
}

// claude -p 가 쓸 수 있는 도구. 파일 읽기·쓰기와 렌더(npx playwright)만 허락한다.
const ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(npx -y playwright screenshot:*)', 'Bash(npx playwright screenshot:*)',
  'Bash(mkdir:*)', 'Bash(ls:*)', 'Bash(cp:*)', 'Bash(cat:*)',
];

// ---------- 작업(job) 관리: 한 번에 하나만 ----------
const jobs = new Map();
let currentJobId = null;
const LOG_DIR = path.join(os.tmpdir(), 'cardnews-jobs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function newJob(kind, meta) {
  const id = Date.now().toString(36);
  const job = { id, kind, ...meta, status: 'running', step: '준비 중', activity: '', startedAt: Date.now(), log: path.join(LOG_DIR, `${id}.log`) };
  jobs.set(id, job);
  currentJobId = id;
  return job;
}
function finish(job, patch) {
  Object.assign(job, patch, { endedAt: Date.now() });
  if (currentJobId === job.id) currentJobId = null;
}
const busy = () => currentJobId && jobs.get(currentJobId)?.status === 'running';

// ---------- 도우미 ----------
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hasStyleB = () => /방식\s*B/.test(fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'));
const seriesDirs = () => (fs.existsSync(OUTPUT) ? fs.readdirSync(OUTPUT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
function safeSeries(name) {
  if (!name || name !== path.basename(name) || name.startsWith('.')) return null;
  const dir = path.join(OUTPUT, name);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null;
}
function seriesTitle(dir, name) {
  const cover = fs.readdirSync(dir).find((f) => /^card_01.*\.html$/.test(f));
  if (cover) {
    const m = fs.readFileSync(path.join(dir, cover), 'utf8').match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (m) return m[1].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
  return name.replace(/^\d{4}-\d{2}-\d{2}_?/, '').replace(/_/g, ' ');
}
function seriesInfo(name) {
  const dir = safeSeries(name);
  if (!dir) return null;
  const files = fs.readdirSync(dir);
  const pngs = files.filter((f) => /^card_.*\.png$/.test(f)).sort();
  const v = (f) => Math.floor(fs.statSync(path.join(dir, f)).mtimeMs);
  const date = (name.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || new Date(fs.statSync(dir).mtimeMs).toISOString().slice(0, 10);
  const url = (f) => `/output/${encodeURIComponent(name)}/${encodeURIComponent(f)}?v=${v(f)}`;
  return {
    name, date,
    title: seriesTitle(dir, name),
    mtime: fs.statSync(dir).mtimeMs,
    cover: pngs[0] ? url(pngs[0]) : null,
    cards: pngs.map((f) => ({ file: f, url: url(f) })),
    caption: files.includes('caption.txt') ? fs.readFileSync(path.join(dir, 'caption.txt'), 'utf8') : '',
    published: readPublished(dir),
  };
}
// tools/ig_publish.mjs 가 남기는 발행 기록. 화면에는 링크·시각만 보낸다.
function readPublished(dir) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'published.json'), 'utf8'));
    return { permalink: r.permalink || null, at: r.published_at || null };
  } catch { return null; }
}
// ig_publish.mjs 와 같은 기준으로 캐러셀에 들어갈 PNG 를 센다
const publishablePngs = (dir) => fs.readdirSync(dir).filter((f) => /^card_\d+.*\.png$/i.test(f));

// ---------- claude -p 실행 ----------
function toolActivity(t) {
  const i = t.input || {};
  const base = (p) => (p ? path.basename(String(p)) : '');
  if (t.name === 'Bash') return /playwright screenshot/.test(i.command || '') ? `렌더 중: ${base((i.command.match(/(\S+\.png)/) || [])[1])}` : (i.description || '명령 실행 중');
  if (t.name === 'Write') return `파일 만드는 중: ${base(i.file_path)}`;
  if (t.name === 'Edit') return `파일 고치는 중: ${base(i.file_path)}`;
  if (t.name === 'Read') return /\.(png|jpe?g)$/i.test(i.file_path || '') ? `이미지 확인 중: ${base(i.file_path)}` : `읽는 중: ${base(i.file_path)}`;
  return `${t.name} 사용 중`;
}

function runClaude(job, prompt) {
  return new Promise((resolve) => {
    const bin = findClaude();
    if (!bin) return resolve({ ok: false, error: 'claude 실행 파일을 찾지 못했어요. CLAUDE_BIN 환경변수로 경로를 알려주세요.' });
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS];
    const child = spawn(bin, args, { cwd: ROOT, env, windowsHide: true });
    const log = fs.createWriteStream(job.log, { flags: 'a' });
    let buf = '';
    let result = null;
    child.stdout.on('data', (chunk) => {
      log.write(chunk);
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant') {
            for (const c of ev.message?.content || []) {
              if (c.type === 'tool_use') job.activity = toolActivity(c);
              else if (c.type === 'text' && c.text.trim()) job.activity = c.text.trim().split('\n')[0].slice(0, 90);
            }
          } else if (ev.type === 'result') {
            result = ev;
          }
        } catch { /* 한 줄이 JSON 이 아니면 무시 */ }
      }
    });
    child.stderr.on('data', (chunk) => log.write(chunk));
    child.on('error', (e) => resolve({ ok: false, error: `claude 를 실행하지 못했어요: ${e.message}` }));
    child.on('close', (code) => {
      log.end();
      if (result && !result.is_error && code === 0) resolve({ ok: true, text: result.result || '' });
      else resolve({ ok: false, error: (result && result.result) || `claude 가 중간에 멈췄어요 (종료 코드 ${code}). 기록: ${job.log}` });
    });
    child.stdin.end(prompt, 'utf8');
  });
}

function runFetch(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'fetch_url.mjs'), url, '--clean'], { cwd: ROOT, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: false, out: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }));
  });
}

const HEADLESS = [
  '이 작업은 로컬 웹 화면(server.js)에서 자동으로 실행됐다. 중간에 사람이 대답할 수 없으니 질문하지 말고 끝까지 진행한다.',
  '허락 없이 되돌리기 어려운 일(다른 시리즈 폴더 삭제, templates/ 수정, CLAUDE.md 수정)은 하지 않는다.',
];

function createPrompt({ input, isLink, extra, style }) {
  const folder = `output/${today()}_<주제>/`;
  return [
    ...HEADLESS,
    '',
    'CLAUDE.md 의 "작업 순서"대로 카드뉴스 시리즈 하나를 끝까지 만든다. 단, 다음을 지킨다:',
    isLink
      ? `- 1단계(원본 가져오기)는 이미 끝났다. 원본 링크: ${input}\n  input/ 에 이미지와 caption_원본.txt 가 있다. 다시 가져오지 말고 input/ 의 파일을 전부 직접 열어 본다.`
      : `- 원본 링크 없이 주제만 받았다. 주제: "${input}"\n  input/ 은 쓰지 않는다. 이 주제로 내 채널 규칙에 맞게 내용을 직접 구성한다.`,
    '- 3단계의 허락은 이미 받은 것으로 본다. 구성을 정한 뒤 바로 4단계로 넘어간다.',
    `- 결과물은 새 폴더 ${folder} 에 만든다. 이미 있는 폴더 이름과 겹치면 뒤에 _v2, _v3 을 붙인다. 다른 폴더는 건드리지 않는다.`,
    '- 카드는 templates/ 의 cover.html(표지·마무리), content.html(본문) 틀과 _shared.css 로 만든다.',
    style ? `- 화풍: ${style === 'B' ? '방식 B (일러스트)' : '방식 A (기본)'} — CLAUDE.md 의 해당 규칙을 따른다.` : null,
    extra ? `- 이 시리즈에만 적용할 추가 지침 (CLAUDE.md 와 부딪히면 이 지침이 우선):\n${extra}` : null,
    '',
    '마지막 줄에는 만든 폴더를 정확히 이 형식으로 적는다: FOLDER: output/폴더이름',
  ].filter((l) => l !== null).join('\n');
}

function editPrompt(name, request) {
  return [
    ...HEADLESS,
    '',
    `대상 시리즈: output/${name}/`,
    `수정 요청: ${request}`,
    '',
    '- 요청에 해당하는 카드의 HTML 만 고치고, 고친 카드만 CLAUDE.md 의 렌더 명령으로 다시 PNG 로 렌더한다. 파일명은 바꾸지 않는다.',
    '- 다른 카드, templates/, 다른 시리즈 폴더는 건드리지 않는다. 캡션 수정 요청이면 caption.txt 만 고친다.',
    '- 렌더한 PNG 를 직접 열어 보고, 글자 잘림·어색한 줄바꿈이 있으면 고쳐서 다시 렌더한다.',
    '- 마지막에 무엇을 고쳤는지 한 줄로 적는다.',
  ].join('\n');
}

async function doCreate(job, { input, extra, style }) {
  const isLink = /^https?:\/\//i.test(input);
  if (isLink) {
    job.step = '원본 가져오는 중';
    const f = await runFetch(input);
    if (!f.ok) {
      const reason = (f.out.match(/실패 \[[A-Z_]+\] (.*)/) || [])[1] || f.out.split('\n').pop();
      return finish(job, { status: 'failed', error: '다른 게시물 링크를 넣어주세요.', detail: reason });
    }
    job.fetched = f.out;
  }
  job.step = '카드뉴스 만드는 중';
  const before = new Set(seriesDirs());
  const r = await runClaude(job, createPrompt({ input, isLink, extra, style }));
  if (!r.ok) return finish(job, { status: 'failed', error: '만드는 중에 문제가 생겼어요.', detail: r.error });
  const named = (r.text.match(/FOLDER:\s*output[\\/](\S+?)[\\/]?\s*$/m) || [])[1];
  const fresh = seriesDirs().filter((d) => !before.has(d));
  const folder = (named && safeSeries(named) && named) || fresh[0];
  if (!folder) return finish(job, { status: 'failed', error: '결과 폴더를 찾지 못했어요.', detail: r.text.slice(-500) });
  finish(job, { status: 'done', folder, summary: r.text.replace(/FOLDER:.*$/m, '').trim().split('\n').pop() });
}

async function doEdit(job, name, request) {
  job.step = '수정하는 중';
  const r = await runClaude(job, editPrompt(name, request));
  if (!r.ok) return finish(job, { status: 'failed', error: '수정하는 중에 문제가 생겼어요.', detail: r.error });
  finish(job, { status: 'done', folder: name, summary: r.text.trim().split('\n').pop() });
}

// 발행: 이미 만들어 둔 tools/ig_publish.mjs 를 --yes 로 실행한다.
// 토큰은 그 도구가 .env 에서 직접 읽는다. 서버는 토큰을 읽지도, 화면에 보내지도 않는다.
function doPublish(job, name) {
  return new Promise((resolve) => {
    job.step = '인스타에 올리는 중';
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'ig_publish.mjs'), name, '--yes'], { cwd: ROOT, windowsHide: true });
    let out = '';
    const onData = (d) => {
      out += d.toString('utf8');
      const last = out.trim().split('\n').pop();
      if (/^\d\/4 /.test(last)) job.activity = last;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { finish(job, { status: 'failed', error: '발행 도구를 실행하지 못했어요.', detail: e.message }); resolve(); });
    child.on('close', (code) => {
      const link = (out.match(/발행 완료: (https:\/\/\S+)/) || [])[1];
      const reason = (out.match(/실패: (.*)/) || [])[1];
      if (code === 0 && link) finish(job, { status: 'done', folder: name, permalink: link, summary: link });
      else finish(job, { status: 'failed', folder: name, error: '발행하지 못했어요.', detail: reason || `발행 도구가 멈췄어요 (종료 코드 ${code}).` });
      resolve();
    });
  });
}

// ---------- 서버 ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/output', express.static(OUTPUT, { maxAge: 0 }));
app.use('/templates', express.static(path.join(ROOT, 'templates')));

app.get('/api/config', (req, res) => res.json({ styleB: hasStyleB(), claude: !!findClaude() }));

app.get('/api/series', (req, res) => {
  const list = seriesDirs().filter((d) => !d.startsWith('_')).map(seriesInfo).filter((s) => s && s.cards.length)
    .map(({ caption, cards, ...s }) => ({ ...s, count: cards.length }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime);
  res.json(list);
});

app.get('/api/series/:name', (req, res) => {
  const info = seriesInfo(req.params.name);
  info ? res.json(info) : res.status(404).json({ error: '시리즈를 찾지 못했어요.' });
});

app.post('/api/create', (req, res) => {
  const input = String(req.body.input || '').trim();
  const extra = String(req.body.extra || '').trim();
  const style = hasStyleB() && ['A', 'B'].includes(req.body.style) ? req.body.style : null;
  if (!input) return res.status(400).json({ error: '주제나 원본 링크를 넣어주세요.' });
  if (busy()) return res.status(409).json({ error: '다른 작업이 진행 중이에요. 끝난 뒤에 다시 눌러주세요.', jobId: currentJobId });
  const job = newJob('create', { input });
  doCreate(job, { input, extra, style }).catch((e) => finish(job, { status: 'failed', error: '알 수 없는 문제가 생겼어요.', detail: e.message }));
  res.json({ jobId: job.id });
});

app.post('/api/series/:name/edit', (req, res) => {
  const name = req.params.name;
  const request = String(req.body.request || '').trim();
  if (!safeSeries(name)) return res.status(404).json({ error: '시리즈를 찾지 못했어요.' });
  if (!request) return res.status(400).json({ error: '수정 요청을 적어주세요.' });
  if (busy()) return res.status(409).json({ error: '다른 작업이 진행 중이에요. 끝난 뒤에 다시 눌러주세요.', jobId: currentJobId });
  const job = newJob('edit', { folder: name, request });
  doEdit(job, name, request).catch((e) => finish(job, { status: 'failed', error: '알 수 없는 문제가 생겼어요.', detail: e.message }));
  res.json({ jobId: job.id });
});

app.post('/api/series/:name/publish', (req, res) => {
  const name = req.params.name;
  const dir = safeSeries(name);
  if (!dir) return res.status(404).json({ error: '시리즈를 찾지 못했어요.' });
  const n = publishablePngs(dir).length;
  if (n < 2 || n > 10) return res.status(400).json({ error: `인스타 캐러셀은 2~10장만 됩니다 (지금 ${n}장).` });
  if (!fs.existsSync(path.join(dir, 'caption.txt'))) return res.status(400).json({ error: 'caption.txt 가 없어요.' });
  const pub = readPublished(dir);
  if (pub) return res.status(409).json({ error: '이미 발행한 시리즈예요.', permalink: pub.permalink });
  if (busy()) return res.status(409).json({ error: '다른 작업이 진행 중이에요. 끝난 뒤에 다시 눌러주세요.', jobId: currentJobId });
  const job = newJob('publish', { folder: name });
  doPublish(job, name).catch((e) => finish(job, { status: 'failed', error: '알 수 없는 문제가 생겼어요.', detail: e.message }));
  res.json({ jobId: job.id });
});

const publicJob = (j) => j && ({ id: j.id, kind: j.kind, status: j.status, step: j.step, activity: j.activity, folder: j.folder, input: j.input, request: j.request, error: j.error, detail: j.detail, summary: j.summary, permalink: j.permalink, elapsed: Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000) });
app.get('/api/jobs/current', (req, res) => res.json(busy() ? publicJob(jobs.get(currentJobId)) : null));
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  j ? res.json(publicJob(j)) : res.status(404).json({ error: '작업을 찾지 못했어요.' });
});

app.get('/', (req, res) => res.type('html').send(PAGE));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`카드뉴스 공장: http://localhost:${PORT}`);
  console.log(`claude: ${findClaude() || '찾지 못함 (CLAUDE_BIN 으로 지정)'}`);
});

// ---------- 화면 (한 페이지, #/ 주소로 이동) ----------
const PAGE = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>카드뉴스 공장</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>
  :root {
    --accent: ACCENT_COLOR;
    --accent-soft: color-mix(in srgb, var(--accent) 10%, white);
    --text: #16181d;
    --muted: #6b7079;
    --line: #e6e4df;
    --bg: #f7f6f3;
    --card: #ffffff;
    --danger: #c0392b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Pretendard", system-ui, sans-serif; background: var(--bg); color: var(--text); letter-spacing: -0.01em; }
  a { color: inherit; text-decoration: none; }
  header { position: sticky; top: 0; z-index: 5; background: rgba(247,246,243,.92); backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); }
  .bar { max-width: 1080px; margin: 0 auto; padding: 16px 24px; display: flex; align-items: center; gap: 28px; }
  .brand { font-weight: 800; font-size: 18px; }
  .brand b { color: var(--accent); }
  nav { display: flex; gap: 6px; }
  nav a { padding: 8px 14px; border-radius: 999px; font-weight: 600; font-size: 15px; color: var(--muted); }
  nav a.on { background: var(--accent-soft); color: var(--accent); }
  main { max-width: 1080px; margin: 0 auto; padding: 40px 24px 80px; }
  h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: -0.03em; }
  .lead { color: var(--muted); margin: 0 0 28px; }
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 28px; }
  label { display: block; font-weight: 700; margin: 0 0 8px; }
  label small { font-weight: 500; color: var(--muted); margin-left: 6px; }
  input[type=text], textarea { width: 100%; font: inherit; font-size: 16px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: #fff; color: var(--text); }
  input[type=text]:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  textarea { min-height: 96px; resize: vertical; }
  .field { margin-bottom: 22px; }
  .styles { display: flex; gap: 10px; }
  .styles label { flex: 1; margin: 0; font-weight: 600; border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; cursor: pointer; }
  .styles input { accent-color: var(--accent); margin-right: 8px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; font: inherit; font-weight: 700; border: 0; border-radius: 12px; cursor: pointer; background: var(--accent); color: #fff; padding: 12px 20px; font-size: 15px; }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn.big { width: 100%; padding: 20px; font-size: 20px; border-radius: 14px; }
  .btn.ghost { background: var(--accent-soft); color: var(--accent); }
  .status { margin-top: 20px; border-radius: 14px; padding: 18px 20px; display: none; }
  .status.show { display: block; }
  .status.run { background: var(--accent-soft); }
  .status.fail { background: #fdecea; color: var(--danger); }
  .status.ok { background: #e9f6ee; color: #1e7a45; }
  .status .t { font-weight: 800; font-size: 17px; display: flex; align-items: center; gap: 10px; }
  .status .d { margin-top: 6px; font-size: 14px; color: inherit; opacity: .85; white-space: pre-wrap; word-break: break-all; }
  .spin { width: 18px; height: 18px; border: 3px solid color-mix(in srgb, var(--accent) 25%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: r 0.9s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 22px; }
  .item { background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; transition: transform .15s, box-shadow .15s; }
  .item:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.06); }
  .thumb { aspect-ratio: 4 / 5; background: #eeece8; display: block; width: 100%; object-fit: cover; }
  .meta { padding: 14px 16px 16px; }
  .meta .ti { font-weight: 700; line-height: 1.4; }
  .meta .da { color: var(--muted); font-size: 13px; margin-top: 6px; }
  .empty { color: var(--muted); text-align: center; padding: 60px 0; }
  .back { color: var(--muted); font-weight: 600; display: inline-block; margin-bottom: 16px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin: 24px 0 36px; }
  .cards figure { margin: 0; }
  .cards img { width: 100%; height: auto; display: block; border-radius: 10px; border: 1px solid var(--line); background: #eeece8; }
  .cards figcaption { font-size: 13px; color: var(--muted); margin-top: 6px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
  @media (max-width: 820px) { .two { grid-template-columns: 1fr; } }
  .caption { white-space: pre-wrap; line-height: 1.7; font-size: 15px; background: #fafaf8; border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin: 12px 0 16px; max-height: 480px; overflow: auto; }
  .row { display: flex; justify-content: space-between; align-items: center; }
  .row h2 { margin: 0; font-size: 18px; }
  .hint { color: var(--muted); font-size: 13px; margin: 8px 0 14px; }
  .badge { display: inline-block; font-size: 12px; font-weight: 700; color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 3px 9px; margin-left: 6px; vertical-align: 1px; }
  .item { position: relative; }
  .item .badge.on-thumb { position: absolute; top: 10px; left: 10px; margin: 0; background: var(--accent); color: #fff; }
  .pubbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 20px; margin: 20px 0 0; }
  .pubbar .msg { font-weight: 600; }
  .pubbar .msg a { color: var(--accent); text-decoration: underline; word-break: break-all; }
  .pubbar .status { margin-top: 0; flex-basis: 100%; }
  .modal-bg { position: fixed; inset: 0; background: rgba(20,22,26,.45); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 20; }
  .modal { background: #fff; border-radius: 18px; width: min(760px, 100%); max-height: calc(100vh - 40px); overflow: auto; padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,.2); }
  .modal h2 { margin: 0 0 6px; font-size: 22px; }
  .modal .thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; margin: 16px 0; }
  .modal .thumbs img { width: 100%; aspect-ratio: 4 / 5; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); display: block; }
  .modal .caption { max-height: 260px; }
  .modal .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 8px; }
</style>
</head>
<body>
<header><div class="bar">
  <a class="brand" href="#/">카드뉴스 <b>공장</b></a>
  <nav><a href="#/" data-nav="home">만들기</a><a href="#/archive" data-nav="archive">아카이브</a></nav>
</div></header>
<main id="app"></main>

<script>
var app = document.getElementById('app');
var config = { styleB: false, claude: true };
var pollTimer = null;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function api(url, body) {
  var opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  return fetch(url, opt).then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || '요청 실패'); e.data = j; throw e; } return j; }); });
}
function mmss(s) { var m = Math.floor(s / 60); return (m ? m + '분 ' : '') + (s % 60) + '초'; }
function setNav(k) { document.querySelectorAll('[data-nav]').forEach(function (a) { a.classList.toggle('on', a.dataset.nav === k); }); }

// ---- 작업 진행 표시 ----
function showStatus(box, kind, title, detail) {
  box.className = 'status show ' + kind;
  box.innerHTML = '<div class="t">' + (kind === 'run' ? '<span class="spin"></span>' : '') + esc(title) + '</div>' + (detail ? '<div class="d">' + esc(detail) + '</div>' : '');
}
function watchJob(id, box, onDone, onEnd) {
  clearInterval(pollTimer);
  function tick() {
    api('/api/jobs/' + id).then(function (j) {
      if (j.status === 'running') {
        var runLabel = { edit: '수정하는 중', publish: '올리는 중' }[j.kind] || '만드는 중';
        showStatus(box, 'run', runLabel + ' · ' + mmss(j.elapsed), j.step + (j.activity ? '\n' + j.activity : ''));
        return;
      }
      clearInterval(pollTimer);
      if (onEnd) onEnd();
      if (j.status === 'done' && j.kind === 'publish') { onDone && onDone(j); }
      else if (j.status === 'done') { showStatus(box, 'ok', j.kind === 'edit' ? '수정했어요' : '다 만들었어요', j.summary || ''); onDone && onDone(j); }
      else showStatus(box, 'fail', j.error || '실패했어요', j.detail || '');
    }).catch(function () {});
  }
  tick();
  pollTimer = setInterval(tick, 2000);
}

// ---- 홈 ----
function home() {
  setNav('home');
  var styleHtml = config.styleB ?
    '<div class="field"><label>화풍</label><div class="styles">' +
    '<label><input type="radio" name="style" value="A" checked>A · 기본</label>' +
    '<label><input type="radio" name="style" value="B">B · 일러스트</label></div></div>' : '';
  app.innerHTML =
    '<h1>새 카드뉴스 만들기</h1><p class="lead">주제나 인스타그램 게시물 링크를 넣으면 CLAUDE.md 작업 순서대로 시리즈를 만들어요.</p>' +
    '<div class="panel">' +
      '<div class="field"><label for="in">주제 또는 원본 링크</label><input type="text" id="in" placeholder="예) https://www.instagram.com/p/... 또는 \'스마트스토어 상세페이지 잘 쓰는 법\'"></div>' +
      '<div class="field"><label for="ex">추가 지침 <small>선택 · 이 시리즈에만 적용</small></label><textarea id="ex" placeholder="예) 본문은 6장으로, 소상공인 사장님 눈높이로"></textarea></div>' +
      styleHtml +
      '<button class="btn big" id="go">만들기</button>' +
      '<div class="status" id="st"></div>' +
    '</div>';
  var go = document.getElementById('go'), st = document.getElementById('st');
  function lock(on) { go.disabled = on; }
  function start(id) {
    lock(true);
    watchJob(id, st, function (j) { if (j.kind === 'create' && j.folder) setTimeout(function () { location.hash = '#/s/' + encodeURIComponent(j.folder); }, 900); }, function () { lock(false); });
  }
  go.onclick = function () {
    var input = document.getElementById('in').value.trim();
    if (!input) { showStatus(st, 'fail', '주제나 원본 링크를 넣어주세요.'); return; }
    var s = document.querySelector('input[name=style]:checked');
    lock(true);
    api('/api/create', { input: input, extra: document.getElementById('ex').value, style: s ? s.value : null })
      .then(function (r) { start(r.jobId); })
      .catch(function (e) { lock(false); showStatus(st, 'fail', e.message); if (e.data && e.data.jobId) start(e.data.jobId); });
  };
  if (!config.claude) showStatus(st, 'fail', 'claude 실행 파일을 찾지 못했어요.', '서버를 CLAUDE_BIN 환경변수와 함께 실행해 주세요.');
  api('/api/jobs/current').then(function (j) { if (j) start(j.id); });
}

// ---- 아카이브 ----
function archive() {
  setNav('archive');
  app.innerHTML = '<h1>아카이브</h1><p class="lead">만든 시리즈를 최신순으로 모았어요.</p><div id="list" class="grid"></div>';
  api('/api/series').then(function (list) {
    var el = document.getElementById('list');
    if (!list.length) { el.outerHTML = '<div class="empty">아직 만든 시리즈가 없어요.</div>'; return; }
    el.innerHTML = list.map(function (s) {
      return '<a class="item" href="#/s/' + encodeURIComponent(s.name) + '">' +
        (s.cover ? '<img class="thumb" loading="lazy" src="' + esc(s.cover) + '" alt="">' : '<div class="thumb"></div>') +
        (s.published ? '<span class="badge on-thumb">발행함</span>' : '') +
        '<div class="meta"><div class="ti">' + esc(s.title) + '</div><div class="da">' + esc(s.date) + ' · ' + s.count + '장</div></div></a>';
    }).join('');
  });
}

// ---- 상세 ----
function detail(name) {
  setNav('archive');
  app.innerHTML = '<a class="back" href="#/archive">← 아카이브</a><div id="d">불러오는 중…</div>';
  api('/api/series/' + encodeURIComponent(name)).then(function (s) {
    document.getElementById('d').innerHTML =
      '<h1>' + esc(s.title) + (s.published ? '<span class="badge">발행함</span>' : '') + '</h1><p class="lead">' + esc(s.date) + ' · ' + s.cards.length + '장 · output/' + esc(s.name) + '</p>' +
      '<div class="pubbar" id="pb"></div>' +
      '<div class="cards">' + s.cards.map(function (c, i) {
        return '<figure><a href="' + esc(c.url) + '" target="_blank"><img loading="lazy" src="' + esc(c.url) + '" alt=""></a><figcaption>' + (i + 1) + '번 · ' + esc(c.file) + '</figcaption></figure>';
      }).join('') + '</div>' +
      '<div class="two">' +
        '<div class="panel"><div class="row"><h2>캡션</h2><button class="btn ghost" id="cp">캡션 복사</button></div>' +
          '<div class="caption" id="cap">' + (s.caption ? esc(s.caption) : '<span style="color:var(--muted)">caption.txt 가 없어요.</span>') + '</div></div>' +
        '<div class="panel"><div class="row"><h2>수정 요청</h2></div>' +
          '<p class="hint">예) 3번 카드 제목을 "~"로 바꿔줘 · 5번 카드 설명을 한 줄 줄여줘 · 캡션 해시태그 바꿔줘</p>' +
          '<textarea id="rq" placeholder="고칠 내용을 적어주세요"></textarea>' +
          '<div style="margin-top:12px"><button class="btn" id="ed">수정 요청 보내기</button></div>' +
          '<div class="status" id="st"></div></div>' +
      '</div>';
    var cp = document.getElementById('cp');
    cp.onclick = function () {
      navigator.clipboard.writeText(s.caption || '').then(function () { cp.textContent = '복사했어요'; setTimeout(function () { cp.textContent = '캡션 복사'; }, 1500); });
    };
    var ed = document.getElementById('ed'), st = document.getElementById('st');
    function start(id) {
      ed.disabled = true;
      watchJob(id, st, function (j) { if (j.folder === s.name) setTimeout(function () { detail(s.name); }, 1200); }, function () { ed.disabled = false; });
    }
    ed.onclick = function () {
      var rq = document.getElementById('rq').value.trim();
      if (!rq) { showStatus(st, 'fail', '수정 요청을 적어주세요.'); return; }
      ed.disabled = true;
      api('/api/series/' + encodeURIComponent(s.name) + '/edit', { request: rq })
        .then(function (r) { start(r.jobId); })
        .catch(function (e) { ed.disabled = false; showStatus(st, 'fail', e.message); if (e.data && e.data.jobId) start(e.data.jobId); });
    };
    // ---- 인스타 발행 ----
    var pb = document.getElementById('pb');
    function pubDone(link) {
      pb.innerHTML = '<div class="msg">인스타에 발행했어요 · <a href="' + esc(link || '#') + '" target="_blank" rel="noopener">' + esc(link || '게시물 링크를 찾지 못했어요') + '</a></div>';
    }
    function pubIdle() {
      pb.innerHTML = '<div class="msg">내 인스타(@bibi_blog_world)에 캐러셀로 올릴 수 있어요.</div>' +
        '<button class="btn" id="pub">인스타에 발행</button><div class="status" id="pst"></div>';
      document.getElementById('pub').onclick = openConfirm;
    }
    function pubWatch(id) {
      var pubBtn = document.getElementById('pub');
      if (pubBtn) pubBtn.disabled = true;
      var box = document.getElementById('pst');
      watchJob(id, box, function (j) { pubDone(j.permalink); setTimeout(function () { detail(s.name); }, 4000); },
        function () { var b = document.getElementById('pub'); if (b) b.disabled = false; });
    }
    function openConfirm() {
      var box = document.getElementById('pst');
      var n = s.cards.length;
      if (n < 2 || n > 10) { showStatus(box, 'fail', '인스타 캐러셀은 2~10장만 됩니다', '지금 ' + n + '장이에요.'); return; }
      if (!s.caption.trim()) { showStatus(box, 'fail', 'caption.txt 가 없어요', '캡션을 먼저 만들어 주세요.'); return; }
      var bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' +
        '<h2>이 카드 ' + n + '장 + 이 캡션으로 올립니다</h2><p class="hint" style="margin:0">@bibi_blog_world 에 캐러셀로 발행돼요. 올린 뒤에는 인스타 앱에서만 지울 수 있어요.</p>' +
        '<div class="thumbs">' + s.cards.map(function (c) { return '<img src="' + esc(c.url) + '" alt="">'; }).join('') + '</div>' +
        '<div class="row"><h2 style="font-size:16px">캡션 전문</h2></div>' +
        '<div class="caption">' + esc(s.caption) + '</div>' +
        '<div class="actions"><button class="btn ghost" id="no">취소</button><button class="btn" id="go">이대로 올립니다</button></div></div>';
      document.body.appendChild(bg);
      function close() { bg.remove(); document.removeEventListener('keydown', onKey); }
      function onKey(e) { if (e.key === 'Escape') close(); }
      document.addEventListener('keydown', onKey);
      bg.onclick = function (e) { if (e.target === bg) close(); };
      bg.querySelector('#no').onclick = close;
      bg.querySelector('#go').onclick = function () {
        close();
        document.getElementById('pub').disabled = true;
        api('/api/series/' + encodeURIComponent(s.name) + '/publish', {})
          .then(function (r) { pubWatch(r.jobId); })
          .catch(function (e) {
            document.getElementById('pub').disabled = false;
            if (e.data && e.data.permalink) { pubDone(e.data.permalink); return; }
            showStatus(box, 'fail', e.message);
            if (e.data && e.data.jobId) pubWatch(e.data.jobId);
          });
      };
    }
    if (s.published) pubDone(s.published.permalink); else pubIdle();

    api('/api/jobs/current').then(function (j) {
      if (!j || j.folder !== s.name) return;
      if (j.kind === 'publish') pubWatch(j.id); else start(j.id);
    });
  }).catch(function (e) { document.getElementById('d').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
}

function route() {
  clearInterval(pollTimer);
  var h = location.hash || '#/';
  if (h.indexOf('#/s/') === 0) detail(decodeURIComponent(h.slice(4)));
  else if (h === '#/archive') archive();
  else home();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
api('/api/config').then(function (c) { config = c; }).finally(route);
</script>
</body>
</html>`.replace('ACCENT_COLOR', ACCENT);
