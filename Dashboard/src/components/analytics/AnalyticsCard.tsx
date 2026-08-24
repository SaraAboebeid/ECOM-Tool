import { ReactNode } from 'react';

interface AnalyticsCardProps {
  title: string;
  /** Right-aligned context, e.g. the window the figures cover. */
  meta?: ReactNode;
  children: ReactNode;
}

/**
 * Shell for the cards along the foot of the workspace. Only the frame - each
 * card owns its own visualisation.
 */
export const AnalyticsCard: React.FC<AnalyticsCardProps> = ({ title, meta, children }) => (
  <section className="analytics-card">
    <header className="analytics-card__head">
      <h3 className="analytics-card__title">{title}</h3>
      {meta && <span className="analytics-card__meta">{meta}</span>}
    </header>
    <div className="analytics-card__body">{children}</div>
  </section>
);

export default AnalyticsCard;
