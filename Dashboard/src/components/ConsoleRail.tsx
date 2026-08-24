import { ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Accordion state for the console.
 *
 * Held here rather than inside each panel so only one can be open at a time.
 * With four panels in a fixed-height rail, several open at once pushed the last
 * one out of reach and the map gave up its width for sections nobody was
 * reading.
 */
interface AccordionValue {
  openId: string | null;
  toggle: (id: string) => void;
  /** Lets the collapsed strip show each panel's icon without duplicating it. */
  register: (id: string, icon: ReactNode, accentTile: string) => void;
}

const AccordionContext = createContext<AccordionValue | null>(null);

export const useAccordion = () => useContext(AccordionContext);

interface ConsoleRailProps {
  children: ReactNode;
  /** Lets the layout hand the freed width back to the map. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Which panel starts open, by title. */
  initialOpen?: string | null;
  /** Pinned to the foot of the rail, and kept when collapsed. */
  footer?: ReactNode;
  /** Compact form of the footer, for the collapsed strip. */
  footerCollapsed?: ReactNode;
}

/**
 * The left console: one column that owns the whole left edge.
 *
 * Everything that used to be an independently positioned floating panel lives
 * here now, so no combination of open sections can hide another or cover the
 * canvas controls in the corners.
 */
export const ConsoleRail: React.FC<ConsoleRailProps> = ({
  children,
  onCollapsedChange,
  initialOpen = 'Members',
  footer,
  footerCollapsed,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  const [entries, setEntries] = useState<
    { id: string; icon: ReactNode; accentTile: string }[]
  >([]);

  useEffect(() => {
    onCollapsedChange?.(isCollapsed);
  }, [isCollapsed, onCollapsedChange]);

  // Stable identity: panels register from an effect, and a fresh function on
  // every parent render would make that effect re-run forever.
  const register = useCallback(
    (id: string, icon: ReactNode, accentTile: string) => {
      setEntries((current) =>
        current.some((entry) => entry.id === id)
          ? current
          : [...current, { id, icon, accentTile }]
      );
    },
    []
  );

  const toggle = useCallback(
    (id: string) => setOpenId((current) => (current === id ? null : id)),
    []
  );

  // Collapsed: a narrow strip of panel icons. Clicking one reopens the rail
  // straight onto that panel, so collapsing costs nothing to undo.
  if (isCollapsed) {
    return (
      <div className="h-full w-full flex flex-col items-center gap-1.5 py-1">
        <button
          type="button"
          onClick={() => setIsCollapsed(false)}
          className="w-9 h-9 flex items-center justify-center rounded-lg
                     bg-cyan-100 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300
                     hover:brightness-95 transition"
          aria-label="Show console"
          title="Show console"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 6h16M4 12h10M4 18h7" />
          </svg>
        </button>

        <div className="w-6 h-px bg-slate-200 dark:bg-slate-700 my-0.5" />

        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => { setOpenId(entry.id); setIsCollapsed(false); }}
            className={`w-9 h-9 flex items-center justify-center rounded-lg
                        transition hover:brightness-95 ${entry.accentTile}`}
            aria-label={entry.id}
            title={entry.id}
          >
            {entry.icon}
          </button>
        ))}

        {footerCollapsed && <div className="mt-auto">{footerCollapsed}</div>}
      </div>
    );
  }

  return (
    <AccordionContext.Provider value={{ openId, toggle, register }}>
      <div className="console-rail h-full w-full flex flex-col gap-2 overflow-y-auto pr-1">
        <div className="shrink-0 flex items-center gap-2 px-1.5 pb-1.5 mb-0.5
                        border-b border-slate-200/70 dark:border-slate-700/70">
          <span className="flex items-center justify-center w-6 h-6 rounded-lg
                           bg-cyan-100 text-cyan-600
                           dark:bg-cyan-500/15 dark:text-cyan-300">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"
                 strokeLinejoin="round" aria-hidden>
              <path d="M4 6h16M4 12h10M4 18h7" />
            </svg>
          </span>
          <span className="text-[11px] font-semibold tracking-[0.02em]
                           text-slate-700 dark:text-slate-200">
            Console
          </span>
          <button
            type="button"
            onClick={() => setIsCollapsed(true)}
            className="ml-auto w-6 h-6 flex items-center justify-center rounded-md
                       text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
                       hover:bg-white/70 dark:hover:bg-slate-700/50 transition-colors"
            aria-label="Hide console"
            title="Hide console"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth={2} strokeLinecap="round"
                 strokeLinejoin="round" aria-hidden>
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
        </div>

        {children}

        {footer && <div className="shrink-0 mt-auto pt-2">{footer}</div>}
      </div>
    </AccordionContext.Provider>
  );
};

export default ConsoleRail;
