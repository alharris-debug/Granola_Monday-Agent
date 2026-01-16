# AI Excellence

Tools and automation for building an AI Center of Excellence.

## Projects

### 1. AI CoE Implementation Wizard (`index.html`)
An interactive web wizard that helps leadership teams assess their AI maturity and get customized recommendations for building an AI governance structure.

### 2. Granola → Monday.com Agent (`server.js`, `meeting-processor.html`)
An AI-powered automation that extracts action items from Granola meeting notes and creates tasks in Monday.com.

## Getting Started (Granola → Monday Agent)

### Prerequisites
- Node.js 18+
- Anthropic API key
- Monday.com API token

### Setup

1. Install dependencies:
```bash
npm install
```

2. Copy environment template and add your credentials:
```bash
cp .env.example .env
```

Edit `.env` with:
- `ANTHROPIC_API_KEY` - Get from https://console.anthropic.com/
- `MONDAY_API_TOKEN` - Get from https://monday.com/developers/apps
- `MONDAY_DEFAULT_BOARD_ID` - (Optional) Default board for task creation

3. Start the server:
```bash
npm start
```

4. Open http://localhost:3000 in your browser

### Usage

1. Paste your Granola meeting notes into the text area
2. Click "Extract Action Items" - Claude will analyze and extract tasks
3. Review the extracted items and select which ones to create
4. Choose your Monday.com board and group
5. Click "Create Tasks" to add them to Monday.com

### API Endpoints

- `GET /api/health` - Health check
- `GET /api/boards` - List Monday.com boards
- `GET /api/users` - List Monday.com users
- `POST /api/extract` - Extract action items from meeting notes
- `POST /api/create-tasks` - Create tasks in Monday.com
- `POST /api/process-meeting` - Full pipeline (extract + create)

## Architecture

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Web UI        │ ──▶  │   Node Server   │ ──▶  │   Claude API    │
│ (paste notes)   │      │   (Express)     │      │ (extraction)    │
└─────────────────┘      └────────┬────────┘      └─────────────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │  Monday.com API │
                         │ (create tasks)  │
                         └─────────────────┘
```
