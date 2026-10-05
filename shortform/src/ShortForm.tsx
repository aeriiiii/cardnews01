// 예시 숏폼: 배경 + 한글 자막. 자막은 초 단위(from~to)로 넣는다.
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT_FAMILY } from './fonts';

export type Subtitle = { text: string; from: number; to: number };
export type ShortFormProps = { subtitles: Subtitle[] };

const COLOR = { text: '#000000', bg: '#edebe7', accent: '#005cf0' };

export const ShortForm: React.FC<ShortFormProps> = ({ subtitles }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  const current = subtitles.find((s) => sec >= s.from && sec < s.to);

  return (
    <AbsoluteFill style={{ backgroundColor: COLOR.bg, fontFamily: FONT_FAMILY }}>
      <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 420 }}>
        {current ? <Caption key={current.from} sub={current} /> : null}
      </AbsoluteFill>
      <div style={{ position: 'absolute', bottom: 80, width: '100%', textAlign: 'center', fontSize: 34, fontWeight: 500, opacity: 0.45 }}>
        @bibi_blog_world
      </div>
    </AbsoluteFill>
  );
};

// 자막 한 덩어리: 살짝 떠오르며 나타난다
const Caption: React.FC<{ sub: Subtitle }> = ({ sub }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame - sub.from * fps;
  const appear = interpolate(local, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div
      style={{
        maxWidth: 920,
        padding: '28px 44px',
        background: COLOR.text,
        color: '#ffffff',
        borderRadius: 24,
        fontSize: 72,
        fontWeight: 800,
        lineHeight: 1.3,
        letterSpacing: '-0.03em',
        textAlign: 'center',
        whiteSpace: 'pre-line',
        wordBreak: 'keep-all',
        opacity: appear,
        transform: `translateY(${(1 - appear) * 30}px)`,
      }}
    >
      {sub.text}
    </div>
  );
};
