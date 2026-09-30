#!/usr/bin/env bash
# 클라우드(Claude Code on the web) 환경 준비 스크립트
#   환경 설정의 "Setup script" 에 이 파일을 실행하도록 넣는다: bash tools/cloud_setup.sh
#   - Node 패키지 설치 (playwright, express)
#   - 카드 렌더용 Chromium 과 한글 폰트 설치
set -e
npm install --no-audit --no-fund
npx -y playwright install --with-deps chromium
# 한글 폰트: Pretendard 는 CDN 에서 불러오지만, 대체 글꼴이 없으면 CDN 이 막힐 때 글자가 네모로 나온다
if command -v apt-get >/dev/null 2>&1; then
  (sudo apt-get install -y fonts-noto-cjk || apt-get install -y fonts-noto-cjk) >/dev/null 2>&1 || true
fi
echo "cloud setup done"
