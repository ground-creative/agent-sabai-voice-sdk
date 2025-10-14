/**
 * AudioVisualizer - A component for visualizing audio levels with an equalizer display
 */

import { DEFAULT_AUDIO_VISUALIZER_OPTIONS } from '../types/config';

// CSS styles as a string - automatically injected
const AUDIO_VISUALIZER_CSS = `
/* Audio Visualizer / Equalizer Styles */
.audio-visualizer {
  display: flex;
  align-items: flex-end; /* Align bars to the bottom */
  justify-content: space-between; /* Distribute bars to fill the entire width */
  width: 100%; /* Full width of its container */
  height: 100%; /* Full height of its container */
  border-radius: 4px;
  box-sizing: border-box;
  overflow: hidden;
  gap: 2px; /* Small gap between bars */
  transition: visibility 0.2s ease; /* Smooth transition for visibility changes */
}

.equalizer-bar {
  flex: 1; /* Each bar takes equal width of available space */
  height: 1%; /* Starting height - will be animated up to 100% */
  background: linear-gradient(
    to top,
    rgba(67, 160, 71, 0.8) 0%,
    rgba(76, 175, 80, 0.9) 50%,
    rgba(139, 195, 74, 1) 100%
  );
  box-shadow: 0 0 4px rgba(67, 160, 71, 0.5); /* Add glow effect to active bars */
  margin: 0; /* No margins since we're using gap */
  border-radius: 2px 2px 0 0; /* Slight rounded corners on top only */
  transition:
    height 0.03s ease-out,
    opacity 0.2s ease; /* Smoother transitions */
  transform-origin: bottom; /* Ensure the bars grow from bottom */
  will-change: height, opacity; /* Optimize for animations */
  min-width: 0; /* No minimum width */
  max-width: none; /* No maximum width */
}
`;

// Track if styles have been injected to avoid duplicates
let stylesInjected = false;

/**
 * Inject the AudioVisualizer CSS styles into the document head
 */
function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') {
    return;
  }
  
  // Check if styles already exist
  if (document.getElementById('audio-visualizer-styles')) {
    stylesInjected = true;
    return;
  }
  
  const style = document.createElement('style');
  style.id = 'audio-visualizer-styles';
  style.textContent = AUDIO_VISUALIZER_CSS;
  document.head.appendChild(style);
  stylesInjected = true;
}

import type { AudioVisualizerOptions } from '../types/config';

export class AudioVisualizer {
  private container: HTMLElement;
  private bars: HTMLElement[] = [];
  private numBands: number;
  private animationFrameId: number | null = null;
  private lastUpdateTime: number = 0;
  private currentLevels: number[] = [];
  private targetLevels: number[] = [];
  private options: AudioVisualizerOptions;

  /**
   * Create a new audio visualizer
   * @param containerOrOptions - Either the HTML container element or options object with elementId
   * @param numBandsOrOptions - Either the number of bands or full options object
   */
  constructor(
    containerOrOptions: HTMLElement | AudioVisualizerOptions,
    numBandsOrOptions?: number | AudioVisualizerOptions,
  ) {
    // Inject CSS styles automatically
    injectStyles();
    
    // Initialize with default options
    this.options = { ...DEFAULT_AUDIO_VISUALIZER_OPTIONS };

    // Process constructor arguments
    if (containerOrOptions instanceof HTMLElement) {
      // First argument is a DOM element
      this.container = containerOrOptions;

      // Second argument could be either number or options
      if (typeof numBandsOrOptions === 'number') {
        this.options.numBands = numBandsOrOptions;
      } else if (numBandsOrOptions) {
        this.options = { ...this.options, ...numBandsOrOptions };
      }
    } else {
      // First argument is options object
      this.options = { ...this.options, ...containerOrOptions };

      // Find or create the container
      if (this.options.elementId) {
        const element = document.getElementById(this.options.elementId);
        if (element) {
          this.container = element;
        } else if (this.options.autoCreate) {
          // Auto-create the container if requested
          this.container = document.createElement('div');
          this.container.id = this.options.elementId;
          document.body.appendChild(this.container);
        } else {
          throw new Error(`AudioVisualizer: Element with ID '${this.options.elementId}' not found`);
        }
      } else {
        throw new Error('AudioVisualizer: Either container element or elementId is required');
      }
    }

    this.numBands = this.options.numBands || 5;

    // Add visualizer class to container
    this.container.classList.add(this.options.containerClass || 'audio-visualizer');

    // Create the bars
    this.createBars();

    // Initialize with zero levels
    this.currentLevels = new Array(this.numBands).fill(0);
    this.targetLevels = new Array(this.numBands).fill(0);

    /*if (this.options.debug) {
      console.log(`[VoiceClient Event] AudioVisualizer Created with ${this.numBands} bands`);
    }*/
  }

  /**
   * Create the equalizer bars
   */
  private createBars() {
    // Clear any existing content
    this.container.innerHTML = '';
    this.bars = [];

    // Create the bars
    for (let i = 0; i < this.numBands; i++) {
      const bar = document.createElement('div');
      bar.className = this.options.barClass || 'equalizer-bar';
      this.container.appendChild(bar);
      this.bars.push(bar);

      /*if (this.options.debug && i === 0) {
        console.log(`[VoiceClient Event] AudioVisualizer Created bars with class "${bar.className}"`);
      }*/
    }
  }

  /**
   * Update the visualizer with new audio levels
   * @param levels - Array of values between 0-1 for each band
   */
  public updateLevels(levels: number[]) {
    // Apply sensitivity and minLevel, clamp to [0,1], and handle band count
    const sensitivity = this.options.sensitivity ?? 1;
    const minLevel = this.options.minLevel ?? 0;

    const bandCount = this.numBands;
    const out: number[] = new Array(bandCount).fill(minLevel);
    const n = Math.min(bandCount, levels.length);
    for (let i = 0; i < n; i++) {
      const scaled = Math.min(Math.max(levels[i] * sensitivity, 0), 1);
      // Lift by minLevel so bars never drop below it
      out[i] = minLevel + scaled * (1 - minLevel);
    }
    this.targetLevels = out;

    // Start animation if not running
    if (this.animationFrameId === null) {
      this.startAnimation();
    }
  }

  /**
   * Start the animation loop
   */
  private startAnimation() {
    const animate = () => {
      const now = performance.now();
      const elapsed = now - this.lastUpdateTime;

      // Update around 30fps for efficiency
      if (elapsed > 33) {
        this.lastUpdateTime = now;

        // Smoothly animate towards target values
        let needsUpdate = false;
        for (let i = 0; i < this.numBands; i++) {
          // Calculate the difference between current and target
          const diff = this.targetLevels[i] - this.currentLevels[i];

          // Apply easing - use smoothing factor from options
          const smoothing = this.options.smoothing || 0.3;
          if (Math.abs(diff) > 0.01) {
            this.currentLevels[i] += diff * smoothing;
            needsUpdate = true;
          } else {
            this.currentLevels[i] = this.targetLevels[i];
          }

          // Update the bar height
          const heightPercent = this.currentLevels[i] * 100;
          this.bars[i].style.height = `${heightPercent}%`;
        }

        // Stop animation if we've reached the target
        if (!needsUpdate) {
          cancelAnimationFrame(this.animationFrameId!);
          this.animationFrameId = null;
          return;
        }
      }

      this.animationFrameId = requestAnimationFrame(animate);
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }

  /**
   * Stop and cleanup the visualizer
   */
  public dispose() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
}

/**
 * Calculate audio levels from raw PCM data for equalizer visualization
 * @param audioData - Raw audio data as Uint8Array
 * @param bands - Number of bands/segments for the equalizer
 * @returns Array of normalized values (0-1) for each band
 */
export function calculateAudioLevels(
  audioData: Uint8Array,
  bands: number = 5,
  minLevel: number = 0.1,
): number[] {
  const result: number[] = new Array(bands).fill(0);
  const samplesPerBand = Math.floor(audioData.length / bands);

  // For each band, calculate average amplitude
  for (let i = 0; i < bands; i++) {
    let sum = 0;
    const offset = i * samplesPerBand;

    // Process samples for this band
    for (let j = 0; j < samplesPerBand && offset + j < audioData.length; j++) {
      // Convert to signed value and get absolute amplitude
      // Assuming audio is centered around 128 (8-bit PCM)
      const sample = audioData[offset + j];
      const amplitude = Math.abs(sample - 128);
      sum += amplitude;
    }

    // Calculate average and normalize to 0-1 range
    const average = sum / Math.min(samplesPerBand, audioData.length - offset);
    result[i] = Math.min(average / 128, 1);
  }

  // Apply some smoothing for more pleasing visualization
  for (let i = 0; i < bands; i++) {
    // Add minimum level so bars are always slightly visible
    result[i] = minLevel + result[i] * (1 - minLevel);
  }

  return result;
}
