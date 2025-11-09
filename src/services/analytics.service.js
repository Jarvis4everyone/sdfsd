/**
 * Analytics Service
 * 
 * Tracks and aggregates user activity, app usage, and performance metrics
 * for comprehensive monitoring and analytics.
 */

import { getMongoDB } from '../config/mongodb.config.js';
import postgresPool from '../config/postgres.config.js';

const getCollection = (collectionName) => {
  const db = getMongoDB();
  return db.collection(collectionName);
};

/**
 * Log user activity
 */
export const logActivity = async ({
  userId,
  activityType,
  activityData = {},
  ipAddress,
  deviceId,
}) => {
  try {
    const collection = getCollection('activity_logs');
    const now = new Date();

    await collection.insertOne({
      userId,
      activityType, // message_sent, call_initiated, call_answered, profile_updated, etc.
      activityData,
      ipAddress,
      deviceId,
      createdAt: now,
    });

    // Update user's last_activity_at in PostgreSQL
    await postgresPool.query(
      'UPDATE users SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1',
      [userId]
    );
  } catch (error) {
    console.error('Error logging activity:', error);
    // Don't throw - analytics failures shouldn't break the app
  }
};

/**
 * Get user activity summary
 */
export const getUserActivitySummary = async (userId, days = 30) => {
  try {
    const collection = getCollection('activity_logs');
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const pipeline = [
      {
        $match: {
          userId,
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: '$activityType',
          count: { $sum: 1 },
          lastActivity: { $max: '$createdAt' },
        },
      },
      {
        $sort: { count: -1 },
      },
    ];

    const results = await collection.aggregate(pipeline).toArray();

    return results.map((result) => ({
      activityType: result._id,
      count: result.count,
      lastActivity: result.lastActivity,
    }));
  } catch (error) {
    console.error('Error getting activity summary:', error);
    return [];
  }
};

/**
 * Get daily activity statistics
 */
export const getDailyActivityStats = async (date = new Date()) => {
  try {
    const collection = getCollection('activity_logs');
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const pipeline = [
      {
        $match: {
          createdAt: {
            $gte: startOfDay,
            $lte: endOfDay,
          },
        },
      },
      {
        $group: {
          _id: '$activityType',
          count: { $sum: 1 },
          uniqueUsers: { $addToSet: '$userId' },
        },
      },
      {
        $project: {
          activityType: '$_id',
          count: 1,
          uniqueUsers: { $size: '$uniqueUsers' },
        },
      },
      {
        $sort: { count: -1 },
      },
    ];

    const results = await collection.aggregate(pipeline).toArray();

    return {
      date: startOfDay.toISOString().split('T')[0],
      activities: results,
      totalActivities: results.reduce((sum, r) => sum + r.count, 0),
      totalUniqueUsers: new Set(
        results.flatMap((r) => r.uniqueUsers)
      ).size,
    };
  } catch (error) {
    console.error('Error getting daily stats:', error);
    return null;
  }
};

/**
 * Store aggregated analytics
 */
export const storeAnalytics = async ({
  metricType,
  date,
  value,
  metadata = {},
  userId = null,
}) => {
  try {
    const collection = getCollection('analytics');
    const dateStr = date instanceof Date 
      ? date.toISOString().split('T')[0] 
      : date;

    await collection.updateOne(
      {
        metricType,
        date: dateStr,
        ...(userId && { userId }),
      },
      {
        $set: {
          metricType,
          date: dateStr,
          value,
          metadata,
          ...(userId && { userId }),
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error storing analytics:', error);
  }
};

/**
 * Get analytics for a date range
 */
export const getAnalytics = async ({
  metricType,
  startDate,
  endDate,
  userId = null,
}) => {
  try {
    const collection = getCollection('analytics');

    const query = {
      metricType,
      date: {
        $gte: startDate instanceof Date 
          ? startDate.toISOString().split('T')[0] 
          : startDate,
        $lte: endDate instanceof Date 
          ? endDate.toISOString().split('T')[0] 
          : endDate,
      },
    };

    if (userId) {
      query.userId = userId;
    }

    const results = await collection
      .find(query)
      .sort({ date: 1 })
      .toArray();

    return results;
  } catch (error) {
    console.error('Error getting analytics:', error);
    return [];
  }
};

/**
 * Track call quality metrics
 */
export const trackCallQuality = async (roomId, metrics) => {
  try {
    const callsCollection = getCollection('calls');
    
    await callsCollection.updateOne(
      { roomId },
      {
        $set: {
          'analytics.quality': metrics.quality || 'unknown',
          'analytics.avgBitrate': metrics.avgBitrate,
          'analytics.avgPacketLoss': metrics.avgPacketLoss,
          'analytics.avgRTT': metrics.avgRTT,
          'analytics.updatedAt': new Date(),
        },
      }
    );
  } catch (error) {
    console.error('Error tracking call quality:', error);
  }
};

