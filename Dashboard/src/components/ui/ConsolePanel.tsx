import { ReactNode, useEffect, useState } from 'react';
import { useAccordion } from '../ConsoleRail';

export type PanelStatus = 'idle' | 'busy' | 'ok' | 'error';

/**
 * Accent per panel, matching the tinted icon tiles in the header stat row so
 * the console reads as part of the same system rather than a separate widget.
 * Colour groups the panels; the status dot carries state.
 */
export type PanelAccent = 'sky' | 'emerald' | 'violet' | 'amber' | 'slate';

const ACCENTS: Record<PanelAccent, { tile: string; edge: string }> = {
  // Praxeti hues. The tile is the colour at low alpha with the colour itself as
  // ink, so each keeps its identity on either surface without a second value.
  sky:     { tile: 'px-tile px-tile--nuit',     edge: 'rgb(30 72 143)' },
  emerald: { tile: 'px-tile px-tile--green',    edge: 'rgb(0 128 76)' },
  violet:  { tile: 'px-tile px-tile--mantis',   edge: 'rgb(116 195 101)' },
  amber:   { tile: 'px-tile px-tile--spring',   edge: 'rgb(219 230 76)' },
  slate:   { tile: 'px-tile px-tile--midnight', edge: 'rgb(0 31 63)' },
};

interface ConsolePanelProps {
  title: string;
  /** Short right-aligned context, e.g. a count or the active scenario. */
  subtitle?: string;
  icon?: ReactNode;
  accent?: PanelAccent;
  status?: PanelStatus;
  defaultOpen?: boolean;
  /** Caps the body height so one long section cannot crowd out the others. */
  maxBodyHeight?: number;
  children: ReactNode;
}

/**
 * One section of the left console.
 *
 * Collapsible, and laid out in normal flow rather than absolutely positioned -
 * the previous panels were each pinned to `top-4 left-4` or `bottom-4 left-4`,
 * so Scenario sat directly on top of Filters and could also run into the
 * optimizer panel. Stacking them in a flex column makes overlap impossible
 * instead of a matter of picking z-indexes.
 */
export const ConsolePanel: React.FC<ConsolePanelProps> = ({
  title,
  subtitle,
  icon,
  accent = 'slate',
  status = 'idle',
  defaultOpen = false,
  maxBodyHeight = 420,
  children,
}) => {
  const tone = ACCENTS[accent];
  const accordion = useAccordion();

  // Own state only when there is no rail above us, so the panel still works in
  // isolation; inside the rail the accordion decides, and opening one closes
  // the rest.
  const [selfOpen, setSelfOpen] = useState(defaultOpen);
  const isOpen = accordion ? accordion.openId === title : selfOpen;

  // Register so the collapsed rail can offer this panel by its own icon.
  const { register } = accordion ?? {};
  useEffect(() => {
    if (register && icon) register(title, icon, tone.tile);
  }, [register, title, icon, tone.tile]);

  const setIsOpen = () =>
    accordion ? accordion.toggle(title) : setSelfOpen((open) => !open);

  return (
    <section
      className={`console-panel ${isOpen ? 'console-panel--open' : ''}`}
      style={{ ['--panel-edge' as string]: tone.edge }}
    >
      <button
        type="button"
        className="console-header"
        onClick={setIsOpen}
        aria-expanded={isOpen}
      >
        {icon && <span className={`console-icon ${tone.tile}`}>{icon}</span>}

        <span className="min-w-0 flex-1 text-left">
          <span className="console-title block truncate">{title}</span>
          {subtitle && <span className="console-sub block truncate">{subtitle}</span>}
        </span>

        {/* Only shown when it means something - a panel sitting idle does not
            need a dot competing with its icon for attention. */}
        {status !== 'idle' && (
          <span className={`console-dot console-dot--${status}`} aria-hidden />
        )}

        <svg
          className={`console-chevron ${isOpen ? 'console-chevron--open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden
        >
          <path
            d="M4 2.5 L8 6 L4 9.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {isOpen && (
        <div className="console-body" style={{ maxHeight: maxBodyHeight }}>
          {children}
        </div>
      )}
    </section>
  );
};

export default ConsolePanel;
