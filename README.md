# Agent Sabai Voice SDK

A TypeScript library for real-time voice communication with AI agents, featuring audio visualization and avatar integration.

## Features

- 🎤 **Real-time Audio Streaming** - Capture and stream microphone audio with μ-law compression
- 🎵 **Audio Visualization** - Built-in equalizer-style audio visualizer with auto-injected CSS
- 🖥️ **Avatar Integration** - Support for HeyGen streaming avatars
- 🔧 **TypeScript Support** - Full type definitions included
- 🎯 **Event-Driven Architecture** - Comprehensive event system for voice call lifecycle
- 🔇 **Mute Controls** - Independent mic and audio muting capabilities

## Installation

### For Production Use

```bash
npm install @ground-creative/agent-sabai-voice-sdk
```

### For Local Development/Testing

If you're developing or testing this library locally, you can use npm link:

#### 1. In the library directory (this repo):

```bash
# Install dependencies and build
npm install
npm run build

# Create global symlink (requires sudo)
sudo npm link
```

#### 2. In your test application:

```bash
# Link to the local version
npm link @ground-creative/agent-sabai-voice-sdk

# Install peer dependencies
npm install alawmulaw pcm-player
```

#### 3. For HeyGen avatar support:

```bash
npm install https://github.com/ground-creative/StreamingAvatarSDK#video-encoding-param
```

### Unlinking (when done testing)

```bash
# In your test application
npm unlink @ground-creative/agent-sabai-voice-sdk

# Optionally remove global link
sudo npm unlink -g @ground-creative/agent-sabai-voice-sdk
```

## Quick Start

### Basic Audio-Only Setup

```typescript
import {
  VoiceClient,
  EVENT,
  type VoiceClientConfig,
} from "@ground-creative/agent-sabai-voice-sdk";

const config: VoiceClientConfig = {
  mode: "audio",
  debug: "events", // 'events' | 'components' | 'all' | false
  useAudioVisualizer: true,
  visualizer_config: {
    numBands: 6,
    elementId: "audioVisualizer",
  },
};

const client = new VoiceClient(config);

// Event listeners
client.on(EVENT.CALL_STARTED, (data) => {
  console.log("Call started:", data.streamSid);
});

client.on(EVENT.CALL_ENDED, (data) => {
  console.log("Call ended:", data);
});

client.on(EVENT.ERROR, (error) => {
  console.error("Voice client error:", error);
});

// Start a call
async function startCall() {
  try {
    await client.startCall("wss://your-websocket-server.com/ws");
  } catch (error) {
    console.error("Failed to start call:", error);
  }
}

// Stop the call
async function stopCall() {
  await client.stopCall();
}
```

### With Audio Visualizer

```html
<!-- Add this element to your HTML -->
<div id="audioVisualizer" style="width: 200px; height: 60px;"></div>
```

The CSS styles are automatically injected - no need to import CSS files!

### Video Mode with Avatar

```typescript
import {
  VoiceClient,
  getBestVideoCodec,
} from "@ground-creative/agent-sabai-voice-sdk";

const videoElement = document.getElementById("avatarVideo") as HTMLVideoElement;
const codec = getBestVideoCodec(true); // Auto-detect best codec

const config: VoiceClientConfig = {
  mode: "video",
  video_config: {
    videoElement,
    avatarName: "your-avatar-name",
    codec,
    // ... other avatar options
  },
};

const client = new VoiceClient(config);
```

## API Reference

### VoiceClient

#### Constructor

```typescript
new VoiceClient(config: VoiceClientConfig)
```

#### Methods

- `startCall(websocketUrl: string): Promise<void>` - Start a voice call
- `stopCall(): Promise<void>` - Stop the current call
- `abortCall(): Promise<void>` - Abort call startup
- `setMicMuted(muted: boolean): void` - Mute/unmute microphone
- `setAudioMuted(muted: boolean): void` - Mute/unmute audio playback

#### Properties

- `isRunning: boolean` - Whether call is active
- `isStarting: boolean` - Whether call is starting
- `isMicMuted: boolean` - Microphone mute state
- `isAudioMuted: boolean` - Audio playback mute state

### Events

```typescript
import { EVENT } from "@ground-creative/agent-sabai-voice-sdk";

// Call lifecycle
EVENT.CALL_STARTED;
EVENT.CALL_ENDED;
EVENT.CALL_ABORTED;

// Audio events
EVENT.MIC_STREAM_STARTED;
EVENT.MIC_STREAM_STOPPED;
EVENT.MIC_MUTED;
EVENT.AUDIO_MUTED;

// Data events
EVENT.MEDIA_RECEIVED;
EVENT.COMPLETION_MESSAGE;
EVENT.MARK_RECEIVED;
EVENT.MARK_SENT;

// Error events
EVENT.ERROR;
```

### Utility Functions

```typescript
import { getBestVideoCodec } from '@ground-creative/agent-sabai-voice-sdk';

// Auto-detect best video codec for current browser
const codec = getBestVideoCodec(debug?: boolean);
```

## Development

### Building

```bash
npm run build        # Build once
npm run dev          # Build in watch mode
```

### Project Structure

```
src/
├── core/           # Core components
│   ├── VoiceClient.ts      # Main client class
│   ├── AudioSender.ts      # Audio capture & streaming
│   ├── AudioPlayer.ts      # Audio playback
│   ├── AudioVisualizer.ts  # Visual audio feedback
│   └── events.ts           # Event constants
├── types/          # TypeScript definitions
├── utils/          # Utility functions
└── index.ts        # Main exports
```

## Browser Support

- Chrome/Chromium 66+
- Firefox 76+
- Safari 14+
- Edge 79+

Requires support for:

- WebRTC
- AudioWorklet
- MediaDevices.getUserMedia()

## License

MIT

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

For issues and questions, please open an issue on GitHub.
