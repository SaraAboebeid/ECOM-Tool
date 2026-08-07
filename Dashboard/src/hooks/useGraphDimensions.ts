import { useState, useEffect } from 'react';

interface Dimensions {
  width: number;
  height: number;
}

/**
 * Custom hook for managing graph dimensions with responsive behavior
 * @param svgRef Reference to the SVG element
 * @param initialDimensions Initial dimensions
 * @returns Current dimensions
 */
export const useGraphDimensions = (
  svgRef: React.RefObject<SVGSVGElement | null>,
  initialDimensions: Dimensions = { width: 800, height: 600 }
) => {
  const [dimensions, setDimensions] = useState<Dimensions>(initialDimensions);

  useEffect(() => {
    const handleResize = () => {
      if (svgRef.current) {
        const { width, height } = svgRef.current.getBoundingClientRect();
        setDimensions(prev => {
          // Only update if dimensions actually changed to prevent unnecessary re-renders
          if (prev.width !== width || prev.height !== height) {
            return { width, height };
          }
          return prev;
        });
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [svgRef]);

  return dimensions;
};

export default useGraphDimensions;
