#!/usr/bin/env python3
"""Convert trees.gpkg to trees.geojson with WGS84 coordinates"""

import sqlite3
import struct
import json
from pyproj import Transformer

# Create transformer from SWEREF99 12 00 (EPSG:3007) to WGS84 (EPSG:4326)
transformer = Transformer.from_crs('EPSG:3007', 'EPSG:4326', always_xy=True)

def parse_gpkg_point(blob):
    """Parse GeoPackage standard binary point geometry"""
    if blob is None:
        return None
    
    # GeoPackage header
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    
    # Calculate envelope size based on type
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    envelope_size = envelope_sizes.get(envelope_type, 0)
    
    # WKB starts after header (8 bytes) + envelope
    wkb_start = 8 + envelope_size
    
    # Parse WKB Point (little-endian)
    x = struct.unpack('<d', blob[wkb_start+5:wkb_start+13])[0]
    y = struct.unpack('<d', blob[wkb_start+13:wkb_start+21])[0]
    
    return x, y

def main():
    conn = sqlite3.connect('media/trees.gpkg')
    cursor = conn.cursor()

    cursor.execute('SELECT id, geom, originalName, dataSource, height FROM trees')
    rows = cursor.fetchall()

    features = []
    for row in rows:
        fid, geom, name, source, height = row
        coords = parse_gpkg_point(geom)
        if coords:
            # Transform to WGS84
            lng, lat = transformer.transform(coords[0], coords[1])
            features.append({
                'type': 'Feature',
                'properties': {
                    'id': fid,
                    'name': name,
                    'source': source,
                    'height': height
                },
                'geometry': {
                    'type': 'Point',
                    'coordinates': [lng, lat]
                }
            })

    geojson = {
        'type': 'FeatureCollection',
        'features': features
    }

    with open('media/trees.geojson', 'w') as f:
        json.dump(geojson, f)

    print(f'Converted {len(features)} trees to media/trees.geojson')
    print(f'Sample coordinates: {features[0]["geometry"]["coordinates"]}')
    conn.close()

if __name__ == '__main__':
    main()
