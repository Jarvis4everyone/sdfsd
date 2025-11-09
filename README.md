# Axzora Chat Backend

Backend API for Axzora Chat - Hybrid Database Architecture

## Production Server

**Production URL:** https://server-i81g.onrender.com

## Features

- Real-time messaging with Socket.IO
- Hybrid database architecture (PostgreSQL, MongoDB, Redis)
- User authentication and authorization
- File uploads and media handling
- Voice and video calling support
- Status updates
- Contact management
- Block/unblock functionality

## API Endpoints

- Health Check: `/health`
- Authentication: `/api/auth`
- Profile: `/api/profile`
- Settings: `/api/settings`
- Chats: `/api/chats`
- Contacts: `/api/contacts`
- Messages: `/api/messages`
- Calls: `/api/calls`
- Status: `/api/status`
- Admin: `/api/admin`

## Environment Variables

See `env.example` for required environment variables.

**Important URLs:**
- `PRODUCTION_URL`: Production server URL (default: https://server-i81g.onrender.com)
- `BASE_URL`: Base URL for file uploads and API endpoints (default: https://server-i81g.onrender.com)
- `FRONTEND_URL`: Frontend application URL for invite links

## Installation

```bash
npm install
```

## Running the Server

```bash
# Development
npm run dev

# Production
npm start
```

## Docker

```bash
docker build -t axzora-chat-backend .
docker run -p 3000:3000 axzora-chat-backend
```

## License

ISC

