import { useEffect, useRef } from 'react';
import {
  MAX_DATE,
  MIN_DATE,
  formatDay,
  shiftDay,
} from '../utils/analysisWindow';

/**
 * Date picker plus hour scrubber for the dispatched day.
 *
 * The window is one day at a time rather than the whole two years: dispatch
 * cost scales with the window, so 24 hours keeps scrubbing responsive while
 * still reaching any hour of 2022 or 2023 by moving the day.
 *
 * Changing the day costs a dispatch (~2 s); changing the hour costs nothing,
 * because the whole day is already in memory. The two controls are visually
 * separated for that reason - the chip commits, the slider explores.
 */
interface TimelineBarProps {
  /** yyyy-mm-dd, the day currently dispatched. */
  day: string;
  onDayChange: (day: string) => void;
  currentHour: number;
  onHourChange: (hour: number) => void;
  /** Hours in the dispatched window; 24 for a single day. */
  totalHours: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  /** True while a dispatch is in flight, so the day controls can be disabled. */
  isComputing?: boolean;
}

const PLAY_INTERVAL_MS = 700;

export const TimelineBar: React.FC<TimelineBarProps> = ({
  day,
  onDayChange,
  currentHour,
  onHourChange,
  totalHours,
  isPlaying,
  onPlayPause,
  isComputing = false,
}) => {
  const dateInput = useRef<HTMLInputElement>(null);
  const hourRef = useRef(currentHour);
  hourRef.current = currentHour;

  // Advance the hour while playing, wrapping within the day rather than
  // rolling into the next one - crossing midnight would need a new dispatch.
  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => {
      onHourChange((hourRef.current + 1) % Math.max(1, totalHours));
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [isPlaying, totalHours, onHourChange]);

  const atStart = day <= MIN_DATE;
  const atEnd = day >= MAX_DATE;
  const clock = `${String(currentHour % 24).padStart(2, '0')}:00`;

  return (
    /* Two rows. The scrubber used to sit in a flex-1 between the day controls
       and the play button, so its left edge moved with the date chip's width
       and it could never line up with the chart above it. On its own row it
       spans the same box as the chart, and both are inset by half a thumb so
       hour zero is at the same x in each. */
    <div className="timeline-bar px-3.5 py-2">
      <div className="flex items-center gap-3">
      {/* Day: a chip that opens the native picker, bounded by the data we hold. */}
      <button
        type="button"
        onClick={() => dateInput.current?.showPicker?.() ?? dateInput.current?.focus()}
        disabled={isComputing}
        className="timeline-chip"
        title="Choose any day in 2022 or 2023"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M8 3v4M16 3v4M3 10h18" />
        </svg>
        <span>{formatDay(day)}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <input
        ref={dateInput}
        type="date"
        value={day}
        min={MIN_DATE}
        max={MAX_DATE}
        onChange={(e) => e.target.value && onDayChange(e.target.value)}
        className="sr-only absolute"
        tabIndex={-1}
        aria-label="Analysis day"
      />

      <button type="button" className="timeline-step" disabled={atStart || isComputing}
              onClick={() => onDayChange(shiftDay(day, -1))} aria-label="Previous day">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth={2} strokeLinecap="round"><path d="M15 6l-6 6 6 6" /></svg>
      </button>

      <button type="button" className="timeline-step" disabled={atEnd || isComputing}
              onClick={() => onDayChange(shiftDay(day, 1))} aria-label="Next day">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth={2} strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>
      </button>

      <button
        type="button"
        onClick={onPlayPause}
        className="timeline-play"
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M8 5l11 7-11 7z" />
          </svg>
        )}
      </button>

      <span className="timeline-clock tabular-nums">{clock}</span>
      </div>

      {/* Hour scrubber. Ticks every hour, labels at 06/12/18. */}
      <div className="timeline-scrub">
        <div className="relative">
          <input
            type="range"
            min={0}
            max={Math.max(0, totalHours - 1)}
            step={1}
            value={Math.min(currentHour, totalHours - 1)}
            onChange={(e) => onHourChange(Number(e.target.value))}
            className="timeline-range w-full"
            aria-label="Hour of day"
          />
        </div>
        <div className="timeline-ticks" aria-hidden>
          {Array.from({ length: totalHours }, (_, h) => (
            <span
              key={h}
              className={
                h % 6 === 0 ? 'timeline-tick timeline-tick--major' : 'timeline-tick'
              }
            />
          ))}
        </div>
        <div className="timeline-hour-labels" aria-hidden>
          {[6, 12, 18].filter((h) => h < totalHours).map((h) => (
            <span key={h} style={{ left: `${(h / Math.max(1, totalHours - 1)) * 100}%` }}>
              {String(h).padStart(2, '0')}:00
            </span>
          ))}
        </div>
      </div>

    </div>
  );
};

export default TimelineBar;
