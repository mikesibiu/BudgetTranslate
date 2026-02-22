# GTranslate V4 - Real-time Speech Translation

Real-time speech translation web application using Google Cloud Speech-to-Text and Translation APIs. No timeout limitations, unlimited duration streaming.

## Features

- ✅ **Unlimited Duration** - No 5-minute timeout restrictions
- 🎤 **Multiple Audio Sources** - Microphone or system audio (tab/screen)
- 🌍 **Multi-language Support** - 10+ languages for speech recognition and translation
- ⚡ **Two Translation Modes**
  - **Talks Mode** - 8-second translation intervals (4s pause fallback)
  - **EarBuds Mode** - 8-second intervals (4s pause fallback) optimized for listening with TTS
- 📊 **Real-time Audio Monitoring** - Visual level meter and adjustable gain control
- 📥 **Session Export** - Download translations as JSON
- 🔒 **Production-Ready Security** - CSP headers, CORS protection, rate limiting
- 🐳 **Docker Support** - Containerized deployment ready

## Quick Start

### Prerequisites

1. **Node.js 14+** - [Download](https://nodejs.org/)
2. **Google Cloud Account** with Speech-to-Text and Translation APIs enabled
3. **Service Account Credentials** - See [SETUP.md](./SETUP.md)

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Place your Google Cloud credentials
# Save as: google-credentials.json

# 3. Start the server
npm start

# 4. Open browser
http://localhost:3003
```

## Project Structure

```
GtranslateV4/
├── server.js                  # Main server with Socket.IO
├── index.html                 # Web interface
├── audio-processor.js         # AudioWorklet processor
├── package.json               # Dependencies
├── docker-compose.yml         # Docker orchestration
├── google-credentials.json    # Google Cloud credentials (you create)
│
├── docker/                    # Docker files
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── DOCKER-DEPLOYMENT.md   # Full Docker guide
│   └── README.md
│
├── glossaries/                # Custom glossary files
│   └── *.csv                  # Term translations
├── build-glossary.js          # Glossary builder script
├── GLOSSARY-GUIDE.md          # Glossary documentation
│
├── documents/                 # PDF source files for glossaries
│   └── *.pdf
│
├── test/                      # Automated tests
│   ├── mode-switching.integration.test.js
│   └── translation-interval.test.js
│
├── archive/                   # Old versions (archived)
│   └── old-versions/
│
├── SETUP.md                   # Setup instructions
└── README.md                  # This file
```

## Technology Stack

### Backend
- **Node.js** - Server runtime
- **Express** - Web framework
- **Socket.IO** - Real-time WebSocket communication
- **@google-cloud/speech** - Speech-to-Text API client
- **@google-cloud/translate** - Translation API client
- **Winston** - Logging

### Frontend
- **Vanilla JavaScript** - No framework dependencies
- **Web Audio API** - Audio processing
- **AudioWorklet** - Modern audio processing (with ScriptProcessor fallback for Safari < 14.1)
- **Socket.IO Client** - Real-time communication

### DevOps
- **Docker** - Containerization
- **Docker Compose** - Multi-container orchestration
- **Mocha + Chai** - Testing framework

## Security Features

- ✅ Client-side input validation
- ✅ Server-side path traversal protection
- ✅ Audio data rate limiting (2MB/sec)
- ✅ Content Security Policy (CSP) headers
- ✅ Strengthened CORS with origin whitelist
- ✅ Maximum connection limits (global & per-IP)
- ✅ Session inactivity timeout (30 min default)
- ✅ Maximum auto-restart attempts (10)

## Docker Deployment

See [docker/DOCKER-DEPLOYMENT.md](./docker/DOCKER-DEPLOYMENT.md) for complete Docker deployment guide.

**Quick Docker Start:**

```bash
# 1. Ensure google-credentials.json is in project root
# 2. Start container
docker-compose up -d

# 3. View logs
docker-compose logs -f

# 4. Stop
docker-compose down
```

## Configuration

Environment variables (optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | Server port |
| `NODE_ENV` | `development` | Environment |
| `GOOGLE_APPLICATION_CREDENTIALS` | `./google-credentials.json` | Credentials path |
| `MAX_CONNECTIONS` | `50` | Max concurrent connections |
| `MAX_CONNECTIONS_PER_IP` | `5` | Max connections per IP |
| `INACTIVITY_TIMEOUT` | `1800000` | Session timeout (ms) |

## Custom Glossaries

Improve translation accuracy with custom glossaries. See [GLOSSARY-GUIDE.md](./GLOSSARY-GUIDE.md).

```bash
# Build glossaries from CSV files
node build-glossary.js
```

## Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
```

## Browser Compatibility

- ✅ **Chrome/Edge** - Full support with AudioWorklet
- ✅ **Firefox** - Full support with AudioWorklet
- ✅ **Safari 14.1+** - Full support with AudioWorklet
- ✅ **Safari < 14.1** - Automatic fallback to ScriptProcessor
- ✅ **Mobile browsers** - Microphone support only (no system audio)

## API Usage & Costs

This application uses Google Cloud APIs which incur costs:

- **Speech-to-Text API** - ~$0.006 per 15 seconds
- **Translation API** - ~$20 per 1M characters

**Estimate:** ~$0.50-2.00 per hour of continuous use (depending on speech density)

See [Google Cloud Pricing](https://cloud.google.com/pricing) for current rates.

## Troubleshooting

### No audio detected
1. Check browser microphone permissions
2. Verify audio source selection (Microphone vs System Audio)
3. Adjust gain control slider (1x-20x)
4. Check audio level meter for input

### WebSocket connection issues
1. Check firewall/proxy settings
2. Verify port 3003 is accessible
3. Check browser console for errors

### Translation errors
1. Verify Google Cloud credentials are valid
2. Check APIs are enabled in Google Cloud Console
3. Review server logs: `logs/gtranslate-v4.log`

### Docker issues
See [docker/DOCKER-DEPLOYMENT.md](./docker/DOCKER-DEPLOYMENT.md#troubleshooting)

## Development

```bash
# Install dependencies
npm install

# Start development server (auto-reload with nodemon)
npm run dev

# Run tests with watch mode
npm run test:watch
```

## Contributing

This is a personal project, but suggestions are welcome:

1. Check existing issues
2. Create feature branch
3. Test thoroughly
4. Submit pull request

## License

MIT License - See LICENSE file for details

## Support

For issues and questions:
- Check [SETUP.md](./SETUP.md) for setup instructions
- Check [GLOSSARY-GUIDE.md](./GLOSSARY-GUIDE.md) for glossary help
- Check [docker/DOCKER-DEPLOYMENT.md](./docker/DOCKER-DEPLOYMENT.md) for Docker issues
- Review logs in `logs/gtranslate-v4.log`

## Acknowledgments

- Google Cloud Platform for Speech-to-Text and Translation APIs
- Socket.IO for real-time communication
- The open-source community

---

**Version:** 4.0.0
**Last Updated:** October 2025
