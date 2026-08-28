"""
Process DEM to calculate stormwater flow direction and accumulation.
This script uses the D8 flow algorithm to determine flow paths and creates
a flow direction raster and flow accumulation raster for visualization.
"""

import numpy as np
import rasterio
from rasterio.transform import from_bounds, xy as rio_xy
from rasterio.warp import transform as rasterio_warp_transform
from pyproj import Transformer
from scipy.ndimage import generic_filter
import json
from pathlib import Path
from PIL import Image

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
    Uses double precision to avoid overflow.
    """
    rows, cols = flow_dir.shape
    flow_acc = np.ones((rows, cols), dtype=np.float64)
    
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
    
    # Track which cells have been processed
    processed = np.zeros((rows, cols), dtype=bool)
    
    # Process cells multiple times until convergence
    max_iterations = 50
    for iteration in range(max_iterations):
        changed = False
        for i in range(rows):
            for j in range(cols):
                if flow_dir[i, j] == 0 or processed[i, j]:
                    continue
                
                # Get downstream cell
                if flow_dir[i, j] in dir_to_offset:
                    dr, dc = dir_to_offset[flow_dir[i, j]]
                    ni, nj = i + dr, j + dc
                    
                    if 0 <= ni < rows and 0 <= nj < cols:
                        # Check for infinite loops (cells flowing to each other)
                        if flow_acc[ni, nj] > 1e6:  # Threshold for detection
                            processed[i, j] = True
                            continue
                        
                        old_acc = flow_acc[ni, nj]
                        flow_acc[ni, nj] += flow_acc[i, j]
                        
                        if abs(flow_acc[ni, nj] - old_acc) > 0.1:
                            changed = True
        
        if not changed:
            print(f"  Flow accumulation converged after {iteration + 1} iterations")
            break
        
        if iteration == max_iterations - 1:
            print(f"  Warning: Flow accumulation did not fully converge after {max_iterations} iterations")
    
    # Cap extremely high values (likely from circular flow or errors)
    flow_acc = np.clip(flow_acc, 0, 1e6)
    
    return flow_acc.astype(np.float32)

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

def create_flow_start_points(flow_acc, transform, spacing=5, min_accumulation=1.0):
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

def sample_evenly(items, max_count):
    """
    Sample items evenly from the list to avoid bias toward beginning.
    Uses numpy to take evenly spaced indices across the entire list.
    """
    if len(items) <= max_count:
        return items
    
    # Generate evenly spaced indices
    indices = np.linspace(0, len(items) - 1, max_count, dtype=int)
    return [items[i] for i in indices]

def create_dem_visualization(flow_acc, shape, output_path):
    """
    Create a PNG visualization of the DEM using flow accumulation.
    Colors represent flow paths (blue for channels, tan for ridges).
    """
    rows, cols = shape
    
    # Normalize flow accumulation with log scale for better visualization
    flow_acc_safe = np.where(flow_acc > 0, flow_acc, 1)
    flow_acc_log = np.log10(flow_acc_safe)
    
    # Normalize to 0-1 range
    acc_min = np.min(flow_acc_log)
    acc_max = np.max(flow_acc_log)
    acc_norm = (flow_acc_log - acc_min) / (acc_max - acc_min)
    
    # Create RGB image
    img_array = np.zeros((rows, cols, 4), dtype=np.uint8)
    
    for i in range(rows):
        for j in range(cols):
            if flow_acc[i, j] > 0:
                # Color gradient based on flow accumulation
                # Very subtle - just barely visible to show terrain
                val = acc_norm[i, j]
                
                # Extremely subtle terrain - almost invisible
                # Just a hint of darker color in high flow channels
                r = int(245 - val * 20)   # 245 -> 225 (barely darker)
                g = int(245 - val * 20)   # 245 -> 225 (barely darker)
                b = int(248 - val * 20)   # 248 -> 228 (very slight blue)
                a = int(30 + val * 40)    # 30 -> 70 (very subtle opacity)
                
                img_array[i, j] = [r, g, b, a]
            else:
                # No flow data - almost invisible
                img_array[i, j] = [248, 248, 248, 15]
    
    # Convert to PIL Image
    # Note: Image array is in row-major order (rows, cols)
    # Row 0 = top of DEM (high northing), Row 624 = bottom of DEM (low northing)
    img = Image.fromarray(img_array, 'RGBA')
    
    # Rotate 90 degrees clockwise (270 counterclockwise) to match canvas orientation
    # This converts 375x625 to 625x375 (width x height)
    img = img.rotate(-90, expand=True)
    
    img.save(output_path)
    print(f"✓ DEM visualization saved to {output_path} (rotated 90° clockwise for canvas)")

def main():
    """Main processing function."""
    print("Loading DEM...")
    # Get the script's directory and construct path relative to it
    script_dir = Path(__file__).parent
    dem_path = script_dir / "media" / "clipped_dem.geotiff.tif"
    
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
    flow_dir_path = script_dir / "media" / "flow_direction.tif"
    with rasterio.open(flow_dir_path, 'w', **profile) as dst:
        dst.write(flow_dir, 1)
    
    # Save flow accumulation raster
    print("Saving flow accumulation raster...")
    profile.update(dtype=rasterio.float32, nodata=-9999)
    flow_acc_path = script_dir / "media" / "flow_accumulation.tif"
    with rasterio.open(flow_acc_path, 'w', **profile) as dst:
        dst.write(flow_acc, 1)
    
    # Extract flow vectors for visualization
    print("Extracting flow vectors...")
    # Lower threshold to get more coverage across the entire DEM
    flow_lines = extract_flow_vectors(flow_dir, flow_acc, transform, dem.shape, threshold=1)
    print(f"Extracted {len(flow_lines)} flow lines (before filtering)")
    
    # Create particle start points
    print("Creating particle start points...")
    # Use finer spacing and lower threshold to cover entire DEM
    start_points = create_flow_start_points(flow_acc, transform, spacing=2, min_accumulation=0.5)
    print(f"Created {len(start_points)} start points (before filtering)")
    
    # Reproject flow coordinates to WGS84 (EPSG:4326) so the web map can use them
    print("Reprojecting flow coordinates to EPSG:4326 (WGS84)...")
    try:
        src_crs = src.crs
    except NameError:
        src_crs = crs

    # If the source CRS does not expose an EPSG code (LOCAL_CS), fall back to EPSG:3006
    try:
        epsg_code = src_crs.to_epsg() if hasattr(src_crs, 'to_epsg') else None
    except Exception:
        epsg_code = None

    if epsg_code is None:
        print('Note: source CRS has no EPSG code, assuming EPSG:3006 (SWEREF99 TM)')
        src_crs = 'EPSG:3006'

    # Convert to normalized screen-space coordinates (0-1 range)
    # This makes the data resolution-independent - JS can scale to any canvas size
    print("Converting to normalized screen-space coordinates...")
    
    # Get the bounds in the original coordinate system
    minx, miny = bounds.left, bounds.bottom
    maxx, maxy = bounds.right, bounds.top
    width = maxx - minx
    height = maxy - miny
    
    # Convert flow_lines to normalized coordinates
    if flow_lines:
        for fl in flow_lines:
            # Normalize X: 0 (left) to 1 (right)
            fl['from_x_norm'] = float((fl['from'][0] - minx) / width)
            fl['to_x_norm'] = float((fl['to'][0] - minx) / width)
            
            # Normalize Y: 0 (top) to 1 (bottom) - FLIP for screen coordinates
            # DEM Y increases upward (northing), but screen Y increases downward
            # So we invert: high northing values -> low screen Y (top of screen)
            fl['from_y_norm'] = float(1.0 - (fl['from'][1] - miny) / height)
            fl['to_y_norm'] = float(1.0 - (fl['to'][1] - miny) / height)
            
            # Keep original coords for reference/debugging
            fl['from_orig'] = fl['from']
            fl['to_orig'] = fl['to']
            del fl['from']
            del fl['to']
    
    # Convert start_points to normalized coordinates
    if start_points:
        for p in start_points:
            x_norm = float((p['position'][0] - minx) / width)
            # Flip Y axis for screen coordinates (0 = top, 1 = bottom)
            y_norm = float(1.0 - (p['position'][1] - miny) / height)
            
            # Keep original for reference
            p['position_orig'] = p['position']
            p['position_norm'] = [x_norm, y_norm]
            del p['position']

    # Convert CRS info to JSON-serializable format
    crs_info = {
        'epsg': int(epsg_code) if epsg_code else 3006,
        'wkt': str(src_crs)
    }

    # Save flow data as JSON (with normalized screen-space coordinates)
    print("Saving flow data...")
    # Also provide WGS84 bounds for map reference
    bounds_wgs84 = None
    try:
        transformer = Transformer.from_crs(src_crs, 'EPSG:4326', always_xy=True)
        lon_min, lat_min = transformer.transform(bounds.left, bounds.bottom)
        lon_max, lat_max = transformer.transform(bounds.right, bounds.top)
        bounds_wgs84 = {
            'west': float(lon_min), 
            'south': float(lat_min), 
            'east': float(lon_max), 
            'north': float(lat_max)
        }
    except Exception as e:
        print(f'Warning: could not compute WGS84 bounds: {e}')
        bounds_wgs84 = None

    flow_data = {
        'coordinate_system': 'normalized',  # NEW: indicates normalized 0-1 coordinates
        'description': 'Flow data in normalized screen-space coordinates (0-1 range). Scale to canvas dimensions in JavaScript.',
        'bounds': {
            'west': bounds.left,
            'south': bounds.bottom,
            'east': bounds.right,
            'north': bounds.top
        },
        'bounds_wgs84': bounds_wgs84,
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
        'flow_lines': sample_evenly(flow_lines, 10000),  # Sample evenly across DEM
        'start_points': sample_evenly(start_points, 2000)  # Sample evenly across DEM
    }
    
    output_path = script_dir / "media" / "flow_data.json"
    with open(output_path, 'w') as f:
        json.dump(flow_data, f, indent=2)
    
    # Create DEM visualization as PNG
    print("Creating DEM visualization image...")
    create_dem_visualization(flow_acc, dem.shape, script_dir / "media" / "dem_visualization.png")
    
    print(f"\n✓ Flow data saved to {output_path}")
    print("\nSummary:")
    print(f"  - Flow direction raster: media/flow_direction.tif")
    print(f"  - Flow accumulation raster: media/flow_accumulation.tif")
    print(f"  - Flow visualization data: media/flow_data.json")
    print(f"  - DEM visualization: media/dem_visualization.png")
    print(f"  - Total flow lines: {len(flow_lines)}")
    print(f"  - Total start points: {len(start_points)}")

if __name__ == "__main__":
    main()
