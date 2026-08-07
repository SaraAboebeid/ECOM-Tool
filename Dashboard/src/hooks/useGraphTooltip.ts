import { useRef, useEffect } from 'react';

interface TooltipOptions {
  className?: string;
  maxWidth?: string;
  zIndex?: string;
}

/**
 * Custom hook for managing graph tooltips
 * @param options Tooltip styling options
 * @returns Tooltip utilities
 */
export const useGraphTooltip = (options: TooltipOptions = {}) => {
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Create tooltip div only once
  useEffect(() => {
    if (!tooltipRef.current) {
      const div = document.createElement('div');
      div.className = options.className || 'tooltip';
      div.style.position = 'absolute';
      div.style.visibility = 'hidden';
      
      // Check if dark mode is active to set appropriate tooltip styles
      const isDarkMode = document.documentElement.classList.contains('dark');
      div.style.background = isDarkMode ? 'rgba(30, 41, 59, 0.9)' : 'rgba(0, 0, 0, 0.8)';
      div.style.color = 'white';
      div.style.padding = '8px';
      div.style.borderRadius = '4px';
      div.style.fontSize = '12px';
      div.style.pointerEvents = 'none'; // Ensures tooltip never captures pointer events
      div.style.zIndex = options.zIndex || '1000';
      div.style.userSelect = 'none'; // Prevent text selection
      div.style.maxWidth = options.maxWidth || '200px';
      div.style.wordWrap = 'break-word';
      div.style.boxShadow = isDarkMode ? '0 4px 6px -1px rgba(0, 0, 0, 0.5)' : '0 4px 6px -1px rgba(0, 0, 0, 0.3)';
      div.style.border = isDarkMode ? '1px solid rgba(75, 85, 99, 0.5)' : 'none';
      
      document.body.appendChild(div);
      tooltipRef.current = div;
    } else {
      // Always ensure pointer-events is none
      tooltipRef.current.style.pointerEvents = 'none';
    }
    
    // Add a MutationObserver to update tooltip styles when dark mode changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class' && tooltipRef.current && !document.documentElement.classList.contains('disable-transitions')) {
          const isDarkMode = document.documentElement.classList.contains('dark');
          
          // Use requestAnimationFrame to batch style updates
          requestAnimationFrame(() => {
            if (!tooltipRef.current) return;
            tooltipRef.current.style.background = isDarkMode ? 'rgba(30, 41, 59, 0.9)' : 'rgba(0, 0, 0, 0.8)';
            tooltipRef.current.style.boxShadow = isDarkMode ? '0 4px 6px -1px rgba(0, 0, 0, 0.5)' : '0 4px 6px -1px rgba(0, 0, 0, 0.3)';
            tooltipRef.current.style.border = isDarkMode ? '1px solid rgba(75, 85, 99, 0.5)' : 'none';
          });
        }
      });
    });
    
    observer.observe(document.documentElement, { attributes: true });
    
    return () => {
      if (tooltipRef.current) {
        tooltipRef.current.remove();
        tooltipRef.current = null;
      }
      observer.disconnect();
    };
  }, [options.className, options.maxWidth, options.zIndex]);

  // Helper to show tooltip
  const showTooltip = (html: string, event: MouseEvent) => {
    if (!tooltipRef.current) return;
    
    tooltipRef.current.innerHTML = html;
    tooltipRef.current.style.visibility = 'visible';
    // Position tooltip away from cursor to prevent interference
    tooltipRef.current.style.left = (event.pageX + 15) + 'px';
    tooltipRef.current.style.top = (event.pageY - 35) + 'px';
  };

  // Helper to hide tooltip with debounce
  const hideTooltip = (delay: number = 80) => {
    if (!tooltipRef.current) return;
    
    setTimeout(() => {
      if (tooltipRef.current) {
        tooltipRef.current.style.visibility = 'hidden';
      }
    }, delay);
  };

  // Helper to update tooltip position
  const updateTooltipPosition = (event: MouseEvent) => {
    if (!tooltipRef.current) return;
    
    tooltipRef.current.style.left = (event.pageX + 15) + 'px';
    tooltipRef.current.style.top = (event.pageY - 35) + 'px';
  };

  return {
    tooltipRef,
    showTooltip,
    hideTooltip,
    updateTooltipPosition
  };
};

export default useGraphTooltip;
