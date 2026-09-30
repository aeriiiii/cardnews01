// 앱예약/ 폴더 → 모바일 예약 보드. 실행: node tools/board/build_board.mjs
// 결과: tools/board/out/board.html + files.json (Artifact publish 의 files 맵)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/khb05/OneDrive/문서/ai/cardnews';
const SRC = path.join(ROOT, '앱예약');
const OUT = path.join(ROOT, 'tools', 'board', 'out');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const titleOf = (series) => {
  const f = path.join(ROOT, 'output', series, 'card_01_cover.html');
  if (!fs.existsSync(f)) return '';
  const m = fs.readFileSync(f, 'utf8').match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
};

const posts = [];
const files = {};
fs.readdirSync(SRC).filter((d) => /^\d+월\d+일_/.test(d)).sort((a, b) => {
  const n = (s) => { const [, m, d] = s.match(/^(\d+)월(\d+)일/); return +m * 100 + +d; };
  return n(a) - n(b);
}).forEach((d, i) => {
  const [, m, day, topic] = d.match(/^(\d+)월(\d+)일_(.+)$/);
  const date = new Date(2026, +m - 1, +day);
  const key = `p${i + 1}`;
  const imgs = fs.readdirSync(path.join(SRC, d)).filter((f) => /\.png$/.test(f)).sort();
  imgs.forEach((f) => { files[`${key}/${f}`] = path.join(SRC, d, f).replace(/\\/g, '/'); });
  posts.push({
    key,
    when: `${m}월 ${day}일 (${DOW[date.getDay()]}) 오후 12:00`,
    title: titleOf(`2026-09-30_${topic}`) || topic,
    folder: d,
    images: imgs.map((f) => `${key}/${f}`),
    caption: fs.readFileSync(path.join(SRC, d, 'caption.txt'), 'utf8').trim(),
  });
});

const tpl = fs.readFileSync(path.join(ROOT, 'tools', 'board', 'board_tpl.html'), 'utf8');
fs.writeFileSync(path.join(OUT, 'board.html'), tpl.replace('/*POSTS*/[]', JSON.stringify(posts)), 'utf8');
fs.writeFileSync(path.join(OUT, 'files.json'), JSON.stringify(files, null, 1));
console.log(posts.map((p) => `${p.when} · ${p.title} · ${p.images.length}장`).join('\n'));
