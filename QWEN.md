# Electron Audio Transcription Application

## Project Overview

This is an Electron application that provides real-time audio transcription functionality using various cloud-based speech recognition APIs. The application captures system audio using Electron's audio loopback feature and sends it to transcription services like Deepgram, AssemblyAI, Gladia, RevAI, and Speechmatics for real-time processing.

The project also integrates with the Recall AI SDK to provide alternative audio capture and transcription methods.

### Key Features
- Real-time audio transcription with multiple provider support
- Audio loopback capture from system audio
- Support for multiple transcription providers (Deepgram, AssemblyAI, Gladia, RevAI, Speechmatics, Google Gemini)
- Integration with Recall AI for enhanced transcription capabilities
- Simplified Chinese conversion for Chinese transcripts
- Cross-platform desktop application via Electron

### Architecture

The application consists of:
- **Main Process** (`index.js`): Handles Electron application lifecycle, IPC communication, and transcription session management
- **Renderer Process** (`render.js`): Manages audio capture via Web Audio API, UI interactions, and status updates
- **Preload Script** (`preload.js`): Provides secure IPC bridge between renderer and main process
- **Transcription Services** (`transcription/*.js`): Individual modules for each transcription provider
- **Utilities** (`utils.js`): Helper functions including Chinese text conversion

## Building and Running

### Prerequisites
- Node.js (v18 or higher)
- npm package manager

### Setup
1. Install dependencies: `npm install`
2. Set up environment variables by creating a `.env` file (copy from `.env.example`)
3. Add your API keys for the transcription services you want to use

### Running the Application
- Development: `npm start` or `electron .`

### Available Scripts
- `npm start`: Launch the Electron application
- `npm run fix`: Run Biome.js linter and formatter
- `npm run taze`: Update dependencies using taze
- `npm test`: Placeholder (no tests specified)

## Development Conventions

### Code Style
- Code formatting is managed by Biome.js
- Uses tab indentation
- Double quotes for strings
- ES modules are used throughout the project
- Modern JavaScript with async/await patterns

### Project Structure
```
transcript/
├── index.js          # Main Electron process
├── render.js         # Renderer process (UI and audio capture)
├── preload.js        # Secure IPC bridge
├── index.html        # Application UI
├── utils.js          # Utility functions
├── transcription/    # Transcription service implementations
│   ├── assembly.js
│   ├── deepgram.js
│   ├── gladia.js
│   ├── revai.js
│   └── speechmatics.js
├── .env.example      # Environment variable template
├── package.json      # Project dependencies and scripts
└── biorme.json       # Code formatting/linting configuration
```

### Transcription Providers
The application supports the following transcription services:

1. **Deepgram**: Online real-time speech recognition
2. **AssemblyAI**: Supports multiple languages including English, Spanish, French, German, Italian, Portuguese
3. **Gladia**: High-quality transcription service
4. **RevAI**: Professional transcription API
5. **Speechmatics**: Enterprise-grade speech recognition
6. **Google Gemini (@google/genai)**: Flush-based real-time transcription for Gemini models (defaults to `gemini-2.5-flash-lite`, with HTTP fallback that targets the proper API version automatically)

Each provider has its own implementation module in the `transcription/` directory.

### Audio Capture
System audio is captured via Electron's loopback integration.

### Environment Variables
The application requires API keys for the transcription services in use. See `.env.example` for the full list of supported environment variables.
For Google Gemini streaming specifically:
- `GOOGLE_GENAI_USE_LIVE=1` forces the new Live WebSocket session (auto-enabled for `*-live*` models).
- `GOOGLE_GENAI_LIVE_API_VERSION`/`GOOGLE_GENAI_LIVE_WS_BASE_URL` allow pointing at preview endpoints (defaults target `wss://generativelanguage.googleapis.com` and `v1alpha`).
- Classic REST chunking remains available by setting `GOOGLE_GENAI_USE_LIVE=0`.

### UI Components
The application features a clean, modern UI with:
- Status indicators for transcription connection status
- Real-time transcript display
- Final transcript display
- Provider selection dropdowns
- Start/Stop controls

## Key Dependencies

- `electron`: Cross-platform desktop app framework
- `electron-audio-loopback`: Audio loopback capture for Electron
- `@deepgram/sdk`: Deepgram speech recognition
- `assemblyai`: AssemblyAI speech recognition
- `@gladiaio/sdk`: Gladia AI SDK
- `@speechmatics/real-time-client`: Speechmatics real-time client
- `revai-node-sdk`: RevAI SDK
- `biomejs/biome`: Code formatting and linting
- `dotenv`: Environment variable management

## Security Considerations

- Uses context isolation and secure IPC bridge via `contextBridge`
- Implements Content Security Policy in `index.html`
- Sanitizes and validates user input
- Proper handling of sensitive API keys through environment variables
