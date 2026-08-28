// Sun Study Module - Three.js shadow overlay on map
// Renders shadows from STL model as transparent overlay on the web map
// Uses Sweden location (Gothenburg area) for accurate sun positioning
// Supports dual model system (buildings + trees) with multi-source shadow discrimination

let THREE, STLLoader, GLTFLoader, EffectComposer, RenderPass, SSAOPass, SMAAPass, OutputPass, BufferGeometryUtils;

async function loadDependencies() {
  THREE = await import('three');
  const stlModule = await import('three/addons/loaders/STLLoader.js');
  STLLoader = stlModule.STLLoader;
  const gltfModule = await import('three/addons/loaders/GLTFLoader.js');
  GLTFLoader = gltfModule.GLTFLoader;
  
  BufferGeometryUtils = await import('three/addons/utils/BufferGeometryUtils.js');
  
  const composerModule = await import('three/addons/postprocessing/EffectComposer.js');
  EffectComposer = composerModule.EffectComposer;
  const renderPassModule = await import('three/addons/postprocessing/RenderPass.js');
  RenderPass = renderPassModule.RenderPass;
  const ssaoPassModule = await import('three/addons/postprocessing/SSAOPass.js');
  SSAOPass = ssaoPassModule.SSAOPass;
  const smaaPassModule = await import('three/addons/postprocessing/SMAAPass.js');
  SMAAPass = smaaPassModule.SMAAPass;
  const outputPassModule = await import('three/addons/postprocessing/OutputPass.js');
  OutputPass = outputPassModule.OutputPass;
  
  return true;
}

class SunStudy {
  constructor() {
    this.canvas = null;
    this.renderer = null;
    this.composer = null;
    this.ssaoPass = null;
    this.scene = null;
    this.camera = null;
    this.sunLight = null;
    this.mesh = null;
    this.isActive = false;
    this.animationId = null;
    
    // Dual model system
    this.meshBuildings = null;  // Model 1: terrain/buildings (mesh.stl)
    this.meshTrees = null;      // Model 2: trees (trees.stl)
    this.treesVisible = false;  // Toggle state for trees
    this.treesLoaded = false;   // Whether tree model has been loaded
    this.buildingsCenter = null; // Stored center for aligning trees
    
    // Performance: Dirty flags
    this.shadowMapsDirty = true;
    this.needsRender = true;        // WebGL scene needs re-render
    this.overlayDirty = true;       // 2D overlay needs redraw
    this.falseColorUniformsDirty = true; // False color uniforms need update
    this.lastSunPosition = { x: 0, y: 0, z: 0 };
    this.frameCount = 0;
    this.shadowUpdateInterval = 2;
    
    // Reusable objects to avoid per-frame allocations
    this._tempColor = null;          // Reused in renderShadowMaps (lazy init after THREE loads)
    this._cachedSunDir = null;       // Reused in updateFalseColorUniforms (lazy init after THREE loads)
    this._shadowCombinedMatchesBuildings = false; // When true, skip PASS 2 (no trees)
    
    // Cached sun path points (invalidated on date change)
    this._cachedSunPathDate = null;     // date string when cache was built
    this._cachedSunPathPoints = null;   // array of {x,y,hour,altitude,azimuth}
    
    // Cached compass rose (offscreen canvas, invalidated on resize)
    this._compassCanvas = null;
    this._compassSize = 0;              // tracks canvas dimensions for invalidation
    
    // Cached matrices (for future dual shadow system)
    this.cachedShadowMatrixBuildings = null;
    this.cachedShadowMatrixTrees = null;
    
    // Materials
    this.standardMaterial = null;
    this.standardMaterialTrees = null;
    this.falseColorMaterial = null;
    this.isFalseColorMode = false;
    
    // Sweden location (Gothenburg - matches map center)
    this.latitude = 57.68839377903814;
    this.longitude = 11.977770568930168;
    this.timezone = 1; // CET = UTC+1 (standard time; DST not modelled)
    
    // Map bearing for alignment
    this.mapBearing = -92.58546386659737;
    
    // Time settings
    // Default to June 21st (Summer Solstice)
    this.date = new Date();
    this.date.setMonth(5); // June (0-indexed)
    this.date.setDate(21);
    
    this.timeOfDay = 12;
    this.isAnimating = false;
    this.animationSpeed = 2;
    
    // Shadow settings
    this.shadowOpacity = 0.8;
    
    // Manual adjustment offsets
    this.offsetX = 0;      // X position offset
    this.offsetZ = 0;      // Z position offset (Y on screen in top-down)
    this.rotationOffset = 0; // Additional rotation in degrees
    this.scaleMultiplier = 0.89; // Scale multiplier
    
    this.controlPanel = null;
    this.dependenciesLoaded = false;
    
    this.initUI();
    
    // Listen for remote control messages
    this.channel = new BroadcastChannel('map_controller_channel');
    this.channel.onmessage = (event) => this.handleRemoteControl(event.data);
  }
  
  initUI() {
    // Create transparent canvas overlay for shadows only
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'sun-study-canvas';
    this.canvas.style.cssText = `
      position: fixed;
      left: 60px;
      right: 60px;
      top: 0;
      bottom: 0;
      width: calc(100% - 120px);
      height: 100%;
      z-index: 400;
      display: none;
      pointer-events: none;
      background: transparent;
    `;
    document.body.appendChild(this.canvas);
    
    // 2D overlay canvas for compass rose and sun path
    this.initOverlayCanvas();
    
    // Control panel moved to remote controller
    // this.createControlPanel();
    
    const sunBtn = document.getElementById('sun-study-btn');
    if (sunBtn) {
      sunBtn.addEventListener('click', () => this.toggle());
    }
    
    window.addEventListener('resize', () => this.onResize());
  }

  handleRemoteControl(data) {
    if (!this.isActive && data.type !== 'control_action') return;

    if (data.type === 'sun_control') {
        switch (data.action) {
            case 'set_date':
                // Parse date string as local time (not UTC) to avoid timezone issues
                // Input format: "YYYY-MM-DD"
                const parts = data.value.split('-');
                if (parts.length === 3) {
                    this.date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                } else {
                    this.date = new Date(data.value);
                }
                this._cachedSunPathDate = null; // Invalidate sun path cache
                this.updateSunPosition();
                this.shadowMapsDirty = true;
                this.needsRender = true;
                this.overlayDirty = true;
                break;
            case 'set_time':
                this.timeOfDay = parseFloat(data.value);
                this.updateSunPosition();
                this.shadowMapsDirty = true;
                this.needsRender = true;
                this.overlayDirty = true;
                break;
            case 'set_opacity':
                this.shadowOpacity = parseFloat(data.value);
                if (this.shadowMaterial) this.shadowMaterial.opacity = this.shadowOpacity;
                this.needsRender = true;
                break;
            case 'toggle_animation':
                this.toggleAnimation();
                break;
            case 'set_speed':
                this.animationSpeed = parseFloat(data.value);
                break;
            case 'toggle_false_color':
                this.toggleFalseColor();
                break;
            case 'toggle_trees':
                this.toggleTrees();
                break;
            case 'get_memory':
                this.getMemoryReport();
                break;
        }
    }
  }
  
  async initThreeJS() {
    if (this.dependenciesLoaded) return;
    
    console.log('Loading Three.js for sun study...');
    await loadDependencies();
    this.dependenciesLoaded = true;
    
    this.setupRenderer();
    this.setupScene();
    this.setupCamera();
    this.setupLights();
    this.setupDualShadowSystem();
    this.setupPostProcessing();
    this.loadSTLModel();
  }
  
  // Control panel removed - logic moved to remote controller
  
  bindControlEvents() {
    // No local controls to bind
  }
  
  toggleAnimation() {
    this.isAnimating = !this.isAnimating;
  }

  toggleFalseColor() {
    this.toggleFalseColorMode();
  }
  
  toggleTrees() {
    if (!this.treesLoaded) {
      // Load trees for the first time
      this.loadTreesSTL();
      return;
    }
    
    this.treesVisible = !this.treesVisible;
    
    if (this.meshTrees) {
      this.meshTrees.visible = this.treesVisible && !this.isFalseColorMode;
      this.meshTrees.castShadow = this.treesVisible;
    }
    
    // Mark all as needing update
    this.shadowMapsDirty = true;
    this.needsRender = true;
    this.overlayDirty = true;
    this.falseColorUniformsDirty = true;
    if (this.channel) {
      this.channel.postMessage({
        type: 'trees_state',
        visible: this.treesVisible,
        loaded: this.treesLoaded
      });
    }
    
    console.log('Trees visibility:', this.treesVisible);
  }
  
  updateTimeDisplay() {
    if (this.channel) {
        this.channel.postMessage({
            type: 'sun_time_update',
            time: this.timeOfDay
        });
    }
  }
  
  /*
  createControlPanel() {
    // ... removed ...
  }
  */
  
  setupDualShadowSystem() {
    // Two-pass shadow system for multi-source shadow discrimination
    // We render the scene twice to separate render targets:
    // 1) Buildings-only shadows → shadowTargetBuildings
    // 2) Combined shadows (buildings + trees) → shadowTargetCombined
    // The false color shader then samples both to determine shadow source
    
    const width = window.innerWidth - 120;
    const height = window.innerHeight;
    // Account for pixel ratio to match actual framebuffer size
    const pixelRatio = this.renderer ? this.renderer.getPixelRatio() : window.devicePixelRatio || 1;
    // OPTIMIZATION: Divide by 2. This cuts GPU load by 4x with almost no visual loss for blurred shadows.
    const targetWidth = Math.floor((width * pixelRatio) / 2);
    const targetHeight = Math.floor((height * pixelRatio) / 2);
    
    // PERF: Use RedFormat (single channel) instead of RGBAFormat.
    // Shadow maps only store a grayscale value, so we only need 1 channel.
    // This cuts memory bandwidth by 4x for shadow texture reads.
    this.shadowTargetBuildings = new THREE.WebGLRenderTarget(targetWidth, targetHeight, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType
    });
    
    this.shadowTargetCombined = new THREE.WebGLRenderTarget(targetWidth, targetHeight, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType
    });
    
    // PERF: Use MeshLambertMaterial instead of MeshStandardMaterial for shadow capture.
    // We throw away all lighting output and only keep the shadow mask,
    // so there's no point computing PBR (GGX BRDF, roughness, metalness).
    // Lambert is the cheapest material that still participates in the shadow system.
    this.shadowCaptureMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide
    });
    
    this.shadowCaptureMaterial.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <shadowmap_pars_fragment>',
        `
        #include <shadowmap_pars_fragment>
        #include <shadowmask_pars_fragment>
        `
      );
      
      // Output shadow mask as single-channel red value
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        float shadowVal = 1.0;
        #ifdef USE_SHADOWMAP
          shadowVal = getShadowMask();
        #endif
        gl_FragColor = vec4(shadowVal, 0.0, 0.0, 1.0);
        `
      );
    };
  }
  
  createFalseColorMaterial() {
    this.falseColorMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    
    this.falseColorMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.sunDirection = { value: new THREE.Vector3(0, 1, 0) };
      shader.uniforms.treesEnabled = { value: false };
      shader.uniforms.tShadowBuildings = { value: null };
      shader.uniforms.tShadowCombined = { value: null };
      shader.uniforms.resolution = { value: new THREE.Vector2(window.innerWidth, window.innerHeight) };
      
      this.falseColorMaterial.userData.shader = shader;
      
      // Inject Fast Noise & Sampling
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `
        #include <common>
        uniform vec3 sunDirection;
        uniform bool treesEnabled;
        uniform sampler2D tShadowBuildings;
        uniform sampler2D tShadowCombined;
        uniform vec2 resolution;

        // CLEVER TRICK 1: Poisson Disk Sampling (Fast & Soft)
        // Only 4 samples, rotated by random noise, look as good as 9 or 16 fixed samples
        const vec2 poissonDisk[4] = vec2[](
            vec2( -0.94201624, -0.39906216 ),
            vec2( 0.94558609, -0.76890725 ),
            vec2( -0.094184101, -0.92938870 ),
            vec2( 0.34495938, 0.29387760 )
        );

        // PERF: Shadow targets use RedFormat (single channel), so sample .r
        float getSoftShadowFast(sampler2D shadowMap, vec2 uv, float radius) {
            vec2 texelSize = vec2(1.0) / resolution;
            
            // Random rotation based on screen coordinate
            float noise = fract(sin(dot(uv.xy, vec2(12.9898,78.233))) * 43758.5453);
            float s = sin(noise * 6.28);
            float c = cos(noise * 6.28);
            mat2 rot = mat2(c, -s, s, c);
            
            // PERF: Unrolled loop — avoids loop overhead on low-end GPUs
            vec2 scaledTexel = texelSize * radius;
            float shadow = texture2D(shadowMap, uv + rot * poissonDisk[0] * scaledTexel).r;
            shadow += texture2D(shadowMap, uv + rot * poissonDisk[1] * scaledTexel).r;
            shadow += texture2D(shadowMap, uv + rot * poissonDisk[2] * scaledTexel).r;
            shadow += texture2D(shadowMap, uv + rot * poissonDisk[3] * scaledTexel).r;
            return shadow * 0.25;
        }
        `
      );
      
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        
        // --- Geometry & Lighting ---
        vec3 N = normalize(vNormal);
        if (!gl_FrontFacing) N = -N;
        vec3 L = normalize(sunDirection);
        float NdotL = max(0.0, dot(N, L));
        float lightIntensity = 0.4 + (NdotL * 0.6); // Ambient + Diffuse

        vec2 screenUV = gl_FragCoord.xy / resolution;
        
        // FAST Sampling
        float shadowB = getSoftShadowFast(tShadowBuildings, screenUV, 1.5);
        float shadowC = getSoftShadowFast(tShadowCombined, screenUV, 1.5);
        
        // --- Analysis Logic ---
        bool isLit = shadowC > 0.95;
        bool isBuildingShadow = shadowB < 0.8;
        float treeDiff = shadowB - shadowC;
        bool isTreeShadow = treeDiff > 0.05;

        // --- CLEVER TRICK 2: Hatch Pattern ---
        // Creates diagonal lines in screen space
        // gl_FragCoord.x + gl_FragCoord.y creates diagonal stripes
        float hatch = sin((gl_FragCoord.x + gl_FragCoord.y) * 0.5); 
        bool isHatch = hatch > 0.0;
        
        vec3 finalColor = vec3(1.0);
        
        if (isLit) {
            // Sunlit: Warm Paper-like tone
            finalColor = mix(vec3(1.0, 0.95, 0.8), vec3(1.0), NdotL);
        } 
        else if (isTreeShadow && treesEnabled) {
            if (isBuildingShadow) {
               // Overlap: Purple with Hatching
               // The hatching makes it look "technical" showing it's a mix
               vec3 basePurple = vec3(0.6, 0.2, 0.7);
               finalColor = isHatch ? basePurple : basePurple * 0.8;
            } else {
               // Tree Only: Solid Green
               finalColor = vec3(0.3, 0.8, 0.4); 
            }
        } 
        else if (isBuildingShadow) {
            // Building Only: Solid Cool Blue
            finalColor = vec3(0.4, 0.6, 0.9);
        }
        
        // --- CLEVER TRICK 3: Edge Outline ---
        // If the normal faces away from the camera significantly, darken it
        // Simple "rim darkening" to separate geometry
        vec3 viewDir = normalize(vViewPosition);
        float rim = 1.0 - max(0.0, dot(viewDir, N));
        rim = smoothstep(0.6, 1.0, rim);
        finalColor *= (1.0 - rim * 0.3);

        gl_FragColor = vec4(finalColor * lightIntensity, 1.0);
        `
      );
    };
  }
  
  toggleFalseColorMode() {
    if (!this.mesh) return;
    
    this.isFalseColorMode = !this.isFalseColorMode;
    this.shadowMapsDirty = true;
    this.needsRender = true;
    this.falseColorUniformsDirty = true;
    
    if (this.isFalseColorMode) {
      if (!this.falseColorMaterial) {
        this.createFalseColorMaterial();
      }
      this.mesh.material = this.falseColorMaterial;
      
      // Also apply false color to trees so they show consistent visualization
      if (this.meshTrees) {
        this.meshTrees.material = this.falseColorMaterial;
      }
    } else {
      this.mesh.material = this.standardMaterial;
      
      // Restore trees material
      if (this.meshTrees && this.standardMaterialTrees) {
        this.meshTrees.material = this.standardMaterialTrees;
      }
    }
  }
  
  updateFalseColorUniforms() {
    if (!this.falseColorMaterial || !this.sunLight) return;
    // PERF: Only update uniforms when something actually changed
    if (!this.falseColorUniformsDirty) return;
    this.falseColorUniformsDirty = false;
    
    const shader = this.falseColorMaterial.userData.shader;
    if (!shader || !shader.uniforms) return;
    
    // PERF: Reuse a single Vector3 instead of clone()+normalize() every frame
    // (avoids GC pressure from creating a new Vector3 each call)
    if (!this._cachedSunDir) this._cachedSunDir = new THREE.Vector3();
    this._cachedSunDir.copy(this.sunLight.position).normalize();
    if (this._cachedSunDir.lengthSq() === 0) {
      this._cachedSunDir.set(0, 1, 0);
    }
    
    if (shader.uniforms.sunDirection) {
      shader.uniforms.sunDirection.value.copy(this._cachedSunDir);
    }
    if (shader.uniforms.treesEnabled) {
      shader.uniforms.treesEnabled.value = this.treesVisible && this.treesLoaded;
    }
    if (shader.uniforms.tShadowBuildings && this.shadowTargetBuildings) {
      shader.uniforms.tShadowBuildings.value = this.shadowTargetBuildings.texture;
    }
    if (shader.uniforms.tShadowCombined && this.shadowTargetCombined) {
      // PERF: When no trees were active, we skipped the combined render pass.
      // Point the combined sampler at the buildings texture instead.
      shader.uniforms.tShadowCombined.value = this._shadowCombinedMatchesBuildings
        ? this.shadowTargetBuildings.texture
        : this.shadowTargetCombined.texture;
    }
    if (shader.uniforms.resolution) {
      const pixelRatio = this.renderer ? this.renderer.getPixelRatio() : 1;
      shader.uniforms.resolution.value.set(
        (window.innerWidth - 120) * pixelRatio,
        window.innerHeight * pixelRatio
      );
    }
  }
  
  renderShadowMaps() {
    // Two-pass shadow rendering for multi-source shadow discrimination
    // This method is called before the main render in false color mode
    
    // PERF: Skip entirely if shadow maps haven't been invalidated
    if (!this.shadowMapsDirty) return;
    
    if (!this.meshBuildings || !this.sunLight || !this.renderer) return;
    if (!this.shadowTargetBuildings || !this.shadowTargetCombined) return;
    if (!this.shadowCaptureMaterial) return;
    
    this.shadowMapsDirty = false; // Clear flag before rendering
    
    const treesActive = this.treesVisible && this.treesLoaded && this.meshTrees;
    
    // Store original state
    const originalBuildingsMaterial = this.meshBuildings.material;
    const originalTreesMaterial = treesActive ? this.meshTrees.material : null;
    // PERF: Reuse a single Color object instead of allocating new THREE.Color() every call
    if (!this._tempColor) this._tempColor = new THREE.Color();
    const originalClearColor = this.renderer.getClearColor(this._tempColor);
    const originalClearAlpha = this.renderer.getClearAlpha();
    const originalShadowType = this.renderer.shadowMap.type;
    const originalBias = this.sunLight.shadow.bias;
    const originalNormalBias = this.sunLight.shadow.normalBias;
    
    // Use PCF shadows for shadow capture passes (cleaner than Basic, sharper than VSM)
    const needsShadowTypeSwitch = (originalShadowType !== THREE.PCFShadowMap);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    
    // Adjust bias to prevent shadow acne artifacts
    this.sunLight.shadow.bias = -0.001;
    this.sunLight.shadow.normalBias = 0.02;
    
    // Set clear color to white (1.0 = no shadow) so areas without geometry 
    // are treated as fully lit, not in shadow
    this.renderer.setClearColor(0xffffff, 1.0);
    
    // Use shadow capture material for both passes
    this.meshBuildings.material = this.shadowCaptureMaterial;
    if (treesActive) {
      this.meshTrees.material = this.shadowCaptureMaterial;
    }
    
    // PERF: Only dispose shadow map when shadow type actually changes.
    // Previously this was done 3x per frame causing massive GPU alloc/dealloc thrashing.
    if (needsShadowTypeSwitch && this.sunLight.shadow.map) {
      this.sunLight.shadow.map.dispose();
      this.sunLight.shadow.map = null;
    }
    
    // PERF: Hide ground plane during shadow capture — it only receives shadows
    // but doesn't cast any. Removing it from the render saves vertex processing
    // and fragment shading for a 5000x5000 quad in each pass.
    const groundWasVisible = this.groundPlane ? this.groundPlane.visible : false;
    if (this.groundPlane) this.groundPlane.visible = false;
    
    // ========== PASS 1: Buildings only ==========
    this.meshBuildings.castShadow = true;
    if (treesActive) {
      this.meshTrees.castShadow = false;  // Disable tree shadows for this pass
      this.meshTrees.visible = false;      // Hide trees entirely
    }
    
    this.sunLight.shadow.needsUpdate = true;
    
    // Render to buildings shadow target
    this.renderer.setRenderTarget(this.shadowTargetBuildings);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    
    // ========== PASS 2: Combined (buildings + trees) ==========
    if (treesActive) {
      this.meshTrees.castShadow = true;   // Enable tree shadows
      this.meshTrees.visible = true;      // Show trees
      
      // Force shadow map update for combined pass (no dispose needed - same shadow type)
      this.sunLight.shadow.needsUpdate = true;
      
      // Render to combined shadow target
      this.renderer.setRenderTarget(this.shadowTargetCombined);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this._shadowCombinedMatchesBuildings = false;
    } else {
      // PERF: When no trees, combined = buildings. Skip the redundant second
      // render pass entirely. We set a flag so updateFalseColorUniforms
      // points both shader samplers at the buildings texture.
      this._shadowCombinedMatchesBuildings = true;
    }
    
    // Reset render target and restore original state
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(originalClearColor, originalClearAlpha);
    this.renderer.shadowMap.type = originalShadowType;
    this.sunLight.shadow.bias = originalBias;
    this.sunLight.shadow.normalBias = originalNormalBias;
    
    // PERF: Only dispose if we need to switch back to a different shadow type
    if (needsShadowTypeSwitch && this.sunLight.shadow.map) {
      this.sunLight.shadow.map.dispose();
      this.sunLight.shadow.map = null;
    }
    
    // Restore ground plane visibility
    if (this.groundPlane) this.groundPlane.visible = groundWasVisible;
    
    // Restore original materials
    this.meshBuildings.material = originalBuildingsMaterial;
    if (treesActive) {
      this.meshTrees.material = originalTreesMaterial;
    }
    
    // Ensure both meshes are visible and casting shadows for final render
    this.meshBuildings.castShadow = true;
    if (treesActive) {
      this.meshTrees.castShadow = true;
      this.meshTrees.visible = true;
    }
  }
  
  // ==================== 2D OVERLAY SYSTEM ====================
  // Compass rose + sun path arc drawn on a separate 2D canvas
  // sitting on top of the WebGL canvas
  
  initOverlayCanvas() {
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.id = 'sun-study-overlay';
    this.overlayCanvas.style.cssText = `
      position: fixed;
      left: 60px;
      right: 60px;
      top: 0;
      bottom: 0;
      width: calc(100% - 120px);
      height: 100%;
      z-index: 401;
      display: none;
      pointer-events: none;
    `;
    document.body.appendChild(this.overlayCanvas);
    this.overlayCtx = this.overlayCanvas.getContext('2d');
  }
  
  resizeOverlay() {
    if (!this.overlayCanvas) return;
    const w = window.innerWidth - 120;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    this.overlayCanvas.width = w * dpr;
    this.overlayCanvas.height = h * dpr;
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  
  drawOverlays() {
    if (!this.overlayCtx || !this.overlayCanvas) return;
    if (!this.overlayDirty) return; // Skip if nothing changed
    this.overlayDirty = false;
    
    const w = this.overlayCanvas.width / (window.devicePixelRatio || 1);
    const h = this.overlayCanvas.height / (window.devicePixelRatio || 1);
    this.overlayCtx.clearRect(0, 0, w, h);
    this.blitCompassRose(this.overlayCtx, w, h);
    this.drawSunPath(this.overlayCtx, w, h);
  }
  
  // Renders compass rose to an offscreen canvas once, then blits it each frame.
  // Only re-renders when canvas dimensions change (resize).
  blitCompassRose(ctx, w, h) {
    const size = 45;
    const canvasKey = `${w}|${h}`;
    
    if (!this._compassCanvas || this._compassSize !== canvasKey) {
      // Create/recreate offscreen canvas for compass
      const pad = 4; // padding around compass
      const dim = (size + 25 + pad) * 2;
      this._compassCanvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      this._compassCanvas.width = dim * dpr;
      this._compassCanvas.height = dim * dpr;
      const offCtx = this._compassCanvas.getContext('2d');
      offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Draw compass centered in offscreen canvas
      // We translate so drawCompassRose draws at the center of this small canvas
      const offW = dim;
      const offH = dim;
      this.drawCompassRose(offCtx, offW, offH, size + 25 + pad, size + 25 + pad);
      this._compassSize = canvasKey;
    }
    
    // Blit cached compass to the correct position
    const cx = w - size - 25;
    const cy = h - size - 25;
    const dim = this._compassCanvas.width / (window.devicePixelRatio || 1);
    ctx.drawImage(this._compassCanvas, cx - dim / 2, cy - dim / 2, dim, dim);
  }
  
  drawCompassRose(ctx, w, h, overrideCx, overrideCy) {
    const size = 45;
    const cx = overrideCx !== undefined ? overrideCx : w - size - 25;
    const cy = overrideCy !== undefined ? overrideCy : h - size - 25;
    
    const bearingRad = this.mapBearing * Math.PI / 180;
    // North in screen coords: screen-up is -PI/2, rotated by -bearing
    const northAngle = -Math.PI / 2 - bearingRad;
    
    ctx.save();
    ctx.translate(cx, cy);
    
    // Background circle
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    const directions = [
      { label: 'N', angle: 0, color: '#ff5555', bold: true },
      { label: 'E', angle: Math.PI / 2, color: 'rgba(255,255,255,0.85)', bold: false },
      { label: 'S', angle: Math.PI, color: 'rgba(255,255,255,0.85)', bold: false },
      { label: 'W', angle: -Math.PI / 2, color: 'rgba(255,255,255,0.85)', bold: false }
    ];
    
    for (const dir of directions) {
      const angle = northAngle + dir.angle;
      const lineLen = size * 0.6;
      const labelDist = size * 0.82;
      
      // Tick line
      ctx.beginPath();
      ctx.moveTo(lineLen * 0.2 * Math.cos(angle), lineLen * 0.2 * Math.sin(angle));
      ctx.lineTo(lineLen * Math.cos(angle), lineLen * Math.sin(angle));
      ctx.strokeStyle = dir.color;
      ctx.lineWidth = dir.bold ? 2.5 : 1.5;
      ctx.stroke();
      
      // Arrow for North
      if (dir.bold) {
        const tipX = lineLen * Math.cos(angle);
        const tipY = lineLen * Math.sin(angle);
        const arrowSize = 6;
        const perpAngle = angle + Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(tipX + arrowSize * 0.8 * Math.cos(angle), tipY + arrowSize * 0.8 * Math.sin(angle));
        ctx.lineTo(tipX - arrowSize * 0.5 * Math.cos(angle) + arrowSize * 0.4 * Math.cos(perpAngle),
                   tipY - arrowSize * 0.5 * Math.sin(angle) + arrowSize * 0.4 * Math.sin(perpAngle));
        ctx.lineTo(tipX - arrowSize * 0.5 * Math.cos(angle) - arrowSize * 0.4 * Math.cos(perpAngle),
                   tipY - arrowSize * 0.5 * Math.sin(angle) - arrowSize * 0.4 * Math.sin(perpAngle));
        ctx.closePath();
        ctx.fillStyle = dir.color;
        ctx.fill();
      }
      
      // Label
      ctx.font = dir.bold ? 'bold 14px sans-serif' : '11px sans-serif';
      ctx.fillStyle = dir.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dir.label, labelDist * Math.cos(angle), labelDist * Math.sin(angle));
    }
    
    // Center dot
    ctx.beginPath();
    ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();
    
    ctx.restore();
  }
  
  drawSunPath(ctx, w, h) {
    const cx = w / 2;
    const cy = h / 2;
    const maxRadius = Math.min(w, h) * 0.43;
    
    const bearingRad = this.mapBearing * Math.PI / 180;
    const northAngle = -Math.PI / 2 - bearingRad;
    
    // Helper: Convert altitude to radius using stereographic projection
    // altitude 0° (horizon) → maxRadius, altitude 90° (zenith) → 0
    const altitudeToRadius = (alt) => maxRadius * (90 - alt) / 90;
    
    // --- Altitude reference rings (faint concentric circles) ---
    for (const altDeg of [15, 30, 45, 60, 75]) {
      const r = altitudeToRadius(altDeg);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      // Small label on the right side
      if (altDeg % 30 === 0) {
        ctx.font = '8px sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${altDeg}°`, cx + r + 3, cy);
      }
    }
    
    // ---- PERF: Cache sun path points by date ----
    // calculateSunPosition is called 97 times (24h / 0.25h steps).
    // The path only depends on the date + latitude, NOT the current time,
    // so we cache it and only recalculate when the date changes.
    const dateKey = `${this.date.getFullYear()}-${this.date.getMonth()}-${this.date.getDate()}`;
    let rawPathData = this._cachedSunPathPoints;
    if (this._cachedSunPathDate !== dateKey) {
      rawPathData = [];
      for (let hour = 0; hour <= 24; hour += 0.25) {
        const { altitude, azimuth } = this.calculateSunPosition(this.date, hour, this.latitude);
        if (altitude > 0) {
          rawPathData.push({ hour, altitude, azimuth });
        }
      }
      this._cachedSunPathPoints = rawPathData;
      this._cachedSunPathDate = dateKey;
    }
    
    // Project cached astronomical data to screen coordinates
    const pathPoints = rawPathData.map(pt => {
      const r = altitudeToRadius(pt.altitude);
      const azRad = pt.azimuth * Math.PI / 180;
      const screenAngle = northAngle + azRad;
      return {
        x: cx + r * Math.cos(screenAngle),
        y: cy + r * Math.sin(screenAngle),
        hour: pt.hour, altitude: pt.altitude, azimuth: pt.azimuth
      };
    });
    
    if (pathPoints.length < 2) return;
    
    // --- Sun path arc (dashed golden line) ---
    ctx.beginPath();
    ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
    for (let i = 1; i < pathPoints.length; i++) {
      ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
    }
    ctx.strokeStyle = 'rgba(255, 200, 50, 0.45)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // --- Hour markers every 2 hours ---
    for (const pt of pathPoints) {
      if (pt.hour % 2 === 0 && pt.hour >= 4 && pt.hour <= 22) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 200, 50, 0.65)';
        ctx.fill();
        
        // Label offset outward from center
        const labelAngle = Math.atan2(pt.y - cy, pt.x - cx);
        const labelDist = 16;
        const lx = pt.x + labelDist * Math.cos(labelAngle);
        const ly = pt.y + labelDist * Math.sin(labelAngle);
        ctx.font = '10px sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.floor(pt.hour)}:00`, lx, ly);
      }
    }
    
    // --- Sunrise / sunset labels ---
    const sunrise = pathPoints[0];
    const sunset = pathPoints[pathPoints.length - 1];
    const fmtTime = (h) => {
      const hr = Math.floor(h);
      const mn = Math.round((h - hr) * 60);
      return `${hr}:${mn.toString().padStart(2, '0')}`;
    };
    
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(255, 150, 50, 0.85)';
    ctx.textAlign = 'center';
    const srAngle = Math.atan2(sunrise.y - cy, sunrise.x - cx);
    ctx.fillText(`\u2197 ${fmtTime(sunrise.hour)}`,
      sunrise.x + 22 * Math.cos(srAngle), sunrise.y + 22 * Math.sin(srAngle));
    const ssAngle = Math.atan2(sunset.y - cy, sunset.x - cx);
    ctx.fillText(`\u2198 ${fmtTime(sunset.hour)}`,
      sunset.x + 22 * Math.cos(ssAngle), sunset.y + 22 * Math.sin(ssAngle));
    
    // --- Current sun position ---
    const { altitude, azimuth } = this.calculateSunPosition(this.date, this.timeOfDay, this.latitude);
    if (altitude <= 0) return;
    
    const sunR = altitudeToRadius(altitude);
    const azRad = azimuth * Math.PI / 180;
    const screenAngle = northAngle + azRad;
    const sx = cx + sunR * Math.cos(screenAngle);
    const sy = cy + sunR * Math.sin(screenAngle);
    
    // Direction line from center to sun
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(sx, sy);
    ctx.strokeStyle = 'rgba(255, 200, 50, 0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Sun glow
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 22);
    glow.addColorStop(0, 'rgba(255, 200, 50, 0.35)');
    glow.addColorStop(1, 'rgba(255, 200, 50, 0)');
    ctx.beginPath();
    ctx.arc(sx, sy, 22, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
    
    // Sun disc
    ctx.beginPath();
    ctx.arc(sx, sy, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffcc33';
    ctx.fill();
    ctx.strokeStyle = '#ff9900';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Sun rays
    for (let i = 0; i < 8; i++) {
      const rayAngle = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(sx + 11 * Math.cos(rayAngle), sy + 11 * Math.sin(rayAngle));
      ctx.lineTo(sx + 16 * Math.cos(rayAngle), sy + 16 * Math.sin(rayAngle));
      ctx.strokeStyle = '#ffcc33';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    
    // Time label near sun
    const timeHour = Math.floor(this.timeOfDay);
    const timeMin = Math.round((this.timeOfDay - timeHour) * 60);
    const timeLabel = `${timeHour}:${timeMin.toString().padStart(2, '0')}`;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#ffcc33';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(timeLabel, sx, sy - 22);
  }
  
  // ==================== END OVERLAY SYSTEM ====================
  
  applyManualAdjustments() {
    if (!this.mesh || !this.baseScale) return;
    
    // Apply scale with multiplier
    const scale = this.baseScale * this.scaleMultiplier;
    this.mesh.scale.set(scale, scale, scale);
    
    // Apply rotation (base rotation + offset)
    this.mesh.rotation.y = this.baseRotation + (this.rotationOffset * Math.PI / 180);
    
    // Apply position offset
    this.mesh.position.x = this.offsetX;
    this.mesh.position.z = this.offsetZ;
    
    // Apply same transforms to trees
    if (this.meshTrees) {
      this.meshTrees.scale.set(scale, scale, scale);
      this.meshTrees.rotation.y = this.baseRotation + (this.rotationOffset * Math.PI / 180);
      this.meshTrees.position.x = this.offsetX;
      this.meshTrees.position.z = this.offsetZ;
    }
  }
  

  
  setupRenderer() {
    const width = window.innerWidth - 120;
    const height = window.innerHeight;
    
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
      powerPreference: 'high-performance' // Request high-performance GPU
    });
    
    // Force pixel ratio to 1. 
    // High-res retina displays will otherwise try to render everything at 4K, killing 2GB GPUs.
    this.renderer.setPixelRatio(1); 
    
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    // Use VSM for smoother shadows without banding artifacts
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
  }
  
  setupScene() {
    this.scene = new THREE.Scene();
    // Use a light neutral background in false color mode, transparent otherwise
    // The background will be updated when toggling false color mode
    this.scene.background = null; // Transparent by default
    
    // Ground plane to receive shadows (invisible except for shadows)
    // Make it very large to catch all shadows regardless of sun angle
    const groundGeometry = new THREE.PlaneGeometry(5000, 5000);
    this.shadowMaterial = new THREE.ShadowMaterial({
      opacity: this.shadowOpacity,
      color: 0x000000
    });
    
    this.groundPlane = new THREE.Mesh(groundGeometry, this.shadowMaterial);
    this.groundPlane.rotation.x = -Math.PI / 2;
    this.groundPlane.position.y = 0;
    this.groundPlane.receiveShadow = true;
    this.scene.add(this.groundPlane);
  }
  
  setupCamera() {
    const width = window.innerWidth - 120;
    const height = window.innerHeight;
    const aspect = width / height;
    
    // Orthographic camera for top-down view
    const viewSize = 300;
    this.camera = new THREE.OrthographicCamera(
      -viewSize * aspect / 2,
      viewSize * aspect / 2,
      viewSize / 2,
      -viewSize / 2,
      0.1,
      2000
    );
    
    // Top-down view looking straight down
    this.camera.position.set(0, 500, 0);
    this.camera.lookAt(0, 0, 0);
    // Rotate camera to match map bearing
    this.camera.up.set(
      Math.sin(this.mapBearing * Math.PI / 180),
      0,
      Math.cos(this.mapBearing * Math.PI / 180)
    );
  }
  
  setupLights() {
    // Hemisphere light for sky dome effect (sky color from above, ground color from below)
    // Reduced intensity for higher contrast in projection
    const hemiLight = new THREE.HemisphereLight(
      0xfff4e5,  // Warmer sky (less blue/white)
      0x444444,  // Dark ground
      0.15       // Lower intensity for high contrast
    );
    hemiLight.position.set(0, 500, 0);
    this.scene.add(hemiLight);
    
    // Minimal ambient for fill - very low for high contrast
    const ambient = new THREE.AmbientLight(0xffffff, 0.05);
    this.scene.add(ambient);
    
    // Directional sun light for shadows
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sunLight.castShadow = true;
    
    // Adjusted resolution shadow map - optimized for 2GB GPU
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    // VSM uses blurSamples instead of radius for softness
    this.sunLight.shadow.blurSamples = 8;
    this.sunLight.shadow.radius = 2;
    
    // Shadow camera settings - will be updated dynamically with sun position
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 3000;
    
    // Shadow frustum - balance between coverage and resolution
    // Smaller = better resolution but may clip, larger = more coverage but more aliasing
    // This will be dynamically updated in fitCameraToModel based on view size
    const shadowSize = 800;
    this.sunLight.shadow.camera.left = -shadowSize;
    this.sunLight.shadow.camera.right = shadowSize;
    this.sunLight.shadow.camera.top = shadowSize;
    this.sunLight.shadow.camera.bottom = -shadowSize;
    
    // Bias settings for VSM - typically needs less bias
    this.sunLight.shadow.bias = -0.0001;
    this.sunLight.shadow.normalBias = 0.02;
    
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    
    this.updateSunPosition();
  }
  
  setupPostProcessing() {
    const width = window.innerWidth - 120;
    const height = window.innerHeight;
    
    // Effect composer for post-processing
    this.composer = new EffectComposer(this.renderer);
    
    // Render pass
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);
    
    // SSAO pass for ambient occlusion
    this.ssaoPass = new SSAOPass(this.scene, this.camera, width, height);
    this.ssaoPass.kernelRadius = 32; // Increased radius for stronger AO
    this.ssaoPass.minDistance = 0.005;
    this.ssaoPass.maxDistance = 0.15; // Increased distance
    this.composer.addPass(this.ssaoPass);
    
    // SMAA antialiasing pass - better quality than FXAA
    this.smaaPass = new SMAAPass(width * this.renderer.getPixelRatio(), height * this.renderer.getPixelRatio());
    this.composer.addPass(this.smaaPass);
    
    // Output pass for correct color space
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);
  }
  
  // =========================================================================
  //  NOAA Solar Calculator  (adapted from NOAA / SunLight.js reference)
  //  Accounts for: equation of time, longitude within timezone, orbital
  //  eccentricity, obliquity nutation, and atmospheric refraction.
  // =========================================================================

  /** @private */ static _degToRad(d) { return d * (Math.PI / 180); }
  /** @private */ static _radToDeg(r) { return r * (180 / Math.PI); }

  /** @private */ static _calcGeomMeanLongSun(t) {
    let L = 280.46646 + t * (36000.76983 + t * 0.0003032);
    while (L > 360) L -= 360;
    while (L < 0) L += 360;
    return L;
  }
  /** @private */ static _calcGeomMeanAnomalySun(t) {
    return 357.52911 + t * (35999.05029 - 0.0001537 * t);
  }
  /** @private */ static _calcEccentricityEarthOrbit(t) {
    return 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  }
  /** @private */ static _calcSunEqOfCenter(t) {
    const D = SunStudy._degToRad;
    const m = SunStudy._calcGeomMeanAnomalySun(t);
    const mr = D(m);
    return Math.sin(mr)     * (1.914602 - t * (0.004817 + 0.000014 * t))
         + Math.sin(2 * mr) * (0.019993 - 0.000101 * t)
         + Math.sin(3 * mr) * 0.000289;
  }
  /** @private */ static _calcSunTrueLong(t) {
    return SunStudy._calcGeomMeanLongSun(t) + SunStudy._calcSunEqOfCenter(t);
  }
  /** @private */ static _calcSunApparentLong(t) {
    const D = SunStudy._degToRad;
    const omega = 125.04 - 1934.136 * t;
    return SunStudy._calcSunTrueLong(t) - 0.00569 - 0.00478 * Math.sin(D(omega));
  }
  /** @private */ static _calcMeanObliquityOfEcliptic(t) {
    const s = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
    return 23.0 + (26.0 + s / 60.0) / 60.0;
  }
  /** @private */ static _calcObliquityCorrection(t) {
    const D = SunStudy._degToRad;
    return SunStudy._calcMeanObliquityOfEcliptic(t)
         + 0.00256 * Math.cos(D(125.04 - 1934.136 * t));
  }
  /** @private */ static _calcSunDeclination(t) {
    const D = SunStudy._degToRad, R = SunStudy._radToDeg;
    const e = SunStudy._calcObliquityCorrection(t);
    const lambda = SunStudy._calcSunApparentLong(t);
    return R(Math.asin(Math.sin(D(e)) * Math.sin(D(lambda))));
  }
  /** @private */ static _calcEquationOfTime(t) {
    const D = SunStudy._degToRad, R = SunStudy._radToDeg;
    const e  = SunStudy._calcObliquityCorrection(t);
    const l0 = SunStudy._calcGeomMeanLongSun(t);
    const ec = SunStudy._calcEccentricityEarthOrbit(t);
    const m  = SunStudy._calcGeomMeanAnomalySun(t);
    let y = Math.tan(D(e) / 2); y *= y;
    const s2l = Math.sin(2 * D(l0)), sm  = Math.sin(D(m));
    const c2l = Math.cos(2 * D(l0)), s4l = Math.sin(4 * D(l0));
    const s2m = Math.sin(2 * D(m));
    return R(y * s2l - 2 * ec * sm + 4 * ec * y * sm * c2l
            - 0.5 * y * y * s4l - 1.25 * ec * ec * s2m) * 4; // minutes
  }

  /** @private */ static _getJD(date) {
    let m = date.getMonth() + 1, d = date.getDate(), y = date.getFullYear();
    if (m <= 2) { y--; m += 12; }
    const A = Math.floor(y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (y + 4716))
         + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
  }

  /**
   * Full NOAA solar position calculator.
   * @param {Date}   date      - calendar date
   * @param {number} timeOfDay - clock hour in local STANDARD time (e.g. 13.5 = 13:30)
   * @param {number} latitude  - degrees north
   * @returns {{ altitude: number, azimuth: number }} degrees
   */
  calculateSunPosition(date, timeOfDay, latitude) {
    const D = SunStudy._degToRad, R = SunStudy._radToDeg;
    const longitude = this.longitude;
    const tz = this.timezone;

    const totalMinutes = timeOfDay * 60;
    const jd = SunStudy._getJD(date);
    const T = ((jd + totalMinutes / 1440.0 - tz / 24.0) - 2451545.0) / 36525.0;

    // Equation of Time & declination for this Julian century
    const eqTime = SunStudy._calcEquationOfTime(T);
    const theta  = SunStudy._calcSunDeclination(T);

    // True solar time (accounts for longitude offset within timezone)
    const solarTimeFix = eqTime + 4.0 * longitude - 60.0 * tz; // minutes
    let trueSolarTime = totalMinutes + solarTimeFix;
    while (trueSolarTime > 1440) trueSolarTime -= 1440;
    while (trueSolarTime < 0)    trueSolarTime += 1440;

    let hourAngle = trueSolarTime / 4.0 - 180.0; // degrees
    if (hourAngle < -180) hourAngle += 360;

    // Zenith / elevation
    const haRad = D(hourAngle);
    let csz = Math.sin(D(latitude)) * Math.sin(D(theta))
            + Math.cos(D(latitude)) * Math.cos(D(theta)) * Math.cos(haRad);
    csz = Math.max(-1, Math.min(1, csz));
    const zenith = R(Math.acos(csz));
    const exoatmElevation = 90.0 - zenith;

    // Azimuth
    let azimuth;
    const azDenom = Math.cos(D(latitude)) * Math.sin(D(zenith));
    if (Math.abs(azDenom) > 0.001) {
      let azCos = (Math.sin(D(latitude)) * Math.cos(D(zenith))
                   - Math.sin(D(theta))) / azDenom;
      azCos = Math.max(-1, Math.min(1, azCos));
      azimuth = 180.0 - R(Math.acos(azCos));
      if (hourAngle > 0) azimuth = -azimuth;
    } else {
      azimuth = latitude > 0 ? 180 : 0;
    }
    if (azimuth < 0) azimuth += 360;

    // Atmospheric refraction correction
    let refCorr = 0;
    if (exoatmElevation <= 85) {
      const te = Math.tan(D(exoatmElevation));
      if (exoatmElevation > 5)
        refCorr = 58.1 / te - 0.07 / (te ** 3) + 0.000086 / (te ** 5);
      else if (exoatmElevation > -0.575)
        refCorr = 1735 + exoatmElevation * (-518.2 + exoatmElevation *
                  (103.4 + exoatmElevation * (-12.79 + exoatmElevation * 0.711)));
      else
        refCorr = -20.774 / te;
      refCorr /= 3600;
    }

    const altitude = exoatmElevation + refCorr;
    return { altitude, azimuth };
  }
  
  updateSunPosition() {
    if (!this.sunLight) return;
    
    const { altitude, azimuth } = this.calculateSunPosition(
      this.date, this.timeOfDay, this.latitude
    );
    
    if (this.channel) {
        this.channel.postMessage({ type: 'sun_position', altitude: altitude, azimuth: azimuth });
    }
    
    // Sun distance must be larger than the scene radius so the shadow camera
    // is always OUTSIDE the scene. At 500 the sun was inside the scene at low 
    // winter angles, causing buildings on the sun's side to fall behind the 
    // shadow camera and lose their shadows entirely.
    const distance = 2000;
    const altRad = Math.max(0.05, altitude * Math.PI / 180);
    
    const distH = distance * Math.cos(altRad);
    const azimuthRad = azimuth * Math.PI / 180;
    
    // Smooth horizon fade (like SunLight.js reference): instead of binary
    // on/off at altitude=0, fade intensity from 2° down to 0°.
    const FADE_THRESHOLD = 2.0; // degrees
    if (altitude <= 0) {
      this.sunLight.intensity = 0;
    } else if (altitude <= FADE_THRESHOLD) {
      this.sunLight.intensity = altitude / FADE_THRESHOLD;
    } else {
      this.sunLight.intensity = 1.0;
    }
    
    // Cinematic lighting: Adjust color and intensity based on altitude
    if (altitude > 0) {
      const color = new THREE.Color();
      if (altitude < 10) color.setHSL(0.05, 1.0, 0.6);
      else if (altitude < 25) { const t = (altitude - 10) / 15; color.setHSL(0.1, 1.0, 0.6 + t * 0.2); }
      else { const t = Math.min(1, (altitude - 25) / 40); color.setHSL(0.08, 0.6 - t * 0.2, 0.8 + t * 0.2); }
      this.sunLight.color.copy(color);
      // Apply smooth fade near horizon (0°-2°), then cinematic ramp above
      const fadeFactor = altitude <= FADE_THRESHOLD ? (altitude / FADE_THRESHOLD) : 1.0;
      this.sunLight.intensity = fadeFactor * Math.min(2.5, 0.8 + Math.sin(altitude * Math.PI / 180) * 2.0);
    }
    
    // PURE WORLD SPACE: North is -Z, East is +X, South is +Z, West is -X.
    // No screenAngle hack needed — the camera's "up" vector already handles
    // the visual rotation from world space to screen space.
    const sunX = distH * Math.sin(azimuthRad);
    const sunY = distance * Math.sin(altRad);
    const sunZ = -distH * Math.cos(azimuthRad);
    
    // Dirty flag check
    const threshold = 0.1;
    if (Math.abs(sunX - this.lastSunPosition.x) > threshold ||
        Math.abs(sunY - this.lastSunPosition.y) > threshold ||
        Math.abs(sunZ - this.lastSunPosition.z) > threshold) {
      this.shadowMapsDirty = true;
      this.needsRender = true;
      this.overlayDirty = true;
      this.falseColorUniformsDirty = true;
      this.lastSunPosition = { x: sunX, y: sunY, z: sunZ };
    }
    
    this.sunLight.position.set(sunX, sunY, sunZ);
    
    // Offset target logic
    const shadowExtensionFactor = Math.max(0, (1 - Math.sin(altRad)) * 300);
    const targetOffsetX = -sunX / distance * shadowExtensionFactor;
    const targetOffsetZ = -sunZ / distance * shadowExtensionFactor;
    this.sunLight.target.position.set(targetOffsetX, 50, targetOffsetZ);
    this.sunLight.target.updateMatrixWorld();
    
    // --- FIX START: Use optimal size ---
    // Use the calculated size from fitCameraToModel, defaulting to 800 if not ready
    const baseSize = this.optimalShadowSize || 800;
    
    // Dynamic expansion based on sun angle (clamped to prevent explosion)
    const altitudeFactor = Math.max(0.15, Math.sin(altRad)); 
    const dynamicShadowSize = baseSize / altitudeFactor; 
    
    // Clamp max size to preserve resolution. 
    // If shadows go beyond 4000 units, they will clip, but the visible part will look sharp.
    const clampedShadowSize = Math.min(dynamicShadowSize, 4000); 
    // --- FIX END ---
    
    this.sunLight.shadow.camera.left = -clampedShadowSize;
    this.sunLight.shadow.camera.right = clampedShadowSize;
    this.sunLight.shadow.camera.top = clampedShadowSize;
    this.sunLight.shadow.camera.bottom = -clampedShadowSize;
    
    this.sunLight.shadow.camera.updateProjectionMatrix();
    this.sunLight.updateMatrixWorld();
    
    // Update auxiliary cameras
    if (this.shadowCameraBuildings) {
      this.shadowCameraBuildings.left = -clampedShadowSize;
      this.shadowCameraBuildings.right = clampedShadowSize;
      this.shadowCameraBuildings.top = clampedShadowSize;
      this.shadowCameraBuildings.bottom = -clampedShadowSize;
      this.shadowCameraBuildings.updateProjectionMatrix();
    }
    if (this.shadowCameraTrees) {
      this.shadowCameraTrees.left = -clampedShadowSize;
      this.shadowCameraTrees.right = clampedShadowSize;
      this.shadowCameraTrees.top = clampedShadowSize;
      this.shadowCameraTrees.bottom = -clampedShadowSize;
      this.shadowCameraTrees.updateProjectionMatrix();
    }
  }
  
  loadSTLModel() {
    const loader = new STLLoader();
    console.log('Loading STL model (buildings/terrain)...');
    
    loader.load(
      './media/mesh.stl',
      (geometry) => {
        console.log('STL loaded, vertices:', geometry.attributes.position.count);
        
        // Convert Rhino Z-up to Three.js Y-up via -90° X rotation (right-handed)
        const positions = geometry.attributes.position.array;
        for (let i = 0; i < positions.length; i += 3) {
          const y = positions[i + 1];
          const z = positions[i + 2];
          positions[i + 1] = z;   // New Y = old Z
          positions[i + 2] = -y;  // New Z = negative old Y
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.computeVertexNormals();
        
        geometry.computeBoundingBox();
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        geometry.boundingBox.getSize(size);
        geometry.boundingBox.getCenter(center);
        
        console.log('STL size:', size);
        
        // Store center for aligning trees later
        this.buildingsCenter = center.clone();
        
        // Center geometry
        geometry.translate(-center.x, -center.y, -center.z);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        
        // Material - matte white for better projection contrast
        this.standardMaterial = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 1.0,
          metalness: 0.0,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 1,
          depthWrite: true
        });
        
        this.meshBuildings = new THREE.Mesh(geometry, this.standardMaterial);
        this.meshBuildings.castShadow = true;
        this.meshBuildings.receiveShadow = true;
        this.meshBuildings.renderOrder = 1;
        this.meshBuildings.frustumCulled = true;
        
        // Keep reference as this.mesh for compatibility
        this.mesh = this.meshBuildings;
        
        // Store model size for fitting
        this.modelSize = size;

        
        // Initial setup
        this.baseRotation = -Math.PI/2; 
        this.meshBuildings.rotation.y = this.baseRotation;
        
        // Apply initial position offset
        this.meshBuildings.position.x = this.offsetX;
        this.meshBuildings.position.y = 50;
        this.meshBuildings.position.z = this.offsetZ;
        
        this.scene.add(this.meshBuildings);
        this.fitCameraToModel();
        
        console.log('Buildings STL added - size:', size);
      },
      (progress) => {
        console.log('Loading STL...', progress.loaded, 'bytes');
      },
      (error) => {
        console.error('Error loading STL:', error);
      }
    );
  }
  
  loadTreesSTL() {
    if (this.treesLoaded) return;
    
    const loader = new GLTFLoader();
    console.log('Loading trees GLB model (instanced)...');
    
    /**
     * ==================== MESH ALIGNMENT GUIDE ====================
     * 
     * When loading additional meshes to align with the buildings (mesh.stl):
     * 
     * 1. FILE FORMAT DIFFERENCES:
     *    - STL files (mesh.stl): Z-up (Rhino), converted via -90° X rotation
     *      (new Y = old Z, new Z = -old Y) to Three.js Y-up right-handed
     *    - GLB/GLTF files: Already Y-up (Three.js convention), NO transform needed
     * 
     * 2. COORDINATE ALIGNMENT:
     *    - Both models must be exported from the same origin in the 3D software
     *    - The buildings center is stored in this.buildingsCenter after STL loads
     *    - Use this.buildingsCenter to center any additional meshes
     * 
     * 3. TRANSFORM ORDER (applied to mesh):
     *    - Scale: this.baseScale * this.scaleMultiplier (uniform, no axis negation)
     *    - Rotation: this.baseRotation (-PI/2) + rotationOffset
     *    - Position: offsetX, 50 (Y height), offsetZ
     * 
     * 4. DEBUGGING:
     *    - Log raw bounds immediately after load
     *    - Log bounds after coordinate transforms
     *    - Compare center values with this.buildingsCenter
     *    - After centering, final center should be (0, 0, 0) or very close
     * 
     * ===============================================================
     */
    
    loader.load(
      './media/trees_instanced.glb',
      (gltf) => {
        console.log('Trees GLB loaded');
        
        // Debug: Log the raw GLTF scene bounds
        const rawBox = new THREE.Box3().setFromObject(gltf.scene);
        const rawSize = new THREE.Vector3();
        const rawCenter = new THREE.Vector3();
        rawBox.getSize(rawSize);
        rawBox.getCenter(rawCenter);
        console.log('GLB raw bounds - size:', rawSize, 'center:', rawCenter);
        console.log('Buildings center for reference:', this.buildingsCenter);
        
        // Tree material - green tint to distinguish. 
        // Optimization for trees: disabled transparency and double-sided rendering to drastically reduce overdraw
        this.standardMaterialTrees = new THREE.MeshStandardMaterial({
          color: 0x4a7c4e,
          roughness: 0.9,
          metalness: 0.0,
          side: THREE.FrontSide, // FrontSide is twice as fast as DoubleSide
          transparent: false,    // Shadows without transparency saves huge amounts of fill rate
          opacity: 1.0,
          depthWrite: true
        });
        
        // Optimization: Merging all individual tree meshes into ONE single massive geometry.
        // This takes thousands of draw calls down to exactly 1 draw call, massively relieving the CPU!
        const treeGeometries = [];
        
        // Traverse the GLTF scene and process all meshes
        gltf.scene.traverse((child) => {
          if (child.isMesh) {
            // Clone geometry to modify it
            let geometry = child.geometry.clone();
            
            // To successfully merge geometries, we need to make sure they don't have incompatible attributes
            // Many GLB exports contain normals, tangents, uvs, etc. For our shadow purpose, we only strictly need position and normal.
            const validAttributes = ['position', 'normal'];
            const attributesToDelete = [];
            for (const attributeName in geometry.attributes) {
                if (!validAttributes.includes(attributeName)) {
                    attributesToDelete.push(attributeName);
                }
            }
            attributesToDelete.forEach(attr => geometry.deleteAttribute(attr));
            
            // Apply the mesh's world matrix to the geometry
            child.updateWorldMatrix(true, false);
            geometry.applyMatrix4(child.matrixWorld);
            
            // GLB is already Y-up (GLTF standard), no coordinate transform needed
            geometry.attributes.position.needsUpdate = true;
            
            treeGeometries.push(geometry);
          } // <- Fixed syntax here closing the if
        }); // <- Fixed syntax here closing the traverse
        
        if (treeGeometries.length === 0) {
            console.warn("No meshes found in trees GLB!");
            return;
        }
        
        const mergedGeometry = BufferGeometryUtils.mergeGeometries(treeGeometries, false);
        mergedGeometry.computeBoundingBox();
        mergedGeometry.computeVertexNormals();
        
        // Instead of a Group, meshTrees is now just a single massive optimized Mesh
        this.meshTrees = new THREE.Mesh(mergedGeometry, this.standardMaterialTrees);
        this.meshTrees.castShadow = true;
        this.meshTrees.receiveShadow = false;
        
        // Compute bounding box for the new combined mesh
        const box = new THREE.Box3().setFromObject(this.meshTrees);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        console.log('Trees bounds after transform - size:', size, 'center:', center);
        console.log('Buildings center was:', this.buildingsCenter);
        
        // Use the BUILDINGS center for alignment since both models share the same world origin
        // This ensures perfect alignment between buildings and trees
        const alignCenter = this.buildingsCenter || center;
        this.meshTrees.geometry.translate(-alignCenter.x, -alignCenter.y, -alignCenter.z);
        console.log('Trees centered using buildings center:', alignCenter);
        
        // Debug: Final bounds after centering
        const finalBox = new THREE.Box3().setFromObject(this.meshTrees);
        const finalSize = new THREE.Vector3();
        const finalCenter = new THREE.Vector3();
        finalBox.getSize(finalSize);
        finalBox.getCenter(finalCenter);
        console.log('Trees final bounds - size:', finalSize, 'center:', finalCenter);
        
        this.meshTrees.renderOrder = 2;
        this.meshTrees.frustumCulled = true;
        
        // Apply same transforms as buildings
        if (this.baseScale) {
          const scale = this.baseScale * this.scaleMultiplier;
          this.meshTrees.scale.set(scale, scale, scale);
          console.log('Trees scale applied:', scale);
        }
        this.meshTrees.rotation.y = this.baseRotation + (this.rotationOffset * Math.PI / 180);
        this.meshTrees.position.x = this.offsetX;
        this.meshTrees.position.y = 50;
        this.meshTrees.position.z = this.offsetZ;
        
        this.scene.add(this.meshTrees);
        
        this.treesLoaded = true;
        this.treesVisible = true;
        this.shadowMapsDirty = true;
        
        // Hide trees if in false color mode
        if (this.isFalseColorMode) {
          this.meshTrees.visible = false;
        }
        
        // Notify controller
        if (this.channel) {
          this.channel.postMessage({
            type: 'trees_state',
            visible: this.treesVisible,
            loaded: this.treesLoaded
          });
        }
        
        console.log('Trees GLB added with', this.meshTrees.children.length, 'meshes');
      },
      (progress) => {
        console.log('Loading trees GLB...', progress.loaded, 'bytes');
      },
      (error) => {
        console.error('Error loading trees GLB:', error);
        if (this.channel) {
          this.channel.postMessage({
            type: 'trees_state',
            visible: false,
            loaded: false,
            error: 'Failed to load trees_instanced.glb'
          });
        }
      }
    );
  }
  
  fitCameraToModel() {
    if (!this.mesh || !this.modelSize) return;
    
    const canvasWidth = window.innerWidth - 120;
    const canvasHeight = window.innerHeight;
    
    // Fit model to canvas with padding
    const padding = 0.8;
    const maxDim = Math.max(this.modelSize.x, this.modelSize.z);
    const minCanvasDim = Math.min(canvasWidth, canvasHeight);
    
    const scale = ((minCanvasDim * padding) / maxDim) * 2.0;
    
    // Apply scale
    this.mesh.scale.set(scale * this.scaleMultiplier, scale * this.scaleMultiplier, scale * this.scaleMultiplier);
    if (this.meshTrees) {
      this.meshTrees.scale.set(scale * this.scaleMultiplier, scale * this.scaleMultiplier, scale * this.scaleMultiplier);
    }

    this.baseScale = scale;
    
    // --- FIX START: Calculate and store the OPTIMAL base shadow size ---
    // Instead of hardcoding 800, we use the actual model bounds.
    // We add a 20% buffer to ensure shadows don't clip at the edges.
    const worldRadius = (maxDim * scale) / 2;
    this.optimalShadowSize = Math.max(worldRadius * 1.2, 100); 
    // --- FIX END ---

    // Set Main Camera
    this.camera.left = -canvasWidth / 2;
    this.camera.right = canvasWidth / 2;
    this.camera.top = canvasHeight / 2;
    this.camera.bottom = -canvasHeight / 2;
    this.camera.updateProjectionMatrix();
    
    // Force an update immediately
    this.updateSunPosition(); 
    this.shadowMapsDirty = true;
  }
  
  onResize() {
    if (!this.isActive || !this.renderer) return;
    
    const width = window.innerWidth - 120;
    const height = window.innerHeight;
    const pixelRatio = this.renderer.getPixelRatio();
    
    this.renderer.setSize(width, height);
    if (this.composer) {
      this.composer.setSize(width, height);
    }
    if (this.ssaoPass) {
      this.ssaoPass.setSize(width, height);
    }
    if (this.smaaPass) {
      this.smaaPass.setSize(width * pixelRatio, height * pixelRatio);
    }
    
    // Resize shadow targets (account for pixel ratio)
    const targetWidth = Math.floor(width * pixelRatio);
    const targetHeight = Math.floor(height * pixelRatio);
    if (this.shadowTargetBuildings) {
      this.shadowTargetBuildings.setSize(targetWidth, targetHeight);
    }
    if (this.shadowTargetCombined) {
      this.shadowTargetCombined.setSize(targetWidth, targetHeight);
    }
    
    if (this.mesh) {
      this.fitCameraToModel();
    }
    
    this.resizeOverlay();
    this.shadowMapsDirty = true;
    this.needsRender = true;
    this.overlayDirty = true;
    this.falseColorUniformsDirty = true;
    this._compassSize = 0; // Invalidate compass cache on resize
  }
  
  animate() {
    if (!this.isActive) return;
    
    this.animationId = requestAnimationFrame(() => this.animate());
    
    if (this.isAnimating) {
      this.timeOfDay += this.animationSpeed * 0.016;
      if (this.timeOfDay >= 24) this.timeOfDay = 0;
      this.updateTimeDisplay();
      this.updateSunPosition();
      // Animation sets all dirty flags via updateSunPosition
    }
    
    // PERF: Skip all GPU work if nothing has changed
    if (this.needsRender) {
      // Render shadow maps for false color mode (gated on shadowMapsDirty inside)
      if (this.isFalseColorMode) {
        this.renderShadowMaps();
        this.updateFalseColorUniforms();
      }
      
      // Use composer for post-processing (SSAO)
      if (this.composer) {
        this.composer.render();
      } else {
        this.renderer.render(this.scene, this.camera);
      }
      
      this.needsRender = false;
    }
    
    // Draw 2D overlays (compass rose + sun path) — gated on overlayDirty inside
    this.drawOverlays();
  }
  
  async toggle() {
    this.isActive = !this.isActive;
    
    const sunBtn = document.getElementById('sun-study-btn');
    if (sunBtn) sunBtn.classList.toggle('active', this.isActive);
    
    // Broadcast state to controller
    if (this.channel) {
      this.channel.postMessage({ type: 'animation_state', animationId: 'sun-study-btn', isActive: this.isActive });
    }
    
    if (this.isActive) {
      await this.show();
    } else {
      this.hide();
    }
  }
  
  async show() {
    if (!this.dependenciesLoaded) {
      await this.initThreeJS();
    }
    
    this.canvas.style.display = 'block';
    if (this.overlayCanvas) this.overlayCanvas.style.display = 'block';
    this.shadowMapsDirty = true;
    this.needsRender = true;
    this.overlayDirty = true;
    
    setTimeout(() => {
      this.onResize();
      this.animate();
    }, 50);
  }
  
  // ==================== MEMORY PROFILING ====================
  
  getMemoryReport() {
    const report = {
      gpu: {},
      js: {},
      threeInfo: {},
      totals: { gpuMB: 0, jsMB: 0 }
    };
    
    const MB = 1024 * 1024;
    let totalGPU = 0;
    
    // --- 1. Render Targets (shadow maps) ---
    const rtSizes = {};
    const measureRT = (name, rt) => {
      if (!rt) return;
      const w = rt.width;
      const h = rt.height;
      // RedFormat = 1 byte/pixel, RGBAFormat = 4 bytes/pixel
      const bpp = (rt.texture && rt.texture.format === THREE.RedFormat) ? 1 : 4;
      const bytes = w * h * bpp;
      rtSizes[name] = { width: w, height: h, bpp, bytes };
      totalGPU += bytes;
    };
    measureRT('shadowTargetBuildings', this.shadowTargetBuildings);
    measureRT('shadowTargetCombined', this.shadowTargetCombined);
    report.gpu.renderTargets = rtSizes;
    
    // --- 2. Shadow Map (directional light) ---
    if (this.sunLight && this.sunLight.shadow && this.sunLight.shadow.map) {
      const sm = this.sunLight.shadow.map;
      // Shadow maps are depth textures, typically 4 bytes/pixel (DEPTH_COMPONENT32F)
      // VSM uses 2-channel (RG) float = 8 bytes/pixel
      const isVSM = this.renderer && this.renderer.shadowMap.type === THREE.VSMShadowMap;
      const bpp = isVSM ? 8 : 4;
      const bytes = sm.width * sm.height * bpp;
      report.gpu.shadowMap = { width: sm.width, height: sm.height, bpp, type: isVSM ? 'VSM' : 'PCF/Basic', bytes };
      totalGPU += bytes;
    } else {
      report.gpu.shadowMap = { status: 'not allocated' };
    }
    
    // --- 3. Post-processing buffers (EffectComposer) ---
    if (this.composer) {
      const ppBuffers = {};
      // Composer has at least 2 render targets (read/write buffers)
      if (this.composer.readBuffer) {
        const rb = this.composer.readBuffer;
        const bytes = rb.width * rb.height * 4; // RGBA
        ppBuffers.readBuffer = { width: rb.width, height: rb.height, bytes };
        totalGPU += bytes;
      }
      if (this.composer.writeBuffer) {
        const wb = this.composer.writeBuffer;
        const bytes = wb.width * wb.height * 4;
        ppBuffers.writeBuffer = { width: wb.width, height: wb.height, bytes };
        totalGPU += bytes;
      }
      // SSAO has its own internal buffers (normal, depth, AO)
      if (this.ssaoPass) {
        // SSAO typically allocates ~3 full-res render targets
        const w = this.ssaoPass.width || (window.innerWidth - 120);
        const h = this.ssaoPass.height || window.innerHeight;
        const ssaoBytes = w * h * 4 * 3; // 3 targets × RGBA
        ppBuffers.ssaoEstimate = { width: w, height: h, targets: 3, bytes: ssaoBytes };
        totalGPU += ssaoBytes;
      }
      // SMAA uses area and search textures (~1MB fixed)
      if (this.smaaPass) {
        ppBuffers.smaaFixed = { bytes: 1 * MB, note: 'area+search textures' };
        totalGPU += 1 * MB;
      }
      report.gpu.postProcessing = ppBuffers;
    }
    
    // --- 4. Geometry buffers (vertex data on GPU) ---
    const geoSizes = {};
    const measureGeometry = (name, mesh) => {
      if (!mesh || !mesh.geometry) return;
      const geo = mesh.geometry;
      let bytes = 0;
      for (const attrName in geo.attributes) {
        const attr = geo.attributes[attrName];
        bytes += attr.array ? attr.array.byteLength : 0;
      }
      if (geo.index && geo.index.array) {
        bytes += geo.index.array.byteLength;
      }
      const vertexCount = geo.attributes.position ? geo.attributes.position.count : 0;
      const faceCount = geo.index ? geo.index.count / 3 : vertexCount / 3;
      geoSizes[name] = { vertices: vertexCount, faces: Math.floor(faceCount), bytes };
      totalGPU += bytes;
    };
    measureGeometry('buildings', this.meshBuildings);
    measureGeometry('trees', this.meshTrees);
    measureGeometry('groundPlane', this.groundPlane);
    report.gpu.geometry = geoSizes;
    
    // --- 5. Canvas memory ---
    const canvasSizes = {};
    if (this.canvas) {
      const bytes = this.canvas.width * this.canvas.height * 4;
      canvasSizes.webglCanvas = { width: this.canvas.width, height: this.canvas.height, bytes };
      totalGPU += bytes;
    }
    if (this.overlayCanvas) {
      const bytes = this.overlayCanvas.width * this.overlayCanvas.height * 4;
      canvasSizes.overlayCanvas = { width: this.overlayCanvas.width, height: this.overlayCanvas.height, bytes };
      totalGPU += bytes;
    }
    if (this._compassCanvas) {
      const bytes = this._compassCanvas.width * this._compassCanvas.height * 4;
      canvasSizes.compassCache = { width: this._compassCanvas.width, height: this._compassCanvas.height, bytes };
      totalGPU += bytes;
    }
    report.gpu.canvases = canvasSizes;
    
    // --- 6. Three.js renderer info ---
    if (this.renderer) {
      const info = this.renderer.info;
      report.threeInfo = {
        memory: {
          geometries: info.memory.geometries,
          textures: info.memory.textures
        },
        render: {
          calls: info.render.calls,
          triangles: info.render.triangles,
          points: info.render.points,
          lines: info.render.lines,
          frame: info.render.frame
        },
        programs: info.programs ? info.programs.length : 0
      };
    }
    
    // --- 7. JS Heap (Chrome only) ---
    if (performance && performance.memory) {
      report.js = {
        usedHeapMB: (performance.memory.usedJSHeapSize / MB).toFixed(1),
        totalHeapMB: (performance.memory.totalJSHeapSize / MB).toFixed(1),
        limitMB: (performance.memory.jsHeapSizeLimit / MB).toFixed(1)
      };
      report.totals.jsMB = (performance.memory.usedJSHeapSize / MB).toFixed(1);
    } else {
      report.js = { note: 'performance.memory not available (Chrome only)' };
    }
    
    report.totals.gpuMB = (totalGPU / MB).toFixed(2);
    report.totals.gpuBytes = totalGPU;
    
    // --- Pretty-print to console ---
    console.group('%c☀ Sun Study Memory Report', 'color: #ffcc33; font-weight: bold; font-size: 14px');
    
    console.group('GPU Render Targets');
    for (const [name, info] of Object.entries(rtSizes)) {
      console.log(`  ${name}: ${info.width}×${info.height} @ ${info.bpp}bpp = ${(info.bytes / MB).toFixed(2)} MB`);
    }
    console.groupEnd();
    
    console.group('Shadow Map');
    const sm = report.gpu.shadowMap;
    if (sm.bytes) {
      console.log(`  ${sm.width}×${sm.height} ${sm.type} @ ${sm.bpp}bpp = ${(sm.bytes / MB).toFixed(2)} MB`);
    } else {
      console.log('  Not allocated');
    }
    console.groupEnd();
    
    if (report.gpu.postProcessing) {
      console.group('Post-Processing');
      for (const [name, info] of Object.entries(report.gpu.postProcessing)) {
        console.log(`  ${name}: ${(info.bytes / MB).toFixed(2)} MB`);
      }
      console.groupEnd();
    }
    
    console.group('Geometry (vertex buffers)');
    for (const [name, info] of Object.entries(geoSizes)) {
      console.log(`  ${name}: ${info.vertices.toLocaleString()} verts, ${info.faces.toLocaleString()} tris = ${(info.bytes / MB).toFixed(2)} MB`);
    }
    console.groupEnd();
    
    console.group('Canvases');
    for (const [name, info] of Object.entries(canvasSizes)) {
      console.log(`  ${name}: ${info.width}×${info.height} = ${(info.bytes / MB).toFixed(2)} MB`);
    }
    console.groupEnd();
    
    console.log(`%cThree.js: ${report.threeInfo?.memory?.geometries || 0} geometries, ${report.threeInfo?.memory?.textures || 0} textures, ${report.threeInfo?.programs || 0} shader programs`, 'color: #888');
    console.log(`%cDraw calls last frame: ${report.threeInfo?.render?.calls || 0}, triangles: ${(report.threeInfo?.render?.triangles || 0).toLocaleString()}`, 'color: #888');
    
    if (report.js.usedHeapMB) {
      console.log(`%cJS Heap: ${report.js.usedHeapMB} / ${report.js.totalHeapMB} MB (limit: ${report.js.limitMB} MB)`, 'color: #66ccff');
    }
    
    console.log(`%c━━━ TOTAL ESTIMATED GPU: ${report.totals.gpuMB} MB ━━━`, 'color: #ff6633; font-weight: bold; font-size: 12px');
    console.groupEnd();
    
    // Broadcast to controller
    if (this.channel) {
      this.channel.postMessage({ type: 'memory_report', report });
    }
    
    return report;
  }
  
  // ==================== END MEMORY PROFILING ====================
  
  hide() {
    this.canvas.style.display = 'none';
    if (this.overlayCanvas) this.overlayCanvas.style.display = 'none';
    // this.controlPanel.style.display = 'none'; // Panel moved to controller
    this.isAnimating = false;
    
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    
    // Button logic moved to controller
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.sunStudy = new SunStudy();
});

export { SunStudy };
