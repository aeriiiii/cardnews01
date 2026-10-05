import { Composition } from 'remotion';
import { ShortForm } from './ShortForm';
import './fonts';

// 세로 숏폼: 1080x1920, 30fps
export const VIDEO = { width: 1080, height: 1920, fps: 30 };

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="ShortForm"
      component={ShortForm}
      width={VIDEO.width}
      height={VIDEO.height}
      fps={VIDEO.fps}
      durationInFrames={VIDEO.fps * 9}
      defaultProps={{
        subtitles: [
          { text: '글은 잘 썼는데\n왜 안 뜰까요?', from: 0, to: 3 },
          { text: '답은 거의 정해져 있어요', from: 3, to: 6 },
          { text: '키워드 → 제목\n그다음이 내용', from: 6, to: 9 },
        ],
      }}
    />
  );
};
