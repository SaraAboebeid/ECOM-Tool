import { GraphData } from '../../types';
import { useEnergyBreakdown } from '../../hooks/useEnergyBreakdown';
import { EnergyOverTime } from './EnergyOverTime';

interface AnalyticsRowProps {
  data: GraphData;
  currentHour: number;
  /** Analysis-period length, so the chart matches the scrubber's domain. */
  totalHours: number;
}

/**
 * The strip under the map.
 *
 * Was four cards; three of them - a supply donut, a self-sufficiency dial and a
 * notes list - restated Solar, Battery and Self-Sufficiency, which the header
 * already carries. Only the time dimension was new, so only that survives: the
 * header answers "how much", this answers "when".
 */
export const AnalyticsRow: React.FC<AnalyticsRowProps> = ({ data, currentHour, totalHours }) => {
  const { series } = useEnergyBreakdown(data);
  if (series.length < 2) return null;
  return <EnergyOverTime series={series} currentHour={currentHour} totalHours={totalHours} />;
};

export default AnalyticsRow;
