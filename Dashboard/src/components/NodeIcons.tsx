import React from 'react';

// Material Symbols using span elements for each node type
export const NodeIcons = {
  building: <span className="material-symbols-outlined node-icon">apartment</span>,
  pv: <span className="material-symbols-outlined node-icon">wb_sunny</span>,
  grid: <span className="material-symbols-outlined node-icon">grid_on</span>,
  battery: <span className="material-symbols-outlined node-icon">battery_charging_full</span>,
  charge_point: <span className="material-symbols-outlined node-icon">ev_station</span>
};

// Function to get the icon name based on node type
const getIconName = (nodeType: string): string => {
  switch (nodeType) {
    case 'building':
      return 'apartment';
    case 'pv':
      return 'wb_sunny';
    case 'grid':
      return 'grid_on';
    case 'battery':
      return 'battery_charging_full';
    case 'charge_point':
      return 'ev_station';
    default:
      return '';
  }
};

// Function to convert Material Symbol to string for D3
export const iconToString = (nodeType: string): string => {
  const iconName = getIconName(nodeType);
  if (!iconName) return '';
  
  // Create a span element with the Material Symbol
  const span = document.createElement('span');
  span.className = 'material-symbols-outlined node-icon';
  span.textContent = iconName;
  span.style.color = 'white'; // Ensure icon is white for visibility
  span.style.fontSize = '24px'; // Ensure consistent size
  
  // Force font to load and be available
  document.fonts.ready.then(() => {
    console.log('Material Symbols font is loaded and ready');
  });
  
  // Return the HTML as a string
  return span.outerHTML;
};
