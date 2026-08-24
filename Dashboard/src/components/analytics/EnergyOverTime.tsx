import { useMemo } from 'react';
import { HourSupply } from '../../hooks/useEnergyBreakdown';
import { AnalyticsCard } from './AnalyticsCard';
import { CHANNEL_COLORS, CHANNEL_LABELS, CHANNEL_ORDER } from './channels';

interface EnergyOverTimeProps {
  series: HourSupply[];
  currentHour: number;
  /**
   * Hours in the analysis period, so this shares the scrubber's domain.
   *
   * Zero when the backend has not reported yet, in which case the flow arrays
   * are the only truth available and are used whole. It must not fall back to a
   * fixed 24: the campus scenario is a two-day window and `meta.hours` is 48,
   * so a constant default would silently halve the chart.
   */
  totalHours: number;
}

/* A wide, short viewBox stretched to the strip's box. preserveAspectRatio is
   "none" so it fills the width rather than letterboxing; the strip's own aspect
   is close enough to 1200:96 that the ~9% horizontal squash on the strokes is
   not visible. */
const WIDTH = 1200;
const HEIGHT = 88;
const PAD = { top: 8, right: 0, bottom: 4, left: 0 };

const niceCeiling = (value: number): number => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  // Step up in 1 / 2 / 5 / 10 so the axis label is a round number.
  return [1, 2, 5, 10].map((m) => m * magnitude).find((c) => c >= value) ?? value;
};

/**
 * Supply per hour, one line per channel.
 *
 * Lines rather than a stacked area: the question this card answers is when each
 * source carries the community, and a stack makes every band except the bottom
 * one impossible to read against a baseline that keeps moving.
 */
export const EnergyOverTime: React.FC<EnergyOverTimeProps> = ({
  series: rawSeries,
  currentHour,
  totalHours,
}) => {
  // Clip to the analysis period so this and the scrubber share one domain.
  const series = useMemo(
    () =>
      totalHours > 0
        ? rawSeries.slice(0, Math.max(2, Math.min(rawSeries.length, totalHours)))
        : rawSeries,
    [rawSeries, totalHours]
  );

  const { paths, max, plotW, plotH } = useMemo(() => {
    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    if (series.length < 2) return { paths: [], max: 1, plotW, plotH };

    const peak = Math.max(...series.map((h) => Math.max(h.solar, h.shared, h.battery, h.grid)));
    const max = niceCeiling(peak);
    const x = (i: number) => PAD.left + (i / (series.length - 1)) * plotW;
    const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

    const paths = CHANNEL_ORDER.map((channel) => ({
      channel,
      d: series.map((hour, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(hour[channel]).toFixed(1)}`).join(''),
    }));
    return { paths, max, plotW, plotH };
  }, [series]);

  const markerX =
    series.length > 1
      ? PAD.left + (Math.min(currentHour, series.length - 1) / (series.length - 1)) * plotW
      : PAD.left;

  return (
    <AnalyticsCard title="Energy Over Time" meta={`0 – ${max.toLocaleString()} kWh per hour`}>
      {series.length < 2 ? (
        <p className="analytics-empty">No dispatch to chart yet.</p>
      ) : (
        <>
          <div className="analytics-plot">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="w-full h-[88px]" role="img"
               aria-label="Supply per hour by source">
            {/* Two gridlines only - the shape of the lines is the content. */}
            {[0, 0.5, 1].map((fraction) => {
              const y = PAD.top + plotH - fraction * plotH;
              return (
                <line key={fraction} x1={0} x2={WIDTH} y1={y} y2={y}
                      className="analytics-gridline" vectorEffect="non-scaling-stroke" />
              );
            })}

            {/* Where the timeline is sitting, so the chart and the map agree. */}
            <line x1={markerX} x2={markerX} y1={PAD.top} y2={PAD.top + plotH}
                  className="analytics-playhead" />

            {paths.map(({ channel, d }) => (
              <path key={channel} d={d} fill="none" stroke={CHANNEL_COLORS[channel]}
                    strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
            ))}

          </svg>
          </div>

          <ul className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
            {CHANNEL_ORDER.map((channel) => (
              <li key={channel} className="analytics-legend-row analytics-legend-row--inline">
                <span className="analytics-swatch analytics-swatch--line"
                      style={{ background: CHANNEL_COLORS[channel] }} aria-hidden />
                <span className="analytics-legend-name">{CHANNEL_LABELS[channel]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </AnalyticsCard>
  );
};

export default EnergyOverTime;
