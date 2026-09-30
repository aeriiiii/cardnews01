// 인스타그램 연결 확인 (Instagram API with Instagram Login)
//   사용법: node tools/ig_check.mjs
//   .env 의 IG_ACCESS_TOKEN 으로 graph.instagram.com/me 를 불러
//   계정 이름·계정 ID 를 확인하고, 계정 ID 를 .env 의 IG_USER_ID 에 저장한다.
//   토큰은 화면에 출력하지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');

const envText = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
// 내 컴퓨터: .env 파일 / 클라우드: 환경변수(비밀 설정)
const token = process.env.IG_ACCESS_TOKEN?.trim() || (envText.match(/^IG_ACCESS_TOKEN=(.*)$/m) || [])[1]?.trim();
if (!token) {
  console.error('실패: .env 에 IG_ACCESS_TOKEN 이 없어요.');
  process.exit(1);
}

const url = `https://graph.instagram.com/v23.0/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`;
const res = await fetch(url);
const data = await res.json().catch(() => ({}));

if (!res.ok || data.error) {
  const e = data.error || {};
  console.error(`실패: ${e.message || `HTTP ${res.status}`}${e.code ? ` (code ${e.code})` : ''}`);
  process.exit(1);
}

const userId = data.user_id || data.id;
if (!fs.existsSync(ENV)) {
  // 클라우드: .env 를 만들지 않는다 (토큰은 비밀 설정에만)
  console.log(`연결 성공: @${data.username} (계정 ID ${userId})`);
  process.exit(0);
}
const next = /^IG_USER_ID=.*$/m.test(envText)
  ? envText.replace(/^IG_USER_ID=.*$/m, `IG_USER_ID=${userId}`)
  : `${envText.trimEnd()}\nIG_USER_ID=${userId}\n`;
fs.writeFileSync(ENV, next, 'utf8');

console.log(`연결 성공: @${data.username} (계정 ID ${userId})`);
