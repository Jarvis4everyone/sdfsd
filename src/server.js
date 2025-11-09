import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { createServer } from 'http';
import initializeDatabases from './config/database.manager.js';
import { initializeSocket } from './socket/socket.server.js';

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());

// CORS configuration - handle multiple origins properly
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = process.env.CORS_ORIGIN 
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : ['*'];
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // If '*' is in allowed origins, allow all
    if (allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // For development, allow localhost with any port
      if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Axzora Chat Backend',
  });
});

// Import routes
import authRoutes from './routes/auth.routes.js';
import profileRoutes from './routes/profile.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import chatsRoutes from './routes/chats.routes.js';
import contactsRoutes from './routes/contacts.routes.js';
import messagesRoutes from './routes/messages.routes.js';
import adminRoutes from './routes/admin.routes.js';
import callsRoutes from './routes/calls.routes.js';
import statusRoutes from './routes/status.routes.js';
import blockRoutes from './routes/block.routes.js';

// API Routes
app.get('/api', (req, res) => {
  res.json({
    message: 'Axzora Chat API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      profile: '/api/profile',
      settings: '/api/settings',
      chats: '/api/chats',
      calls: '/api/calls',
    },
  });
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Register routes
app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/chats', chatsRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/block', blockRoutes);
app.use('/api/admin', adminRoutes);
// Register calls routes - must be after other routes to avoid conflicts
app.use('/api/calls', callsRoutes);
console.log('✅ Calls routes registered: /api/calls');
// Register status routes
app.use('/api/status', statusRoutes);
console.log('✅ Status routes registered: /api/status');

// Initialize databases and start server
const startServer = async () => {
  try {
    // Initialize all database connections
    await initializeDatabases();

    // Initialize Socket.IO
    initializeSocket(httpServer);
    console.log('✅ Socket.IO initialized');

    // Start status cleanup scheduler
    const { startStatusCleanupScheduler } = await import('./services/status-cleanup.service.js');
    startStatusCleanupScheduler();

    // Start HTTP server (with Socket.IO)
    httpServer.listen(PORT, () => {
      console.log(`\n🚀 Server running on port ${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   Health check: http://localhost:${PORT}/health`);
      console.log(`   WebSocket: ws://localhost:${PORT}\n`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;

