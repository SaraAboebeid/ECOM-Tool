#!/usr/bin/env python3
"""
Verify the normalized flow data format.
Quick check to ensure the coordinate transformation worked correctly.
"""

import json
from pathlib import Path

def main():
    script_dir = Path(__file__).parent
    flow_data_path = script_dir / "media" / "flow_data.json"
    
    if not flow_data_path.exists():
        print(f"❌ Error: {flow_data_path} not found")
        return
    
    print("Loading flow data...")
    with open(flow_data_path, 'r') as f:
        data = json.load(f)
    
    print("\n✓ Flow data loaded successfully\n")
    
    # Check coordinate system
    print(f"Coordinate System: {data.get('coordinate_system', 'UNKNOWN')}")
    print(f"Description: {data.get('description', 'N/A')}\n")
    
    # Check bounds
    print("Original Bounds (EPSG:3006):")
    bounds = data.get('bounds', {})
    print(f"  West: {bounds.get('west'):.1f}m")
    print(f"  South: {bounds.get('south'):.1f}m")
    print(f"  East: {bounds.get('east'):.1f}m")
    print(f"  North: {bounds.get('north'):.1f}m")
    
    if 'bounds_wgs84' in data and data['bounds_wgs84']:
        print("\nWGS84 Bounds (for reference):")
        wgs84 = data['bounds_wgs84']
        print(f"  West: {wgs84.get('west'):.6f}°")
        print(f"  South: {wgs84.get('south'):.6f}°")
        print(f"  East: {wgs84.get('east'):.6f}°")
        print(f"  North: {wgs84.get('north'):.6f}°")
    
    # Check flow lines
    flow_lines = data.get('flow_lines', [])
    print(f"\n✓ Flow Lines: {len(flow_lines)}")
    
    if flow_lines:
        sample = flow_lines[0]
        print("\nSample Flow Line:")
        print(f"  from_x_norm: {sample.get('from_x_norm', 'N/A')}")
        print(f"  from_y_norm: {sample.get('from_y_norm', 'N/A')}")
        print(f"  to_x_norm: {sample.get('to_x_norm', 'N/A')}")
        print(f"  to_y_norm: {sample.get('to_y_norm', 'N/A')}")
        print(f"  accumulation: {sample.get('accumulation', 'N/A')}")
        print(f"  direction: {sample.get('direction', 'N/A')}")
        
        # Verify normalized coordinates are in 0-1 range
        all_x = []
        all_y = []
        for line in flow_lines[:100]:  # Check first 100
            all_x.extend([line.get('from_x_norm'), line.get('to_x_norm')])
            all_y.extend([line.get('from_y_norm'), line.get('to_y_norm')])
        
        min_x, max_x = min(all_x), max(all_x)
        min_y, max_y = min(all_y), max(all_y)
        
        print(f"\n  Normalized X range (first 100): {min_x:.4f} to {max_x:.4f}")
        print(f"  Normalized Y range (first 100): {min_y:.4f} to {max_y:.4f}")
        
        if min_x >= 0 and max_x <= 1 and min_y >= 0 and max_y <= 1:
            print("  ✓ Coordinates are properly normalized to 0-1 range")
        else:
            print("  ⚠ Warning: Some coordinates outside 0-1 range")
    
    # Check start points
    start_points = data.get('start_points', [])
    print(f"\n✓ Start Points: {len(start_points)}")
    
    if start_points:
        sample = start_points[0]
        print("\nSample Start Point:")
        print(f"  position_norm: {sample.get('position_norm', 'N/A')}")
        print(f"  weight: {sample.get('weight', 'N/A')}")
        
        # Verify normalized coordinates
        all_pos = [p.get('position_norm', [0, 0]) for p in start_points[:100]]
        all_x = [pos[0] for pos in all_pos]
        all_y = [pos[1] for pos in all_pos]
        
        min_x, max_x = min(all_x), max(all_x)
        min_y, max_y = min(all_y), max(all_y)
        
        print(f"\n  Normalized X range (first 100): {min_x:.4f} to {max_x:.4f}")
        print(f"  Normalized Y range (first 100): {min_y:.4f} to {max_y:.4f}")
        
        if min_x >= 0 and max_x <= 1 and min_y >= 0 and max_y <= 1:
            print("  ✓ Coordinates are properly normalized to 0-1 range")
        else:
            print("  ⚠ Warning: Some coordinates outside 0-1 range")
    
    print("\n" + "="*60)
    print("✓ Verification complete!")
    print("="*60)
    print("\nTo use in JavaScript:")
    print("  // Scale normalized coords to canvas pixels")
    print("  const pixel_x = normalized_x * canvas.width;")
    print("  const pixel_y = normalized_y * canvas.height;")

if __name__ == "__main__":
    main()
