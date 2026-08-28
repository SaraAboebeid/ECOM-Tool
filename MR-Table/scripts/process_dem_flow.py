"""
Process DEM to calculate stormwater flow direction and accumulation.
This script uses the D8 flow algorithm to determine flow paths and creates
a flow direction raster and flow accumulation raster for visualization.
"""

import numpy as np
import rasterio
from rasterio.transform import from_bounds, xy as rio_xy
from scipy.ndimage import generic_filter
import json
from pathlib import Path

def calculate_flow_direction_d8(dem):
    """
    Calculate flow direction using D8 algorithm.
    Returns flow direction codes:
    32  64  128
    16  0   1
    8   4   2
    0 means no flow (sink/flat area)
    """
    rows, cols = dem.shape
    flow_dir = np.zeros((rows, cols), dtype=np.uint8)
    
    # D8 neighbor offsets (row, col) and their direction codes
    neighbors = [
        (-1, 1, 128),  # NE
        (0, 1, 1),     # E
        (1, 1, 2),     # SE
        (1, 0, 4),     # S
        (1, -1, 8),    # SW
        (0, -1, 16),   # W
        (-1, -1, 32),  # NW
        (-1, 0, 64)    # N
    ]
    
    for i in range(1, rows - 1):
        for j in range(1, cols - 1):
            center_elev = dem[i, j]
            
            # Skip nodata values
            if np.isnan(center_elev):
                continue
            
            max_slope = -np.inf
            flow_direction = 0
            
            for dr, dc, direction_code in neighbors:
                ni, nj = i + dr, j + dc
                
                if 0 <= ni < rows and 0 <= nj < cols:
                    neighbor_elev = dem[ni, nj]
                    
                    if not np.isnan(neighbor_elev):
                        # Calculate slope (elevation difference / distance)
                        distance = np.sqrt(dr**2 + dc**2)
                        slope = (center_elev - neighbor_elev) / distance
                        
                        if slope > max_slope:
                            max_slope = slope
                            flow_direction = direction_code
            
            flow_dir[i, j] = flow_direction
    
    return flow_dir

def calculate_flow_accumulation(flow_dir):
    """
    Calculate flow accumulation from flow direction.
    This counts how many cells flow into each cell.
    """
    rows, cols = flow_dir.shape
    flow_acc = np.ones((rows, cols), dtype=np.float32)
    
    # Direction code to offset mapping
    dir_to_offset = {
        128: (-1, 1),   # NE
        1: (0, 1),      # E
        2: (1, 1),      # SE
        4: (1, 0),      # S
        8: (1, -1),     # SW
        16: (0, -1),    # W
        32: (-1, -1),   # NW
        64: (-1, 0)     # N
    }
    
    # Process cells from highest to lowest elevation
    # This ensures upstream cells are processed before downstream
    # For simplicity, we'll iterate multiple times
    for iteration in range(100):  # Usually converges quickly
        changed = False
        for i in range(rows):
            for j in range(cols):
                if flow_dir[i, j] == 0:
                    continue
                
                # Get downstream cell
                if flow_dir[i, j] in dir_to_offset:
                    dr, dc = dir_to_offset[flow_dir[i, j]]
                    ni, nj = i + dr, j + dc
                    
                    if 0 <= ni < rows and 0 <= nj < cols:
                        old_acc = flow_acc[ni, nj]
                        flow_acc[ni, nj] += flow_acc[i, j]
                        if flow_acc[ni, nj] != old_acc:
                            changed = True
        
        if not changed:
            break
    
    return flow_acc

def extract_flow_vectors(flow_dir, flow_acc, transform, dem_shape, threshold=10):
    """
    Extract flow vectors for visualization.
    Returns a list of flow lines with weights based on accumulation.
    """
    rows, cols = flow_dir.shape
    
    # Direction code to offset mapping
    dir_to_offset = {
        128: (-1, 1),   # NE
        1: (0, 1),      # E
        2: (1, 1),      # SE
        4: (1, 0),      # S
        8: (1, -1),     # SW
        16: (0, -1),    # W
        32: (-1, -1),   # NW
        64: (-1, 0)     # N
    }
    
    flow_lines = []
    
    # Only extract cells with significant flow accumulation
    for i in range(rows):
        for j in range(cols):
            if flow_dir[i, j] == 0 or flow_acc[i, j] < threshold:
                continue
            
            # Convert pixel coordinates to geographic coordinates
            x, y = rio_xy(transform, i, j)
            
            # Get flow direction
            if flow_dir[i, j] in dir_to_offset:
                dr, dc = dir_to_offset[flow_dir[i, j]]
                ni, nj = i + dr, j + dc
                
                if 0 <= ni < rows and 0 <= nj < cols:
                    nx, ny = rio_xy(transform, ni, nj)
                    
                    # Create flow vector
                    flow_lines.append({
                        'from': [x, y],
                        'to': [nx, ny],
                        'accumulation': float(flow_acc[i, j]),
                        'direction': int(flow_dir[i, j])
                    })
    
    return flow_lines

def create_flow_start_points(flow_acc, transform, spacing=5, min_accumulation=1):
    """
    Create starting points for particle animation.
    These are distributed across the DEM with density based on flow accumulation.
    """
    rows, cols = flow_acc.shape
    start_points = []
    
    # Sample points on a grid
    for i in range(0, rows, spacing):
        for j in range(0, cols, spacing):
            if flow_acc[i, j] >= min_accumulation and not np.isnan(flow_acc[i, j]):
                x, y = rio_xy(transform, i, j)
                
                # Add point with weight based on flow accumulation
                start_points.append({
                    'position': [x, y],
                    'weight': float(flow_acc[i, j])
                })
    
    return start_points

def main():
    """Main processing function."""
    print("Loading DEM...")
    dem_path = Path("../media/clipped_dem.geotiff.tif")
    
    if not dem_path.exists():
        print(f"Error: DEM file not found at {dem_path}")
        return
    
    # Read DEM
    with rasterio.open(dem_path) as src:
        dem = src.read(1)
        transform = src.transform
        crs = src.crs
        bounds = src.bounds
        profile = src.profile
        
        print(f"DEM shape: {dem.shape}")
        print(f"DEM bounds: {bounds}")
        print(f"DEM CRS: {crs}")
        print(f"DEM min elevation: {np.nanmin(dem):.2f}m")
        print(f"DEM max elevation: {np.nanmax(dem):.2f}m")
    
    # Fill nodata values with interpolation for better flow calculation
    print("\nPreprocessing DEM...")
    mask = np.isnan(dem)
    if mask.any():
        # Simple fill: use mean of valid neighbors
        from scipy.ndimage import generic_filter
        def fill_func(x):
            valid = x[~np.isnan(x)]
            return np.mean(valid) if len(valid) > 0 else np.nan
        
        dem_filled = generic_filter(dem, fill_func, size=3, mode='constant', cval=np.nan)
        dem = np.where(mask, dem_filled, dem)
    
    # Calculate flow direction
    print("Calculating flow direction...")
    flow_dir = calculate_flow_direction_d8(dem)
    
    # Calculate flow accumulation
    print("Calculating flow accumulation...")
    flow_acc = calculate_flow_accumulation(flow_dir)
    
    print(f"Max flow accumulation: {np.max(flow_acc):.0f} cells")
    
    # Save flow direction raster
    print("\nSaving flow direction raster...")
    profile.update(dtype=rasterio.uint8, count=1, nodata=0)
    with rasterio.open("media/flow_direction.tif", 'w', **profile) as dst:
        dst.write(flow_dir, 1)
    
    # Save flow accumulation raster
    print("Saving flow accumulation raster...")
    profile.update(dtype=rasterio.float32, nodata=-9999)
    with rasterio.open("media/flow_accumulation.tif", 'w', **profile) as dst:
        dst.write(flow_acc, 1)
    
    # Extract flow vectors for visualization
    print("Extracting flow vectors...")
    flow_lines = extract_flow_vectors(flow_dir, flow_acc, transform, dem.shape, threshold=50)
    print(f"Extracted {len(flow_lines)} flow lines")
    
    # Create particle start points
    print("Creating particle start points...")
    start_points = create_flow_start_points(flow_acc, transform, spacing=3, min_accumulation=1)
    print(f"Created {len(start_points)} start points")
    
    # Convert CRS info to JSON-serializable format
    crs_info = {
        'epsg': int(crs.to_epsg()) if crs.to_epsg() else None,
        'wkt': crs.to_wkt()
    }
    
    # Save flow data as JSON
    print("Saving flow data...")
    flow_data = {
        'bounds': {
            'west': bounds.left,
            'south': bounds.bottom,
            'east': bounds.right,
            'north': bounds.top
        },
        'crs': crs_info,
        'transform': {
            'a': transform.a,
            'b': transform.b,
            'c': transform.c,
            'd': transform.d,
            'e': transform.e,
            'f': transform.f
        },
        'shape': {
            'rows': int(dem.shape[0]),
            'cols': int(dem.shape[1])
        },
        'elevation': {
            'min': float(np.nanmin(dem)),
            'max': float(np.nanmax(dem))
        },
        'flow_lines': flow_lines[:5000],  # Limit for file size
        'start_points': start_points[:1000]  # Limit for performance
    }
    
    output_path = Path("media/flow_data.json")
    with open(output_path, 'w') as f:
        json.dump(flow_data, f, indent=2)
    
    print(f"\n✓ Flow data saved to {output_path}")
    print("\nSummary:")
    print(f"  - Flow direction raster: media/flow_direction.tif")
    print(f"  - Flow accumulation raster: media/flow_accumulation.tif")
    print(f"  - Flow visualization data: media/flow_data.json")
    print(f"  - Total flow lines: {len(flow_lines)}")
    print(f"  - Total start points: {len(start_points)}")

if __name__ == "__main__":
    main()
