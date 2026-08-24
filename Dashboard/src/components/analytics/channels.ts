import { SupplyChannel } from '../../hooks/useEnergyBreakdown';

/**
 * Colours for the supply channels.
 *
 * Deliberately not NODE_COLORS: those are tuned to glow on the dark map, and
 * the neon yellow and cyan sit at 1.1-1.3:1 against a card surface. These are
 * the same hues pulled to a legible weight, in the same order the map draws
 * them so the two still read as one system.
 */
export const CHANNEL_COLORS: Record<SupplyChannel, string> = {
  solar: '#f5c542',
  shared: '#c471ed',
  battery: '#f97316',
  grid: '#22d3ee',
};

export const CHANNEL_LABELS: Record<SupplyChannel, string> = {
  solar: 'Solar',
  shared: 'Shared',
  battery: 'Battery',
  grid: 'Grid',
};

/** Drawn in this order everywhere: local supply first, import last. */
export const CHANNEL_ORDER: SupplyChannel[] = ['solar', 'shared', 'battery', 'grid'];
