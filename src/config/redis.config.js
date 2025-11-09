import { createClient } from 'redis';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// Get current directory (ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from backend directory or parent
const envPaths = [
  join(__dirname, '..', '..', '.env'),  // backend/.env
  join(__dirname, '..', '..', '..', '.env'),  // root/.env
  '.env',
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

/**
 * Redis Connection Configuration
 * Used for: Online/Offline Presence, Caching, Unread Counts, Temporary Session Data
 */
// Build Redis URL - prioritize REDIS_URL, fallback to individual params
let redisUrl = process.env.REDIS_URL;

// Clean up the URL - remove any quotes, whitespace, or variable name if accidentally included
if (redisUrl) {
  redisUrl = redisUrl.trim();
  // Remove quotes if present
  redisUrl = redisUrl.replace(/^["']|["']$/g, '');
  // If somehow the variable name got included, extract just the value
  if (redisUrl.startsWith('REDIS_URL=')) {
    redisUrl = redisUrl.substring('REDIS_URL='.length).trim();
    redisUrl = redisUrl.replace(/^["']|["']$/g, '');
  }
}

if (!redisUrl) {
  // Construct from individual parameters
  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD;
  
  if (password) {
    redisUrl = `redis://:${encodeURIComponent(password)}@${host}:${port}`;
  } else {
    redisUrl = `redis://${host}:${port}`;
  }
}

const redisConfig = {
  url: redisUrl,
  socket: {
    connectTimeout: 10000, // 10 seconds for cloud connections
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('Redis: Too many reconnection attempts');
        return new Error('Too many retries');
      }
      return Math.min(retries * 100, 3000);
    },
  },
};

let redisClient = null;

/**
 * Initialize Redis connection
 */
export const connectRedis = async () => {
  try {
    if (!redisClient) {
      redisClient = createClient(redisConfig);

      redisClient.on('error', (err) => {
        // Only log errors, don't spam console
        if (!err.message.includes('ECONNREFUSED') || !redisClient?.isOpen) {
          console.error('Redis Client Error:', err.message);
        }
      });

      redisClient.on('connect', () => {
        console.log('🔄 Redis connecting...');
      });

      redisClient.on('ready', () => {
        console.log('✅ Redis connected successfully');
      });

      redisClient.on('reconnecting', () => {
        // Suppress reconnecting messages to reduce noise
      });

      await redisClient.connect();
      return redisClient;
    }
    return redisClient;
  } catch (error) {
    console.error('❌ Redis connection error:', error.message);
    if (error.message.includes('ECONNREFUSED')) {
      console.error('   💡 Tip: Check if REDIS_URL is set correctly (not pointing to localhost)');
      console.error(`   Current URL: ${redisUrl.replace(/:[^:@]+@/, ':****@')}`); // Hide password
    } else if (error.message.includes('WRONGPASS') || error.message.includes('AUTH')) {
      console.error('   💡 Tip: Check your REDIS_PASSWORD');
    }
    throw error;
  }
};

/**
 * Get Redis client instance
 */
export const getRedisClient = () => {
  if (!redisClient) {
    throw new Error('Redis not connected. Call connectRedis() first.');
  }
  return redisClient;
};

/**
 * Close Redis connection
 */
export const closeRedis = async () => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    console.log('Redis connection closed');
  }
};

export default { connectRedis, getRedisClient, closeRedis };

