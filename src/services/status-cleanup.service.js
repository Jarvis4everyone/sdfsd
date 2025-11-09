import { getMongoDB } from '../config/mongodb.config.js';
import { deleteFile } from '../middleware/upload.middleware.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Delete expired statuses (older than 24 hours)
 * This should be called periodically (e.g., every hour via cron or scheduled task)
 */
export const deleteExpiredStatuses = async () => {
  try {
    const mongoDb = getMongoDB();
    const statusCollection = mongoDb.collection('status');

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Optimize: Only fetch documents that were updated in the last 25 hours
    // This reduces the number of documents to process
    const twentyFiveHoursAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const allStatuses = await statusCollection
      .find({
        updatedAt: { $gte: twentyFiveHoursAgo },
      })
      .toArray();

    let deletedCount = 0;
    let filesDeleted = 0;

    for (const statusDoc of allStatuses) {
      if (!statusDoc.statuses || statusDoc.statuses.length === 0) {
        // Delete empty status documents
        await statusCollection.deleteOne({ _id: statusDoc._id });
        deletedCount++;
        continue;
      }

      // Filter out expired statuses
      const validStatuses = [];
      const expiredStatuses = [];

      for (const statusItem of statusDoc.statuses) {
        const statusTime = new Date(statusItem.timestamp);
        if (statusTime < twentyFourHoursAgo) {
          expiredStatuses.push(statusItem);
        } else {
          validStatuses.push(statusItem);
        }
      }

      // Delete files for expired statuses with retry mechanism
      for (const expiredStatus of expiredStatuses) {
        if (expiredStatus.url) {
          // Extract filename from URL
          const filename = expiredStatus.url.split('/').pop();
          if (filename) {
            let fileDeleted = false;
            let retryCount = 0;
            const maxRetries = 3;
            
            // Retry file deletion with exponential backoff
            while (!fileDeleted && retryCount < maxRetries) {
              try {
                deleteFile(filename);
                fileDeleted = true;
                filesDeleted++;
              } catch (error) {
                retryCount++;
                console.error(`Error deleting file for status ${expiredStatus.id} (attempt ${retryCount}/${maxRetries}):`, error);
                
                if (retryCount < maxRetries) {
                  // Wait before retry (exponential backoff: 100ms, 200ms, 400ms)
                  await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retryCount - 1)));
                } else {
                  console.error(`Failed to delete file for status ${expiredStatus.id} after ${maxRetries} attempts. Continuing with cleanup.`);
                }
              }
            }
          }
        }
      }

      // Update document with only valid statuses
      if (expiredStatuses.length > 0) {
        if (validStatuses.length === 0) {
          // No valid statuses left, delete the entire document
          await statusCollection.deleteOne({ _id: statusDoc._id });
          deletedCount++;
        } else {
          // Update with remaining valid statuses
          await statusCollection.updateOne(
            { _id: statusDoc._id },
            {
              $set: {
                statuses: validStatuses,
                updatedAt: new Date(),
              },
            }
          );
        }
      }
    }

    console.log(`✅ Status cleanup completed: ${deletedCount} documents deleted/updated, ${filesDeleted} files deleted`);
    return {
      success: true,
      documentsProcessed: allStatuses.length,
      documentsDeleted: deletedCount,
      filesDeleted: filesDeleted,
    };
  } catch (error) {
    console.error('❌ Error cleaning up expired statuses:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Start periodic cleanup (runs every 6 hours for better efficiency)
 */
export const startStatusCleanupScheduler = () => {
  // Run immediately on start
  deleteExpiredStatuses();

  // Then run every 6 hours (more efficient than every hour)
  setInterval(() => {
    deleteExpiredStatuses();
  }, 6 * 60 * 60 * 1000); // 6 hours in milliseconds

  console.log('✅ Status cleanup scheduler started (runs every 6 hours)');
};

