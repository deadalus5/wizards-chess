import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  BrightnessContrastEffect,
  DepthOfFieldEffect,
  EdgeDetectionMode,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectMaterial,
  EffectPass,
  HueSaturationEffect,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

/**
 * Encodes to sRGB at the end of the grading pass so the anti-aliasing pass that follows detects
 * edges on perceptual values. In linear light the dark hall's edges fall below SMAA's thresholds.
 * The effect deliberately keeps the default colour-space tags so the pass does not convert back.
 */
class SRGBEncodeEffect extends Effect {
  constructor() {
    super(
      'SRGBEncodeEffect',
      /* glsl */ `void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        outputColor = sRGBTransferOETF(vec4(clamp(inputColor.rgb, 0.0, 1.0), inputColor.a));
      }`,
      { blendFunction: BlendFunction.SRC },
    );
  }
}

/** Cinema bars drawn in the shader (so frame captures include them and they follow game time). */
class LetterboxEffect extends Effect {
  constructor() {
    super(
      'LetterboxEffect',
      /* glsl */ `uniform float amount;
      uniform float barSize;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        float bar = barSize * amount;
        float edge = 0.0015;
        float m = smoothstep(bar - edge, bar + edge, uv.y) * smoothstep(bar - edge, bar + edge, 1.0 - uv.y);
        outputColor = vec4(inputColor.rgb * m, inputColor.a);
      }`,
      {
        blendFunction: BlendFunction.SRC,
        uniforms: new Map<string, THREE.Uniform>([
          ['amount', new THREE.Uniform(0)],
          ['barSize', new THREE.Uniform(0.115)],
        ]),
      },
    );
  }
  get amount(): number {
    return this.uniforms.get('amount')!.value as number;
  }
  set amount(v: number) {
    this.uniforms.get('amount')!.value = v;
  }
}

/** What the particle shaders need to test themselves against the scene's depth. */
export interface OverlayUniforms {
  tDepth: THREE.IUniform<THREE.Texture | null>;
  /** Size of the overlay buffer in pixels. */
  uResolution: THREE.IUniform<THREE.Vector2>;
  /** Camera near and far planes. */
  uNearFar: THREE.IUniform<THREE.Vector2>;
}

/**
 * The particle layer. Dust and sparks are drawn into a buffer of their own after depth of
 * field and laid over the picture: drawn with the scene they would take on the blur of
 * whatever is behind them and be darkened by its ambient occlusion. They test and soften
 * themselves against the scene's depth in their own shaders.
 */
class OverlayEffect extends Effect {
  readonly target: THREE.WebGLRenderTarget;
  private readonly clearColor = new THREE.Color();

  constructor(
    private readonly overlay: THREE.Scene,
    private readonly overlayCamera: THREE.Camera,
    private readonly shared: OverlayUniforms,
  ) {
    super(
      'OverlayEffect',
      /* glsl */ `uniform sampler2D tOverlay;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec4 o = texture2D(tOverlay, uv);
        outputColor = vec4(inputColor.rgb * (1.0 - o.a) + o.rgb, inputColor.a);
      }`,
      { blendFunction: BlendFunction.SRC, attributes: EffectAttribute.DEPTH, uniforms: new Map<string, THREE.Uniform>([['tOverlay', new THREE.Uniform(null)]]) },
    );
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.target.texture.name = 'overlay';
    this.uniforms.get('tOverlay')!.value = this.target.texture;
  }

  override setDepthTexture(depthTexture: THREE.Texture): void {
    this.shared.tDepth.value = depthTexture;
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.shared.uResolution.value.set(width, height);
  }

  override update(renderer: THREE.WebGLRenderer): void {
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.overlay, this.overlayCamera);
    renderer.setClearColor(this.clearColor, alpha);
  }
}

export interface Look {
  exposure: number;
  bloomIntensity: number;
  bloomThreshold: number;
  aoIntensity: number;
  aoRadius: number;
  vignette: number;
  grain: number;
  contrast: number;
  saturation: number;
}

export const DEFAULT_LOOK: Look = {
  exposure: 1.0,
  bloomIntensity: 0.9,
  bloomThreshold: 1.0,
  aoIntensity: 3.0,
  aoRadius: 0.55,
  vignette: 0.5,
  grain: 0.055,
  contrast: 0.08,
  saturation: 0.05,
};

/**
 * Renderer plus the post-processing chain:
 *   scene -> ambient occlusion -> depth of field -> particles -> bloom/tone map/grade/encode -> SMAA/grain/letterbox
 * HalfFloat buffers, no MSAA (it does not combine with the AO pass).
 */
export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly ao: N8AOPostPass;
  readonly dof: DepthOfFieldEffect;
  readonly dofPass: EffectPass;
  readonly bloom: BloomEffect;
  readonly tone: ToneMappingEffect;
  readonly hueSat: HueSaturationEffect;
  readonly contrast: BrightnessContrastEffect;
  readonly vignette: VignetteEffect;
  readonly smaa: SMAAEffect;
  readonly grain: NoiseEffect;
  readonly letterbox: LetterboxEffect;
  readonly gradePass: EffectPass;
  readonly finalPass: EffectPass;
  /** Scene for dust and sparks, drawn over the picture after depth of field. */
  readonly overlay = new THREE.Scene();
  readonly overlayUniforms: OverlayUniforms;
  /** Enabled only while there is something in the overlay to draw. */
  readonly overlayPass: EffectPass;
  /** World-space point the depth of field focuses on. */
  readonly focus = new THREE.Vector3();

  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;

  constructor(
    readonly scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
    parent: HTMLElement,
  ) {
    const renderer = new THREE.WebGLRenderer({ powerPreference: 'high-performance', antialias: false, stencil: false, depth: false });
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.info.autoReset = false;
    renderer.domElement.style.display = 'block';
    parent.appendChild(renderer.domElement);
    this.renderer = renderer;

    const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer = composer;
    // Lets the three.js devtools bridge find the post-processing chain.
    (renderer as unknown as { userData: Record<string, unknown> }).userData = { effectComposer: composer };

    this.renderPass = new RenderPass(scene, camera);
    composer.addPass(this.renderPass);

    const ao = new N8AOPostPass(scene, camera, 1, 1);
    // Auto-detection traverses the whole scene every frame and, once it sees a transparent
    // material, renders the scene twice more per frame. Transparent effects are drawn separately.
    ao.autoDetectTransparency = false;
    ao.configuration.halfRes = true;
    ao.setQualityMode('Medium');
    ao.configuration.distanceFalloff = 1.0;
    ao.configuration.color = new THREE.Color(0x070504);
    this.ao = ao;
    composer.addPass(ao);

    this.dof = new DepthOfFieldEffect(camera, { focusDistance: 5, focusRange: 6, bokehScale: 3, resolutionScale: 0.5 });
    this.dof.target = this.focus;
    this.dofPass = new EffectPass(camera, this.dof);
    this.dofPass.enabled = false;
    composer.addPass(this.dofPass);

    this.overlayUniforms = { tDepth: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(camera.near, camera.far) } };
    this.overlayPass = new EffectPass(camera, new OverlayEffect(this.overlay, camera, this.overlayUniforms));
    this.overlayPass.enabled = false;
    composer.addPass(this.overlayPass);

    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.08, intensity: 0.9, radius: 0.8, levels: 8 });
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.hueSat = new HueSaturationEffect({ saturation: 0.05 });
    this.contrast = new BrightnessContrastEffect({ contrast: 0.08 });
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.5 });
    this.gradePass = new EffectPass(camera, this.bloom, this.tone, this.hueSat, this.contrast, this.vignette, new SRGBEncodeEffect());
    composer.addPass(this.gradePass);

    this.smaa = new SMAAEffect({ preset: SMAAPreset.HIGH, edgeDetectionMode: EdgeDetectionMode.COLOR });
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.letterbox = new LetterboxEffect();
    this.finalPass = new EffectPass(camera, this.smaa, this.grain, this.letterbox);
    // The grading pass already encoded to sRGB.
    (this.finalPass.fullscreenMaterial as EffectMaterial).encodeOutput = false;
    this.finalPass.dithering = true;
    composer.addPass(this.finalPass);

    this.applyLook(DEFAULT_LOOK);
  }

  applyLook(look: Look): void {
    this.renderer.toneMappingExposure = look.exposure;
    this.bloom.intensity = look.bloomIntensity;
    this.bloom.luminanceMaterial.threshold = look.bloomThreshold;
    this.ao.configuration.intensity = look.aoIntensity;
    this.ao.configuration.aoRadius = look.aoRadius;
    this.vignette.darkness = look.vignette;
    this.grain.blendMode.opacity.value = look.grain;
    this.contrast.contrast = look.contrast;
    this.hueSat.saturation = look.saturation;
  }

  /** Size in CSS pixels plus the device pixel ratio to render at. */
  setSize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.pixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.composer.setSize(cssWidth, cssHeight);
    this.camera.aspect = cssWidth / cssHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Internal render resolution in physical pixels. */
  get renderSize(): { width: number; height: number } {
    const v = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return { width: v.x, height: v.y };
  }

  /** Force the internal resolution (for measuring at the real panel size from a small window). */
  setRenderPixels(width: number): void {
    this.setSize(this.cssWidth, this.cssHeight, width / this.cssWidth);
  }

  /** Current depth-of-field strength (0 = off) and the range over which blur reaches full. */
  bokeh = 0;
  focusRange = 6;

  /** Depth of field on/off with strength; the focus point is `this.focus`. */
  setDepthOfField(bokehScale: number, focusRange = 6): void {
    this.dofPass.enabled = bokehScale > 0.01;
    this.dof.bokehScale = bokehScale;
    this.dof.cocMaterial.focusRange = focusRange;
    this.bokeh = this.dofPass.enabled ? bokehScale : 0;
    this.focusRange = focusRange;
  }

  render(dt: number): void {
    this.renderer.info.reset();
    this.composer.render(dt);
  }
}
