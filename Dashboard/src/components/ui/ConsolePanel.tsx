import { ReactNode, useState } from 'react';

export type PanelStatus = 'idle' | 'busy' | 'ok' | 'error';

interface ConsolePanelProps {
  title: string;
  /** Short right-aligned context, e.g. a count or the active scenario. */
  subtitle?: string;
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
  status = 'idle',
  defaultOpen = false,
  maxBodyHeight = 420,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className="console-panel">
      <button
        type="button"
        className="console-header"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
      >
        <span className={`console-dot console-dot--${status}`} aria-hidden />
        <span className="console-title">{title}</span>
        {subtitle && <span className="console-sub">{subtitle}</span>}
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
            strokeWidth="1.6"
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
