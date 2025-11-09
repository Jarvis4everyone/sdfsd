/**
 * Reset Redis Only
 * This script clears all data from Redis
 * Run with: node scripts/reset-redis.js
 */

import { getRedisClient, connectRedis } from '../src/config/redis.config.js';

async function resetRedis() {
  console.log('🔄 Resetting Redis...\n');

  try {
    await connectRedis();
    const redisClient = getRedisClient();
    
    // Get all keys
    const keys = await redisClient.keys('*');
    
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log(`✅ Redis reset complete!`);
      console.log(`📊 Deleted ${keys.length} keys\n`);
    } else {
      console.log('✅ Redis is already empty\n');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error resetting Redis:', error);
    process.exit(1);
  }
}

resetRedis();

