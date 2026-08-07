import { ReactNode, useState } from 'react';

interface ConsoleRailProps {
  children: ReactNode;
}

/**
 * The left console: one column that owns the whole left edge.
 *
 * Everything that used to be an independently positioned floating panel lives
 * here now. The rail scrolls as a unit and each section scrolls internally, so
 * no combination of open sections can hide another or cover the canvas
 * controls in the corners.
 */
export const ConsoleRail: React.FC<ConsoleRailProps> = ({ children }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  if (isCollapsed) {
    return (
      <button
        type="button"
        onClick={() => setIsCollapsed(false)}
        className="console-panel w-full px-3 py-2.5 text-[11px] font-semibold
                   uppercase tracking-[0.16em] text-slate-700 dark:text-slate-200"
        aria-label="Show console"
      >
        Console
      </button>
    );
  }

  return (
    <div
      className="console-rail h-full w-full flex flex-col gap-2.5 overflow-y-auto pr-1"
    >
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em]
                         text-slate-500 dark:text-slate-400">
          Command Console
        </span>
        <button
          type="button"
          onClick={() => setIsCollapsed(true)}
          className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
                     text-[11px] leading-none px-1.5 py-0.5 rounded-md hover:bg-white/60 dark:hover:bg-slate-700/50 transition-colors"
          aria-label="Hide console"
          title="Hide console"
        >
          ⟨
        </button>
      </div>

      {children}
    </div>
  );
};

export default ConsoleRail;
