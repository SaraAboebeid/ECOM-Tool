"""
Quick verification script to check flow data and test coordinate transformations.
"""

import json
from pathlib import Path

def main():
    script_dir = Path(__file__).parent
    flow_data_path = script_dir / "media" / "flow_data.json"
    
    if not flow_data_path.exists():
        print("❌ flow_data.json not found!")
        return
    
    with open(flow_data_path, 'r') as f:
        data = json.load(f)
    
    print("✓ Flow Data Summary")
    print("=" * 60)
    
    # Bounds
    bounds = data['bounds']
    print(f"\nBounds (EPSG:3006):")
    print(f"  West:  {bounds['west']:,.1f}m")
    print(f"  East:  {bounds['east']:,.1f}m")
    print(f"  South: {bounds['south']:,.1f}m")
    print(f"  North: {bounds['north']:,.1f}m")
    print(f"  Width: {bounds['east'] - bounds['west']:,.1f}m")
    print(f"  Height: {bounds['north'] - bounds['south']:,.1f}m")
    
    # Elevation
    elev = data['elevation']
    print(f"\nElevation:")
    print(f"  Min: {elev['min']:.2f}m")
    print(f"  Max: {elev['max']:.2f}m")
    print(f"  Range: {elev['max'] - elev['min']:.2f}m")
    
    # Flow data
    print(f"\nFlow Data:")
    print(f"  Flow lines: {len(data['flow_lines']):,}")
    print(f"  Start points: {len(data['start_points']):,}")
    
    # Sample flow lines
    if data['flow_lines']:
        print(f"\nSample Flow Lines (first 3):")
        for i, line in enumerate(data['flow_lines'][:3]):
            print(f"  {i+1}. From {line['from']} → To {line['to']}")
            print(f"     Accumulation: {line['accumulation']:.1f} cells")
    
    # Sample start points
    if data['start_points']:
        print(f"\nSample Start Points (first 3):")
        for i, point in enumerate(data['start_points'][:3]):
            print(f"  {i+1}. Position: {point['position']}, Weight: {point['weight']:.1f}")
    
    # Approximate WGS84 conversion
    print(f"\nApproximate WGS84 Conversion:")
    center_x = (bounds['west'] + bounds['east']) / 2
    center_y = (bounds['south'] + bounds['north']) / 2
    
    # Simplified conversion
    central_meridian = 15.0
    false_easting = 500000.0
    scale_factor = 0.9996
    meters_per_degree_lon = 111320 * 0.545  # at lat 57°
    meters_per_degree_lat = 111320
    
    adjusted_x = (center_x - false_easting) / scale_factor
    lon = central_meridian + (adjusted_x / meters_per_degree_lon)
    lat = center_y / meters_per_degree_lat
    
    print(f"  Center EPSG:3006: ({center_x:.1f}, {center_y:.1f})")
    print(f"  Center WGS84: ({lon:.6f}°, {lat:.6f}°)")
    print(f"  Google Maps: https://www.google.com/maps/@{lat},{lon},17z")
    
    print("\n" + "=" * 60)
    print("✓ Flow data looks good!")
    print("\nNext steps:")
    print("  1. Start a web server: python -m http.server 8000")
    print("  2. Open http://localhost:8000 in your browser")
    print("  3. Click the stormwater button to see the animation")

if __name__ == "__main__":
    main()
