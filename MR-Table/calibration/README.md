# Camera-Based Auto-Calibration

This feature automatically calibrates the map projection to align with the physical table using computer vision.

## Quick Start (Single-Tile Mode)

If your camera cannot see all 4 corners of the table, use the **single-tile calibration** mode:

1. **Position camera**: Point your webcam at the **top-left corner** of the table
2. **Launch main display**: Open the projection on your table
3. **Run calibration**: Click Auto-Calibrate in Launcher or Controller
4. A bright **20×20cm square** will be projected in the top-left
5. The system adjusts zoom/rotation until the tile matches expected size

## How Single-Tile Calibration Works

Instead of detecting 4 corner markers, this mode:
1. Projects a bright white 20×20cm reference tile at a known position
2. Camera detects the bright rectangular region
3. Compares detected size to expected size → calculates zoom
4. Compares detected angle to expected angle → calculates rotation
5. Iteratively adjusts until convergence

```
    ┌─────────────────────────────────────────────────┐
    │  ┌────────┐                                     │
    │  │  20cm  │ ← Calibration tile                  │
    │  │  ×     │   (bright white square)             │
    │  │  20cm  │                                     │
    │  └────────┘                                     │
    │         ↑                                       │ 60cm
    │     5cm from left, 5cm from top                 │
    │                                                 │
    │                   TABLE MODEL                   │
    │                                                 │
    └─────────────────────────────────────────────────┘
                        100cm
```

## Camera Setup for Single-Tile Mode

Position your camera to clearly see the **top-left quadrant** of the table:

```
        Camera view
    ┌──────────────────┐
    │  ┌─────────┐     │
    │  │ TILE    │     │
    │  │ (white) │     │
    │  └─────────┘     │
    │                  │
    │    Table edge    │
    └──────────────────┘
```

### Requirements:
- Camera should see at least 30×30cm area around the tile position
- Tile should be well-lit by projector (dominant light source)
- Avoid reflections or glare on the table surface
- USB webcam or laptop camera works fine

## Alternative: 4-Marker Mode (Legacy)

If your camera CAN see all 4 corners, you can use the original 4-marker mode:

### Marker Placement for 60cm × 100cm Table

```
    ┌──────────────────────────────────────────────────┐
    │   (5,3)                              (95,3)      │
    │     ┌─┐ #0 RED                  GREEN #1 ┌─┐     │
    │     └─┘                                  └─┘     │
    │                                                  │
    │                   TABLE MODEL                    │ 60cm
    │                   (top view)                     │
    │                                                  │
    │     ┌─┐ #3 YELLOW              BLUE #2 ┌─┐      │
    │     └─┘                                  └─┘     │
    │   (5,57)                             (95,57)     │
    └──────────────────────────────────────────────────┘
                        100cm
```

### Exact Positions (from table edges):

| Marker | Color  | From Left | From Top | Purpose |
|--------|--------|-----------|----------|---------|
| #0     | Red    | 5 cm      | 3 cm     | Top-Left reference |
| #1     | Green  | 95 cm     | 3 cm     | Top-Right reference |
| #2     | Blue   | 95 cm     | 57 cm    | Bottom-Right reference |
| #3     | Yellow | 5 cm      | 57 cm    | Bottom-Left reference |

## Using Auto-Calibration

### From Launcher (`launcher.html`)
1. Launch the Main Display first
2. Select your camera from the dropdown
3. Verify tile/table is visible in preview
4. Click **Auto-Calibrate**
5. Wait for convergence (5-15 seconds)

### From Controller (`controller.html`)
1. Navigate to Calibrate section (wrench icon)
2. Select camera from dropdown
3. Click **Start Auto-Calibrate**
4. Monitor progress in the preview

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Tile not detected | Ensure the projected square is visible to camera, not washed out |
| Slow convergence | Check camera focus and exposure |
| Wrong scale | Adjust tileSize parameter if using different tile size |
| Calibration doesn't apply | Verify Main Display window is open and connected |
| Camera too dark | Turn down ambient lighting, projector should dominate |

## Technical Details

- Detection: Brightness thresholding (pixels > 180)
- Reference tile: 20×20cm projected at top-left + 5cm offset
- Convergence threshold: 5 pixels error
- Damping factor: 0.5 (prevents overshooting)
- Max iterations: 15
- Sample averaging: 10 frames per iteration
- Marker format: ArUco DICT_4X4_50 (IDs 0-3)
