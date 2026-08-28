# Adding Media to Slideshow

## Current Media

The slideshow currently contains:
- `building-footprints.geojson` - Building footprint data for the study area

## How to Add More Media

### 1. Add Image Files

Place PNG or JPG images in this folder, then add to `slideshow-config.json`:

```json
{
  "media": "your-image.png",
  "type": "image",
  "duration": 5000,
  "transition": "fade",
  "metadata": {
    "title": "Your Title",
    "description": "Description of the image"
  }
}
```

### 2. Add Video Files

Place MP4 videos in this folder, then add to config:

```json
{
  "media": "your-video.mp4",
  "type": "video",
  "duration": 15000,
  "transition": "fade",
  "metadata": {
    "title": "Video Title",
    "description": "Video description"
  }
}
```

### 3. Add GIF Animations

Place GIF files in this folder, then add to config:

```json
{
  "media": "animation.gif",
  "type": "gif",
  "duration": 6000,
  "transition": "zoom",
  "metadata": {
    "title": "Animation Title"
  }
}
```

### 4. Add More GeoJSON Data

Place GeoJSON files in this folder with geographic data:

```json
{
  "media": "data-layer.geojson",
  "type": "geojson",
  "duration": 7000,
  "transition": "fade",
  "metadata": {
    "title": "Data Layer",
    "description": "Description of the data",
    "style": {
      "fillColor": "#3388ff",
      "fillOpacity": 0.4,
      "strokeColor": "#0066cc",
      "strokeWidth": 2
    }
  }
}
```

## Example: Complete Multi-Slide Configuration

```json
{
  "slides": [
    {
      "media": "building-footprints.geojson",
      "type": "geojson",
      "duration": 8000,
      "transition": "fade",
      "metadata": {
        "title": "Building Footprints",
        "description": "Building footprint data for the study area",
        "style": {
          "fillColor": "#ff6600",
          "fillOpacity": 0.5,
          "strokeColor": "#cc3300",
          "strokeWidth": 1
        }
      }
    },
    {
      "media": "site-photo.jpg",
      "type": "image",
      "duration": 5000,
      "transition": "slide-left",
      "metadata": {
        "title": "Site Overview",
        "description": "Aerial photograph of the area"
      }
    },
    {
      "media": "heat-map.png",
      "type": "image",
      "duration": 6000,
      "transition": "fade",
      "metadata": {
        "title": "Heat Analysis",
        "description": "Temperature distribution across site",
        "legend": {
          "items": [
            { "color": "#d73027", "label": "High (>30°C)" },
            { "color": "#fee08b", "label": "Medium (20-30°C)" },
            { "color": "#1a9850", "label": "Low (<20°C)" }
          ]
        }
      }
    },
    {
      "media": "wind-simulation.mp4",
      "type": "video",
      "duration": 20000,
      "transition": "fade",
      "metadata": {
        "title": "Wind Flow Simulation",
        "description": "CFD simulation of wind patterns"
      }
    }
  ],
  "settings": {
    "loop": true,
    "autoAdvance": true,
    "showMetadata": true,
    "metadataPosition": "bottom-right",
    "fitMode": "contain"
  }
}
```

## Controls

- **Start/Stop**: Click the slideshow button (play icon) in the left sidebar
- **Next Slide**: Press `→` or `Space`
- **Previous Slide**: Press `←`
- **Exit**: Press `Esc`

## Tips

1. **Image Size**: Use 1920x1080 or higher resolution for best quality
2. **Aspect Ratio**: Images matching the table aspect ratio (~1.67:1) will fill best
3. **Video Format**: Use H.264 encoded MP4 for best compatibility
4. **Duration**: Match video duration to actual video length; 4-6 seconds for images
5. **Transitions**: "fade" works well for most slides; "slide-left" for sequences
6. **GeoJSON**: Ensure coordinates are in WGS84 (lon/lat) and overlap visible area
