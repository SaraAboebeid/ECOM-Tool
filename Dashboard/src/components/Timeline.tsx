import { useState, useEffect, useRef } from 'react';

interface TimelineProps {
  currentHour: number;
  isPlaying: boolean;
  onHourChange: (hour: number) => void;
  onPlayPause: () => void;
  isSankeyOpen?: boolean;
  embedded?: boolean;
  /** Length of the dispatched period. Set by the analysis period, not fixed. */
  totalHours?: number;
}

export const Timeline = ({
  currentHour,
  isPlaying,
  onHourChange,
  onPlayPause,
  isSankeyOpen = false,
  embedded = false,
  totalHours = 48,
}: TimelineProps) => {
  const hours = Math.max(1, totalHours);
  const [localHour, setLocalHour] = useState(currentHour);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLocalHour(currentHour);
  }, [currentHour]);

  useEffect(() => {
    let interval: number;
    if (isPlaying) {
      interval = window.setInterval(() => {
        onHourChange((currentHour + 1) % hours);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isPlaying, currentHour, onHourChange, hours]);

  const handleSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newHour = parseInt(event.target.value, 10);
    setLocalHour(newHour);
    onHourChange(newHour);
  };

  const formatHour = (hour: number) => {
    const period = hour % 24;
    const ampm = period < 12 ? 'AM' : 'PM';
    const displayHour = period % 12 || 12;
    return `${displayHour}:00 ${ampm}`;
  };

  const tickDefs = [
    { ratio: 0, label: '12 AM' },
    { ratio: 0.25, label: '6 AM' },
    { ratio: 0.5, label: '12 PM' },
    { ratio: 0.75, label: '6 PM' },
    { ratio: 1, label: '12 AM' },
  ].map((tick) => ({
    ...tick,
    hour: Math.round(tick.ratio * (hours - 1)),
  }));

  // Expose the current timeline height via a CSS variable for other components
  useEffect(() => {
    const updateVar = () => {
      const h = rootRef.current?.offsetHeight || 96; // default ~6rem
      document.documentElement.style.setProperty('--timeline-height', `${h}px`);
    };
    updateVar();
    window.addEventListener('resize', updateVar);
    return () => window.removeEventListener('resize', updateVar);
  }, [isSankeyOpen, isPlaying, localHour]);

  return (
    <div
      ref={rootRef}
      className={`${embedded ? 'relative rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/90 dark:bg-slate-900/74 backdrop-blur-md shadow-[0_14px_34px_-24px_rgba(2,6,23,0.9)]' : 'fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 shadow-lg'} px-4 py-3 z-40 ${
        isSankeyOpen ? 'border-t-4 border-blue-500' : ''
      }`}
    >
      <div className="w-full mx-auto flex items-center gap-4 timeline-layout">
        <button
          onClick={onPlayPause}
          className="timeline-play-btn"
        >
          {isPlaying ? (
            <>
              <PauseIcon className="w-4 h-4" />
              Pause
            </>
          ) : (
            <>
              <PlayIcon className="w-4 h-4" />
              Play
            </>
          )}
        </button>

        <div className="flex items-center gap-2.5 shrink-0">
          <span className="timeline-weather-icon" aria-hidden>
            <WeatherIcon className="w-4 h-4" />
          </span>
          <span className="text-slate-700 dark:text-slate-200 w-24 text-[20px] font-semibold tracking-[0.01em]">
            {formatHour(localHour)}
          </span>
        </div>

        <div className="flex-1 min-w-0 timeline-track-wrap">
          <div className="timeline-track-shell">
          <input
            type="range"
            min="0"
            max={hours - 1}
            value={Math.min(localHour, hours - 1)}
            onChange={handleSliderChange}
            className="timeline-range"
          />

            {tickDefs.map((tick, idx) => {
              const left = tick.ratio * 100;
              return (
                <div
                  key={`${tick.label}-${idx}`}
                  className="timeline-tick"
                  style={{ left: `${left}%` }}
                >
                  <span className="timeline-tick-dot" />
                  <span className="timeline-tick-label">{tick.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        <span className="text-slate-500 dark:text-slate-400 text-sm font-medium shrink-0">
          Hour {Math.min(localHour, hours - 1) + 1}/{hours}
        </span>
      </div>
    </div>
  );
};

const PlayIcon = ({ className = "w-6 h-6" }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

const PauseIcon = ({ className = "w-6 h-6" }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

const WeatherIcon = ({ className = 'w-4 h-4' }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="4" strokeWidth={1.8} />
    <path strokeLinecap="round" strokeWidth={1.8} d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
  </svg>
);
