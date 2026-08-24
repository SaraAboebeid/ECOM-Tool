import React, { useState } from 'react';

interface DashboardHeaderProps {
  data?: {
    nodes: any[];
    links: any[];
    kpis?: {
      total_demand: number;
      total_grid_import: number;
      total_grid_export: number;
      total_pv_used: number;
      total_pv_gen: number;
      self_sufficiency: number;
      self_consumption: number;
      avg_grid_carbon_intensity: number;
      total_grid_carbon_import: number;
      avg_grid_price_import: number;
      avg_building_self_consumption: number;
      building_self_consumption: Record<string, number>;
    };
  };
  currentHour: number;
  onKPICalculated?: (kpis: {
    totalPVCapacity: number;
    totalEnergyDemand: number;
    totalBatteryCapacity: number;
    totalPVProduction: number;
    totalEmbodiedCO2: number;
  }) => void;
}

/**
 * Icon tints, one hue per metric. Tailwind classes rather than inline styles so
 * they follow the dark-mode toggle without any JS.
 */
const TINTS = {
  sky: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
  amber: 'bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300',
  emerald: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
  indigo: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
  slate: 'bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300',
} as const;

const StatCard = ({
  icon, label, value, tint = 'slate',
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tint?: keyof typeof TINTS;
}) => (
  <div className="header-kpi-card">
    <span className={`header-kpi-icon ${TINTS[tint]}`}>{icon}</span>
    <span>
      <span className="header-kpi-label block">{label}</span>
      <span className="header-kpi-value block">{value}</span>
    </span>
  </div>
);

export const DashboardHeader = ({ data, currentHour }: DashboardHeaderProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Calculate community-wide KPIs
  const calculateKPIs = () => {
    if (!data?.nodes.length) return null;

    const kpis = {
      totalNodes: data.nodes.length,
      totalConnections: data.links.length,
      pvNodes: data.nodes.filter(n => n.type === 'pv').length,
      batteryNodes: data.nodes.filter(n => n.type === 'battery').length,
      buildingNodes: data.nodes.filter(n => n.type === 'building').length,
      chargePointNodes: data.nodes.filter(n => n.type === 'charge_point').length,
      totalPVCapacity: data.nodes
        .filter(n => n.type === 'pv')
        .reduce((sum, n) => sum + (n.total_pv_capacity || n.installed_capacity || 0), 0),
      totalBatteryCapacity: data.nodes
        .filter(n => n.type === 'battery')
        .reduce((sum, n) => sum + (n.capacity || n.installed_capacity || 0), 0),
      totalChargePoints: data.nodes
        .filter(n => n.type === 'charge_point')
        .reduce((sum, n) => sum + (n.total_connected_evs || 1), 0),
      v2gCapableChargers: data.nodes
        .filter(n => n.type === 'charge_point' && n.is_v2g).length,
      totalEnergyDemand: data.nodes
        .filter(n => n.type === 'building')
        .reduce((sum, n) => sum + (n.total_energy_demand || 0), 0)
    };

    return kpis;
  };

  const kpis = calculateKPIs();

  const formatTime = (hour: number) => {
    const period = hour % 24;
    const ampm = period < 12 ? 'AM' : 'PM';
    const displayHour = period % 12 || 12;
    const day = Math.floor(hour / 24) + 1;
    return `Day ${day}, ${displayHour}:00 ${ampm}`;
  };

  const formatNumber = (num: number, unit = '') => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}M${unit}`;
    } else if (num >= 1000) {
      return `${(num / 1000).toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}k${unit}`;
    }
    return `${num.toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${unit}`;
  };
  
  const formatEnergyToMWh = (kWh: number) => {
    const mWh = kWh / 1000;
    return `${mWh.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} MWh`;
  };
  
  const formatPercentage = (value: number) => {
    return `${value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}%`;
  };

  return (
    <div className="dashboard-header border-b border-slate-200/70 dark:border-slate-700/70 shadow-sm">
      <div className="w-full px-4 sm:px-5 lg:px-6">
        <div className="py-2.5">
          {/* Main Header with Inline Stats */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center space-x-3 min-w-0">
              <div className="h-9 w-9 rounded-xl flex items-center justify-center bg-cyan-100/85 dark:bg-cyan-900/35 border border-cyan-300/60 dark:border-cyan-700/50">
                <EnergyIcon className="w-5 h-5 text-cyan-600 dark:text-cyan-300" />
              </div>
              <div>
                <h1 className="text-base sm:text-lg font-semibold tracking-[0.02em] text-slate-900 dark:text-slate-100">
                  Energy Community Dashboard
                </h1>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 tracking-[0.08em] uppercase">
                  Real-time campus energy flexibility
                </p>
              </div>
            </div>

            {/* Stat row. Scrolls rather than wraps, so the header keeps its
                height on narrow windows instead of pushing the map down. */}
            {kpis && (
              <div className="hidden lg:flex items-center gap-2 flex-1 justify-end
                              overflow-x-auto no-scrollbar">
                <StatCard
                  tint="sky"
                  icon={<AssetsIcon />}
                  label="Assets"
                  value={kpis.totalNodes}
                />
                <StatCard
                  tint="amber"
                  icon={<SolarIcon />}
                  label="Solar"
                  value={formatNumber(kpis.totalPVCapacity, 'W')}
                />
                <StatCard
                  tint="emerald"
                  icon={<BatteryIcon />}
                  label="Battery"
                  value={formatNumber(kpis.totalBatteryCapacity, 'Wh')}
                />
                <StatCard
                  tint="indigo"
                  icon={<BuildingsIcon />}
                  label="Buildings"
                  value={kpis.buildingNodes}
                />
                <StatCard
                  tint="emerald"
                  icon={<LeafIcon />}
                  label="Self-Sufficiency"
                  value={data.kpis ? formatPercentage(data.kpis.self_sufficiency) : 'N/A'}
                />
              </div>
            )}

            {/* The timeline already shows the current hour, so a Current Time
                card here just repeated it. */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="px-3 py-2 text-[11px] font-semibold rounded-xl transition-colors duration-200 flex items-center gap-1.5 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
              >
                <span>{isExpanded ? 'Hide' : 'Details'}</span>
                <ChevronIcon className={`w-3 h-3 transform transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
              </button>
            </div>
          </div>

          {/* Below lg the row above is hidden, so the same cards wrap into a
              grid here. Same component, so the two never drift apart. */}
          {kpis && (
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 lg:hidden">
              <StatCard tint="sky" icon={<AssetsIcon />} label="Assets"
                        value={kpis.totalNodes} />
              <StatCard tint="amber" icon={<SolarIcon />} label="Solar"
                        value={formatNumber(kpis.totalPVCapacity, 'W')} />
              <StatCard tint="emerald" icon={<BatteryIcon />} label="Battery"
                        value={formatNumber(kpis.totalBatteryCapacity, 'Wh')} />
              <StatCard tint="indigo" icon={<BuildingsIcon />} label="Buildings"
                        value={kpis.buildingNodes} />
              <StatCard tint="emerald" icon={<LeafIcon />} label="Self-Sufficiency"
                        value={data?.kpis ? formatPercentage(data.kpis.self_sufficiency) : 'N/A'} />
            </div>
          )}

          {/* Expanded Details */}
          {isExpanded && kpis && (
            <div className="mt-3 bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-3">
                Energy Community Overview
              </h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {/* Infrastructure Summary */}
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-gray-900 dark:text-white">Infrastructure</h4>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Solar Installations:</span>
                      <span className="font-medium">{kpis.pvNodes}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Battery Systems:</span>
                      <span className="font-medium">{kpis.batteryNodes}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Connected Buildings:</span>
                      <span className="font-medium">{kpis.buildingNodes}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Network Connections:</span>
                      <span className="font-medium">{kpis.totalConnections}</span>
                    </div>
                  </div>
                </div>

                {/* Energy Summary */}
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-gray-900 dark:text-white">Energy</h4>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Total Demand:</span>
                      <span className="font-medium">{data.kpis ? formatEnergyToMWh(data.kpis.total_demand) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Grid Import:</span>
                      <span className="font-medium">{data.kpis ? formatEnergyToMWh(data.kpis.total_grid_import) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Grid Export:</span>
                      <span className="font-medium">{data.kpis ? formatEnergyToMWh(data.kpis.total_grid_export) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">PV Generated:</span>
                      <span className="font-medium">{data.kpis ? formatEnergyToMWh(data.kpis.total_pv_gen) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">PV Used:</span>
                      <span className="font-medium">{data.kpis ? formatEnergyToMWh(data.kpis.total_pv_used) : 'N/A'}</span>
                    </div>
                  </div>
                </div>

                {/* Efficiency Summary */}
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-gray-900 dark:text-white">Efficiency</h4>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Self-Sufficiency:</span>
                      <span className="font-medium">{data.kpis ? formatPercentage(data.kpis.self_sufficiency) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Self-Consumption:</span>
                      <span className="font-medium">{data.kpis ? formatPercentage(data.kpis.self_consumption) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Avg. Building Self-Consumption:</span>
                      <span className="font-medium">{data.kpis ? formatPercentage(data.kpis.avg_building_self_consumption) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Grid Carbon Intensity:</span>
                      <span className="font-medium">{data.kpis ? formatNumber(data.kpis.avg_grid_carbon_intensity) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Grid Carbon Import:</span>
                      <span className="font-medium">{data.kpis ? formatNumber(data.kpis.total_grid_carbon_import) : 'N/A'}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Additional Capacity Section */}
              <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-gray-900 dark:text-white">Capacity</h4>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Total PV Capacity:</span>
                      <span className="font-medium">{formatNumber(kpis.totalPVCapacity, 'W')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Battery Storage:</span>
                      <span className="font-medium">{formatNumber(kpis.totalBatteryCapacity, 'Wh')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Energy Demand:</span>
                      <span className="font-medium">{formatNumber(kpis.totalEnergyDemand, 'Wh')}</span>
                    </div>
                  </div>
                </div>

                {/* Mobility Summary */}
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-gray-900 dark:text-white">E-Mobility</h4>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Charging Stations:</span>
                      <span className="font-medium">{kpis.chargePointNodes}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Connected EVs:</span>
                      <span className="font-medium">{kpis.totalChargePoints}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">V2G Capable:</span>
                      <span className="font-medium">{kpis.v2gCapableChargers}</span>
                    </div>
                  </div>
                </div>

                {/* Pricing Summary */}
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-gray-900 dark:text-white">Pricing</h4>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-300">Avg. Grid Price Import:</span>
                      <span className="font-medium">{data.kpis ? formatNumber(data.kpis.avg_grid_price_import) : 'N/A'}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Community Description */}
              <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <p className="text-xs text-blue-800 dark:text-blue-200">
                  <strong>About this Energy Community:</strong> This dashboard visualizes a digital twin of a distributed energy community 
                  featuring renewable energy generation, energy storage, smart buildings, and electric vehicle charging infrastructure. 
                  The simulation shows real-time energy flows and demonstrates how different stakeholders interact within the community 
                  to optimize energy usage, reduce costs, and minimize environmental impact.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Icons
/* Stat-card icons. Stroked, 1.7px, on a 24 viewbox so they sit consistently
   inside the 32px tinted tile. */
const I = (d: string) => ({ className = 'w-[18px] h-[18px]' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

const AssetsIcon = I('M4 20h16M6 20V9l6-4 6 4v11M10 20v-4h4v4');
const SolarIcon = ({ className = 'w-[18px] h-[18px]' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.7} strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </svg>
);
const BatteryIcon = ({ className = 'w-[18px] h-[18px]' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="6" y="3" width="12" height="18" rx="3" />
    <path d="M10 1.5h4" />
    <path d="M12 8l-2 4h4l-2 4" />
  </svg>
);
const BuildingsIcon = I('M4 21V7l6-3v17M14 21V10l6 3v8M7 10h.01M7 14h.01M17 15h.01');
const LeafIcon = I('M20 4c0 9-6 13-11 13a5 5 0 0 1-5-5C4 7 10 4 20 4zM4 20c2-4 5-6.5 9-8');
const ClockIcon = ({ className = 'w-[18px] h-[18px]' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

const EnergyIcon = ({ className = "w-6 h-6" }) => (
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
      d="M13 10V3L4 14h7v7l9-11h-7z"
    />
  </svg>
);

const ChevronIcon = ({ className = "w-4 h-4" }) => (
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
      d="m19 9-7 7-7-7"
    />
  </svg>
);
