import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5] as const;
type Speed = (typeof SPEED_OPTIONS)[number];

interface Props {
  /** Object URL or HTTP URL pointing at the audio blob. When this
   *  changes the player loads + autoplays the new source. */
  src: string;
  /** Called when playback finishes (the `ended` event). The parent
   *  typically uses this to reset its own status flag. */
  onEnded?: () => void;
  /** Called when the user clicks the close button. The parent should
   *  unmount the player and release the blob URL. */
  onClose?: () => void;
  /** Whether to autoplay on mount / when src changes. Default true —
   *  callers fetch and then mount with the explicit intent to play. */
  autoPlay?: boolean;
  className?: string;
}

/** Tight inline audio player wrapping <audio controls>.
 *
 *  Native controls give us seek + volume + mute for free. On top of
 *  that we expose a speed row (0.75 / 1 / 1.25 / 1.5x) — language
 *  learners care about slow-listen for hard passages and fast-listen
 *  for review.
 *
 *  Persisting the speed setting across sessions is on the cheap side
 *  of useful: a learner picks 0.75 once for hard material and keeps it.
 */
export default function AudioPlayer({
  src,
  onEnded,
  onClose,
  autoPlay = true,
  className,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [speed, setSpeed] = useState<Speed>(() => {
    const v = Number(localStorage.getItem('audio-player-speed'));
    return SPEED_OPTIONS.includes(v as Speed) ? (v as Speed) : 1;
  });

  // Apply the saved speed whenever the element mounts or the source
  // changes — the <audio> element resets playbackRate to 1 on src
  // change, so we always reassert it.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, src]);

  useEffect(() => {
    localStorage.setItem('audio-player-speed', String(speed));
  }, [speed]);

  return (
    <div
      className={cn(
        'inline-flex w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5',
        className,
      )}
    >
      <audio
        ref={audioRef}
        src={src}
        controls
        autoPlay={autoPlay}
        onEnded={onEnded}
        className="min-w-0 flex-1"
      />
      <div className="flex shrink-0 items-center gap-0.5">
        {SPEED_OPTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(s)}
            className={cn(
              'rounded px-1.5 py-0.5 font-mono text-[11px] transition',
              speed === s
                ? 'bg-accent text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
            title={`${s}× 倍速`}
          >
            {s}×
          </button>
        ))}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          aria-label="关闭播放器"
          title="关闭"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
