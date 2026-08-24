import { useMemo } from 'react';
import { GraphData } from '../types';

/**
 * Per-hour supply mix, derived from the dispatch rather than stored separately.
 *
 * Every link carries an hourly flow array, and a link's source type says what
 * kind of energy it is - so summing the links by source type reproduces the
 * breakdown without the backend needing to publish a second copy that could
 * drift from the flows the map draws.
 *
 * The four channels are the ways a building's demand can be met:
 *   solar     pv -> building, generation consumed where it is produced
 *   shared    building -> building, the point of the community
 *   battery   battery -> building, stored energy returned
 *   grid      grid -> building, what had to be imported
 */
export type SupplyChannel = 'solar' | 'shared' | 'battery' | 'grid';

export interface HourSupply {
  solar: number;
  shared: number;
  battery: number;
  grid: number;
  total: number;
}

export interface EnergyBreakdown {
  /** One entry per dispatched hour. */
  series: HourSupply[];
  /** Sum over the whole horizon. */
  totals: HourSupply;
  /** Locally-met share of demand over the horizon, as a percentage. */
  selfSufficiency: number;
  /** Hour index carrying the highest total demand. */
  peakHour: number;
  hours: number;
}

const EMPTY: HourSupply = { solar: 0, shared: 0, battery: 0, grid: 0, total: 0 };

/** Which channel a link feeds, or null if it is not supply to a building. */
const channelFor = (
  sourceType: string | undefined,
  targetType: string | undefined
): SupplyChannel | null => {
  // Only links that end at a building are supply; a building charging the
  // battery is a transfer, and counting it would double-count the energy when
  // the battery later discharges it back.
  if (targetType !== 'building') return null;
  switch (sourceType) {
    case 'pv':
      return 'solar';
    case 'building':
      return 'shared';
    case 'battery':
      return 'battery';
    case 'grid':
      return 'grid';
    default:
      return null;
  }
};

export const useEnergyBreakdown = (data: GraphData | null): EnergyBreakdown => {
  return useMemo(() => {
    const links = data?.links ?? [];
    const nodes = data?.nodes ?? [];
    if (!links.length) {
      return { series: [], totals: { ...EMPTY }, selfSufficiency: 0, peakHour: 0, hours: 0 };
    }

    const typeOf = new Map<string, string>();
    for (const node of nodes) typeOf.set(node.id, node.type);

    // A link's endpoint is an id before D3 runs and a node object after, so it
    // has to be read both ways - the same graph object backs the map.
    const idOf = (end: unknown): string =>
      typeof end === 'string' ? end : ((end as { id: string })?.id ?? '');

    const hours = Math.max(...links.map((l) => (l as any).flow?.length ?? 0), 0);
    const series: HourSupply[] = Array.from({ length: hours }, () => ({ ...EMPTY }));

    for (const link of links) {
      const channel = channelFor(
        typeOf.get(idOf((link as any).source)),
        typeOf.get(idOf((link as any).target))
      );
      if (!channel) continue;

      const flow = (link as any).flow as number[] | undefined;
      if (!flow) continue;

      for (let hour = 0; hour < flow.length; hour += 1) {
        // Guard against a null or NaN in the dispatch rather than letting it
        // poison every downstream total.
        const value = Number(flow[hour]);
        if (!Number.isFinite(value) || value <= 0) continue;
        series[hour][channel] += value;
        series[hour].total += value;
      }
    }

    const totals = series.reduce<HourSupply>(
      (acc, hour) => ({
        solar: acc.solar + hour.solar,
        shared: acc.shared + hour.shared,
        battery: acc.battery + hour.battery,
        grid: acc.grid + hour.grid,
        total: acc.total + hour.total,
      }),
      { ...EMPTY }
    );

    // Prefer the optimiser's own figure: it is computed against total demand,
    // which includes any demand the dispatch could not serve, so it is not
    // always the same as the locally-supplied share of what was served.
    const local = totals.solar + totals.shared + totals.battery;
    const reported = (data as any)?.kpis?.self_sufficiency;
    const selfSufficiency = Number.isFinite(reported)
      ? Number(reported)
      : totals.total > 0
        ? (local / totals.total) * 100
        : 0;

    let peakHour = 0;
    for (let hour = 1; hour < series.length; hour += 1) {
      if (series[hour].total > series[peakHour].total) peakHour = hour;
    }

    return { series, totals, selfSufficiency, peakHour, hours };
  }, [data]);
};

export default useEnergyBreakdown;
