import { Node, Link } from '../../types';
import FlowCharts from './components/FlowCharts';
import { useGraphData } from '../../hooks/useGraphData';

interface NodeDetailsPanelProps {
  selectedNode: Node | null;
  onClose: () => void;
  links?: Link[];
  /**
   * Every node from the dispatch, before filtering.
   *
   * Roof arrays are hidden from the map - the building already shows a PV badge
   * and its combined capacity - but their per-array detail still has to be
   * reachable, so it is listed here on the building that owns them.
   */
  allNodes?: Node[];
}

/**
 * Side panel component for displaying detailed node information
 */
export const NodeDetailsPanel: React.FC<NodeDetailsPanelProps> = ({
  selectedNode, onClose, links = [], allNodes = [],
}) => {
  if (!selectedNode) return null;

  /** Roof arrays mounted on this building. Ids are '<host>_PV_<plant>'. */
  const roofArrays = selectedNode.type === 'building'
    ? allNodes.filter(
        (n) => n.type === 'pv' && n.id.startsWith(`${selectedNode.id}_PV_`)
      )
    : [];

  const getAttributesByNodeType = () => {
    switch(selectedNode.type) {
      case 'building':
        return (
          <div className="space-y-3">
            {selectedNode.building_type && (
              <div>
                <span className="font-semibold">Building Type:</span> {selectedNode.building_type}
              </div>
            )}
            {selectedNode.area && (
              <div>
                <span className="font-semibold">Area:</span> {selectedNode.area.toFixed(2)} m²
              </div>
            )}
            {selectedNode.owner && (
              <div>
                <span className="font-semibold">Owner:</span> {selectedNode.owner}
              </div>
            )}
            {selectedNode.total_energy_demand && (
              <div>
                <span className="font-semibold">Energy Demand:</span> {selectedNode.total_energy_demand.toFixed(2)} kWh
              </div>
            )}
            {selectedNode.total_pv_capacity && (
              <div>
                <span className="font-semibold">PV Capacity:</span> {selectedNode.total_pv_capacity.toFixed(2)} kW
                {roofArrays.length > 0 && (
                  <ul className="mt-1 ml-1 pl-2 border-l-2 border-amber-300 dark:border-amber-600 space-y-0.5">
                    {roofArrays.map((array) => (
                      <li key={array.id} className="text-[11px] text-gray-600 dark:text-gray-400">
                        <span className="text-amber-600 dark:text-amber-400">
                          {array.name || array.id.split('_PV_')[1]}
                        </span>
                        {array.installed_capacity != null &&
                          ` — ${array.installed_capacity.toFixed(1)} kW`}
                        {array.annual_production != null &&
                          ` · ${(array.annual_production / 1000).toFixed(1)} MWh/yr`}
                        {array.custom_slope != null && ` · ${array.custom_slope}° tilt`}
                        {array.azimuth != null && ` · ${array.azimuth}° azimuth`}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );

      case 'pv':
        return (
          <div className="space-y-3">
            {selectedNode.installed_capacity && (
              <div>
                <span className="font-semibold">Capacity:</span> {selectedNode.installed_capacity.toFixed(2)} kW
              </div>
            )}
            {selectedNode.annual_production && (
              <div>
                <span className="font-semibold">Annual Production:</span> {selectedNode.annual_production.toFixed(2)} kWh
              </div>
            )}
            {selectedNode.total_cost && (
              <div>
                <span className="font-semibold">Total Cost:</span> {selectedNode.total_cost.toFixed(2)} SEK
              </div>
            )}
            {selectedNode.total_embodied_co2 && (
              <div>
                <span className="font-semibold">Embodied CO₂:</span> {selectedNode.total_embodied_co2.toFixed(2)} kgCO₂e
              </div>
            )}
          </div>
        );

      case 'battery':
        return (
          <div className="space-y-3">
            {selectedNode.capacity && (
              <div>
                <span className="font-semibold">Capacity:</span> {selectedNode.capacity.toFixed(2)} kWh
              </div>
            )}
            {selectedNode.total_cost && (
              <div>
                <span className="font-semibold">Cost:</span> {selectedNode.total_cost.toFixed(2)} SEK
              </div>
            )}
            {selectedNode.total_embodied_co2 && (
              <div>
                <span className="font-semibold">Embodied CO₂:</span> {selectedNode.total_embodied_co2.toFixed(2)} kgCO₂e
              </div>
            )}
          </div>
        );

      case 'charge_point':
        return (
          <div className="space-y-3">
            {selectedNode.capacity && (
              <div>
                <span className="font-semibold">Capacity:</span> {selectedNode.capacity.toFixed(2)} kW
              </div>
            )}
            {selectedNode.is_v2g !== undefined && (
              <div>
                <span className="font-semibold">V2G Enabled:</span> {selectedNode.is_v2g ? 'Yes' : 'No'}
              </div>
            )}
            {selectedNode.total_connected_evs && (
              <div>
                <span className="font-semibold">Connected EVs:</span> {selectedNode.total_connected_evs}
              </div>
            )}
            {selectedNode.owner && (
              <div>
                <span className="font-semibold">Owner:</span> {selectedNode.owner}
              </div>
            )}
          </div>
        );

      case 'grid':
        return (
          <div className="space-y-3">
            <div className="text-gray-600 dark:text-gray-400">
              Grid connection point for energy exchange
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div 
      className={`node-details-panel fixed top-0 right-0 h-full bg-white dark:bg-gray-800 w-80 shadow-lg transform transition-transform duration-300 ease-in-out ${
        selectedNode ? 'translate-x-0' : 'translate-x-full'
      } z-10 overflow-y-auto`}
    >
      <div className="p-6">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            Node Details
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Node info */}
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {selectedNode.name || selectedNode.id}
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 capitalize">
              {selectedNode.type} Node
            </p>
          </div>

          <div className="border-t pt-4 text-sm text-gray-700 dark:text-gray-300">
            <div className="space-y-2">
              <div>
                <span className="font-semibold">ID:</span> {selectedNode.id}
              </div>
              {getAttributesByNodeType()}
              
              {/* Add the flow charts if we have links */}
              {links && links.length > 0 && (
                <FlowCharts node={selectedNode} links={links} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NodeDetailsPanel;
