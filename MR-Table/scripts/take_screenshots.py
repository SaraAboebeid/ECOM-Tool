#!/usr/bin/env python3
"""
Screenshot automation script for the Interactive Map application.
Takes screenshots of various features for documentation.
"""

import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

# Configuration
BASE_URL = "http://localhost:8000"
SCREENSHOT_DIR = Path(__file__).parent.parent / "media" / "screenshots"
VIEWPORT = {"width": 1920, "height": 1080}

# Features to capture with their button IDs and descriptions
# Using much longer wait times to ensure everything loads
FEATURES = [
    {
        "id": "default",
        "name": "Main Map View",
        "description": "Default map view with dark basemap",
        "wait_time": 5000,  # Wait for map tiles to fully load
        "click": None,  # Just the default view
    },
    {
        "id": "cfd-simulation",
        "name": "CFD Wind Simulation",
        "description": "Lattice Boltzmann CFD wind flow simulation",
        "wait_time": 8000,  # CFD needs time to initialize and show particles
        "click": "cfd-simulation-btn",
    },
    {
        "id": "stormwater",
        "name": "Stormwater Flow",
        "description": "D8 flow direction stormwater drainage visualization",
        "wait_time": 8000,  # DEM loading + particle animation
        "click": "stormwater-btn",
    },
    {
        "id": "sun-study",
        "name": "Sun Study",
        "description": "3D shadow analysis using Three.js",
        "wait_time": 10000,  # Three.js + STL loading takes time
        "click": "sun-study-btn",
    },
    {
        "id": "slideshow",
        "name": "Slideshow",
        "description": "Animated slideshow of data layers",
        "wait_time": 6000,
        "click": "slideshow-btn",
    },
    {
        "id": "grid-animation",
        "name": "Grid Animation",
        "description": "Holographic grid overlay showing table tile boundaries",
        "wait_time": 4000,
        "click": "grid-animation-btn",
    },
    {
        "id": "isovist",
        "name": "Isovist Analysis",
        "description": "Interactive visibility/viewshed analysis",
        "wait_time": 5000,
        "click": "isovist-btn",
        "extra_action": "click_map",  # Need to click on map to place viewer
    },
    {
        "id": "bird-sounds",
        "name": "Bird Sounds",
        "description": "Spatial audio visualization of bird sounds",
        "wait_time": 5000,
        "click": "bird-sounds-btn",
    },
]


async def dismiss_overlay(page):
    """Click the start overlay to dismiss it and unlock audio context."""
    try:
        overlay = page.locator("#start-overlay")
        if await overlay.is_visible(timeout=2000):
            await overlay.click()
            await page.wait_for_timeout(1000)
            print("  ✓ Start overlay dismissed")
    except Exception as e:
        print(f"  ℹ️ No overlay to dismiss: {e}")


async def wait_for_map_tiles(page):
    """Wait for map tiles to load by checking for tile images."""
    print("  ⏳ Waiting for map tiles to load...")
    try:
        # Wait for MapLibre canvas to be present and have content
        await page.wait_for_selector("canvas.maplibregl-canvas", timeout=10000)
        # Additional wait for tiles to render
        await page.wait_for_timeout(3000)
        print("  ✓ Map canvas ready")
    except Exception as e:
        print(f"  ⚠️ Map wait issue: {e}")


async def reset_all_features(page):
    """Turn off all active features to get a clean state."""
    print("  🔄 Resetting all features...")
    for feature in FEATURES:
        if feature["click"]:
            try:
                btn = page.locator(f"#{feature['click']}")
                classes = await btn.get_attribute("class") or ""
                # Check for active states
                if "active" in classes or "toggled" in classes:
                    await btn.click(timeout=2000)
                    await page.wait_for_timeout(500)
            except Exception:
                pass
    await page.wait_for_timeout(1000)


async def take_feature_screenshot(page, feature):
    """Take a screenshot of a specific feature."""
    filename = f"{feature['id']}.png"
    filepath = SCREENSHOT_DIR / filename
    
    print(f"  📸 Capturing: {feature['name']}...")
    
    # Click the button to activate the feature
    if feature["click"]:
        btn = page.locator(f"#{feature['click']}")
        await btn.click(timeout=5000)
        print(f"      ✓ Clicked {feature['click']}")
    
    # Handle extra actions for specific features
    if feature.get("extra_action") == "click_map":
        # For isovist, click on the map to place the viewer
        await page.wait_for_timeout(1000)
        map_el = page.locator("#map")
        box = await map_el.bounding_box()
        if box:
            # Click near center of map
            await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            print("      ✓ Clicked on map to place viewer")
    
    # Wait for the feature to load/animate
    print(f"      ⏳ Waiting {feature['wait_time']}ms for feature...")
    await page.wait_for_timeout(feature["wait_time"])
    
    # Take screenshot
    await page.screenshot(path=str(filepath), full_page=False, timeout=60000)
    print(f"      ✓ Screenshot saved: {filename}")
    
    # Turn off the feature if it has a toggle
    if feature["click"]:
        # Most features toggle off when clicked again
        btn = page.locator(f"#{feature['click']}")
        await btn.click(timeout=5000)
        await page.wait_for_timeout(1000)
    
    return filepath


async def take_controller_screenshots(page):
    """Take screenshots of the controller interface."""
    print("\n📱 Capturing Controller Interface...")
    
    await page.goto(f"{BASE_URL}/controller.html")
    await page.wait_for_timeout(3000)  # Wait for page to fully load
    
    # Controller default view
    filepath = SCREENSHOT_DIR / "controller-main.png"
    await page.screenshot(path=str(filepath), full_page=False, timeout=60000)
    print(f"  📸 Controller main view saved")
    
    # Click through some control buttons to show different dashboards
    dashboards = [
        ("stormwater-btn", "controller-stormwater.png", "Stormwater Dashboard"),
        ("sun-study-btn", "controller-sun-study.png", "Sun Study Dashboard"),
        ("credits-btn", "controller-credits.png", "Credits Dashboard"),
    ]
    
    for btn_id, filename, name in dashboards:
        try:
            btn = page.locator(f"[data-target='{btn_id}']")
            if await btn.count() > 0:
                await btn.click(timeout=5000)
                await page.wait_for_timeout(1500)
                filepath = SCREENSHOT_DIR / filename
                await page.screenshot(path=str(filepath), full_page=False, timeout=60000)
                print(f"  📸 {name} saved")
        except Exception as e:
            print(f"  ⚠️ Could not capture {name}: {e}")


async def main():
    """Main function to run the screenshot automation."""
    print("🚀 Starting Screenshot Automation\n")
    
    # Create screenshot directory
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"📁 Screenshots will be saved to: {SCREENSHOT_DIR}\n")
    
    async with async_playwright() as p:
        # Launch browser - NOT headless so we can see what's happening
        # and ensure WebGL/canvas work properly
        browser = await p.chromium.launch(
            headless=True,
            args=[
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--use-gl=swiftshader',  # Software WebGL for headless
            ]
        )
        context = await browser.new_context(
            viewport=VIEWPORT,
            device_scale_factor=1,
        )
        
        print("🗺️ Capturing Main Application Features...")
        
        # Take screenshots of each feature - reload page each time for clean state
        for feature in FEATURES:
            page = await context.new_page()
            page.set_default_timeout(60000)
            
            try:
                # Navigate to main page
                print(f"\n  📸 Capturing: {feature['name']}...")
                print(f"      ⏳ Loading fresh page...")
                await page.goto(f"{BASE_URL}/index.html", wait_until="networkidle")
                await page.wait_for_timeout(3000)
                
                # Dismiss the start overlay
                await dismiss_overlay(page)
                
                # Wait for map tiles
                await wait_for_map_tiles(page)
                await page.wait_for_timeout(3000)  # Extra wait for tiles
                
                await take_feature_screenshot(page, feature)
            except Exception as e:
                print(f"      ⚠️ Error: {e}")
            finally:
                await page.close()
        
        # Take controller screenshots
        page = await context.new_page()
        page.set_default_timeout(60000)
        await take_controller_screenshots(page)
        await page.close()
        
        await browser.close()
    
    print("\n✅ Screenshot automation complete!")
    print(f"📁 Screenshots saved to: {SCREENSHOT_DIR}")
    
    # List all captured screenshots
    print("\n📷 Captured screenshots:")
    for f in sorted(SCREENSHOT_DIR.glob("*.png")):
        size_kb = f.stat().st_size / 1024
        print(f"   - {f.name} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    asyncio.run(main())
