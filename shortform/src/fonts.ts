// 한글 자막용 Pretendard. public/fonts 의 파일을 불러와서 인터넷 없이도 렌더된다.
import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

export const FONT_FAMILY = 'Pretendard';

const WEIGHTS = [
  ['Regular', '400'],
  ['Medium', '500'],
  ['Bold', '700'],
  ['ExtraBold', '800'],
  ['Black', '900'],
] as const;

export const fontsReady = Promise.all(
  WEIGHTS.map(([name, weight]) =>
    loadFont({
      family: FONT_FAMILY,
      url: staticFile(`fonts/Pretendard-${name}.woff2`),
      weight,
    }),
  ),
);
