import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PerformanceMonitor } from '../utils/performanceConfig';

interface FpsCounterProps {
  className?: string;
  onPerformanceChange?: (recommendation: 'HIGH_PERFORMANCE' | 'BALANCED' | 'HIGH_QUALITY') => void;
}

export const FpsCounter: React.FC<FpsCounterProps> = ({ 
  className = '', 
  onPerformanceChange 
}) => {
  const [fps, setFps] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
  const performanceMonitorRef = useRef(new PerformanceMonitor());
  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(performance.now());
  const animationFrameRef = useRef<number | undefined>(undefined);
  const lastRecommendationRef = useRef<string>('');

  const checkPerformance = useCallback(() => {
    const monitor = performanceMonitorRef.current;
    const recommendation = monitor.getRecommendedConfig();
    
    if (recommendation !== lastRecommendationRef.current && onPerformanceChange) {
      lastRecommendationRef.current = recommendation;
      onPerformanceChange(recommendation);
    }
  }, [onPerformanceChange]);

  useEffect(() => {
    const updateFps = () => {
      const now = performance.now();
      frameCountRef.current++;

      // Update FPS every second
      if (now - lastTimeRef.current >= 1000) {
        const currentFps = Math.round((frameCountRef.current * 1000) / (now - lastTimeRef.current));
        setFps(currentFps);
        
        // Update performance monitor
        performanceMonitorRef.current.updateFPS();
        
        // Check if performance recommendation should change
        checkPerformance();
        
        frameCountRef.current = 0;
        lastTimeRef.current = now;
      }

      animationFrameRef.current = requestAnimationFrame(updateFps);
    };

    if (isVisible) {
      updateFps();
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isVisible, checkPerformance]);

  // Toggle visibility with keyboard shortcut (F3)
  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === 'F3') {
        event.preventDefault();
        setIsVisible(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  if (!isVisible) {
    return null;
  }

  const getFpsColor = (fps: number) => {
    if (fps >= 55) return 'text-green-400';
    if (fps >= 30) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div 
      className={`fixed top-2 left-2 z-50 bg-black bg-opacity-90 text-white px-2 py-1 rounded-md font-mono text-xs backdrop-blur-sm border border-blue-500 shadow-lg ${className}`}
      style={{ userSelect: 'none', pointerEvents: 'auto' }}
    >
      <div className="flex items-center space-x-1">
        <span className="text-gray-150">FPS:</span>
        <span className={`font-bold ${getFpsColor(fps)}`}>
          {fps}
        </span>
      </div>
      <div className="text-xs text-gray-200 opacity-75">
        F3
      </div>
    </div>
  );
};
