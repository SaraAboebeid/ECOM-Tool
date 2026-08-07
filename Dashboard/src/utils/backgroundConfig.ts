/**
 * Background image configuration
 * Adjust BACKGROUND_SCALE to change the size of the background image and node coordinates
 * Adjust COMPASS_ORIENTATION to rotate the image and node positions (in degrees, clockwise)
 */
export const BACKGROUND_SCALE = 2;
export const COMPASS_ORIENTATION = -90; // Rotation in degrees (counter-clockwise)

/**
 * Original background image dimensions
 */
export const ORIGINAL_IMAGE_WIDTH = 565.752;
export const ORIGINAL_IMAGE_HEIGHT = 1276.608;

/**
 * Calculated scaled dimensions
 */
export const getScaledImageDimensions = () => ({
  width: ORIGINAL_IMAGE_WIDTH * BACKGROUND_SCALE,
  height: ORIGINAL_IMAGE_HEIGHT * BACKGROUND_SCALE
});

/**
 * Rotate a point around the center of the image
 * @param x - Original x coordinate
 * @param y - Original y coordinate
 * @param rotation - Rotation angle in degrees (clockwise)
 * @param centerX - Center x coordinate for rotation
 * @param centerY - Center y coordinate for rotation
 * @returns Rotated coordinates
 */
export const rotatePoint = (
  x: number, 
  y: number, 
  rotation: number, 
  centerX: number, 
  centerY: number
): { x: number; y: number } => {
  if (rotation === 0) return { x, y };
  
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  
  // Translate to origin
  const translatedX = x - centerX;
  const translatedY = y - centerY;
  
  // Rotate
  const rotatedX = translatedX * cos - translatedY * sin;
  const rotatedY = translatedX * sin + translatedY * cos;
  
  // Translate back
  return {
    x: rotatedX + centerX,
    y: rotatedY + centerY
  };
};

/**
 * Get the center point of the scaled image for rotation calculations
 */
export const getImageCenter = () => {
  const dimensions = getScaledImageDimensions();
  return {
    x: dimensions.width / 2,
    y: dimensions.height / 2
  };
};

/**
 * Axis-aligned bounds the background actually occupies once COMPASS_ORIENTATION
 * is applied. Rotating the width x height rect about its own centre leaves the
 * centre put but swaps how far the content reaches along each axis, so fitting
 * to the raw rect leaves the map clipped and off-centre.
 */
export const getRotatedImageBounds = () => {
  const { width, height } = getScaledImageDimensions();
  const center = getImageCenter();
  const radians = (COMPASS_ORIENTATION * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));

  const rotatedWidth = width * cos + height * sin;
  const rotatedHeight = width * sin + height * cos;

  return {
    width: rotatedWidth,
    height: rotatedHeight,
    centerX: center.x,
    centerY: center.y
  };
};

/**
 * Scale/translate that centres the rotated background inside a viewport.
 * Shared by the initial view and the fit-to-view control so both agree.
 */
export const getFitToBackgroundTransform = (
  viewportWidth: number,
  viewportHeight: number,
  padding = 40,
  maxScale = 1.2
) => {
  const bounds = getRotatedImageBounds();
  const scale = Math.min(
    (viewportWidth - padding * 2) / bounds.width,
    (viewportHeight - padding * 2) / bounds.height,
    maxScale
  );

  return {
    scale,
    x: viewportWidth / 2 - bounds.centerX * scale,
    y: viewportHeight / 2 - bounds.centerY * scale
  };
};
