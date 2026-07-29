import { useState, useEffect, useRef } from 'react';

interface TimelineProps {
  currentHour: number;
  isPlaying: boolean;
  onHourChange: (hour: number) => void;
  onPlayPause: () => void;
  isSankeyOpen?: boolean;
  /** Length of the dispatched period. Set by the analysis period, not fixed. */
  totalHours?: number;
}

export const Timeline = ({
  currentHour,
  isPlaying,
  onHourChange,
  onPlayPause,
  isSankeyOpen = false,
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
      className={`fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 shadow-lg p-4 z-40 ${
        isSankeyOpen ? 'border-t-4 border-blue-500' : ''
      }`}
    >
      <div className="max-w-7xl mx-auto flex items-center gap-4">
        <button
          onClick={onPlayPause}
          className="bg-blue-500 hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors duration-300"
        >
          {isPlaying ? (
            <>
              <PauseIcon className="w-5 h-5" />
              Pause
            </>
          ) : (
            <>
              <PlayIcon className="w-5 h-5" />
              Play
            </>
          )}
        </button>

        <div className="flex-1 flex items-center gap-4">
          <span className="text-gray-700 dark:text-gray-300 w-24">
            {formatHour(localHour)}
          </span>
          <input
            type="range"
            min="0"
            max={hours - 1}
            value={Math.min(localHour, hours - 1)}
            onChange={handleSliderChange}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
          />
        </div>

        <span className="text-gray-500 dark:text-gray-400 text-sm">
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
