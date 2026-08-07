// Performance configuration for graph rendering
export interface GraphPerformanceConfig {
  enableParticles: boolean;
  enableComplexTooltips: boolean;
  enableNodeIcons: boolean;
  enableSmoothAnimations: boolean;
  maxParticles: number;
  maxVisibleLinks: number;
  animationThrottleMs: number;
  enableVirtualization: boolean;
}

export const PERFORMANCE_PRESETS = {
  HIGH_PERFORMANCE: {
    enableParticles: false,
    enableComplexTooltips: false,
    enableNodeIcons: true,
    enableSmoothAnimations: false,
    maxParticles: 0,
    maxVisibleLinks: 20,
    animationThrottleMs: 100,
    enableVirtualization: true,
  } as GraphPerformanceConfig,
  
  BALANCED: {
    enableParticles: true,
    enableComplexTooltips: true,
    enableNodeIcons: true,
    enableSmoothAnimations: true,
    maxParticles: 8,
    maxVisibleLinks: 50,
    animationThrottleMs: 50,
    enableVirtualization: false,
  } as GraphPerformanceConfig,
  
  HIGH_QUALITY: {
    enableParticles: true,
    enableComplexTooltips: true,
    enableNodeIcons: true,
    enableSmoothAnimations: true,
    maxParticles: 15,
    maxVisibleLinks: 100,
    animationThrottleMs: 16,
    enableVirtualization: false,
  } as GraphPerformanceConfig,
};

// Detect device performance capabilities
export const detectPerformanceLevel = (): keyof typeof PERFORMANCE_PRESETS => {
  // Check for mobile devices
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  
  // Check hardware concurrency (CPU cores)
  const cores = navigator.hardwareConcurrency || 2;
  
  // Check available memory (if supported)
  const memory = (navigator as any).deviceMemory || 4;
  
  // Simple performance scoring
  if (isMobile || cores < 4 || memory < 4) {
    return 'HIGH_PERFORMANCE';
  } else if (cores >= 8 && memory >= 8) {
    return 'HIGH_QUALITY';
  } else {
    return 'BALANCED';
  }
};

// Performance monitoring utilities
export class PerformanceMonitor {
  private frameCount = 0;
  private lastTime = 0;
  private fps = 60;
  
  updateFPS() {
    const now = performance.now();
    this.frameCount++;
    
    if (now - this.lastTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastTime = now;
    }
    
    return this.fps;
  }
  
  shouldReduceQuality(): boolean {
    return this.fps < 30;
  }
  
  getRecommendedConfig(): keyof typeof PERFORMANCE_PRESETS {
    if (this.fps < 20) return 'HIGH_PERFORMANCE';
    if (this.fps < 40) return 'BALANCED';
    return 'HIGH_QUALITY';
  }
}
