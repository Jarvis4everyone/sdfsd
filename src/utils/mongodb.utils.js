import { getMongoDB } from '../config/mongodb.config.js';
import { ObjectId } from 'mongodb';

/**
 * Validate MongoDB ObjectId format early
 */
export const validateObjectId = (id, fieldName = 'ID') => {
  if (!id) {
    throw new Error(`${fieldName} is required`);
  }
  
  if (typeof id !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  
  // Validate ObjectId format (24 hex characters)
  const objectIdPattern = /^[0-9a-fA-F]{24}$/;
  if (!objectIdPattern.test(id)) {
    throw new Error(`Invalid ${fieldName} format`);
  }
  
  try {
    return new ObjectId(id);
  } catch (error) {
    throw new Error(`Invalid ${fieldName}: ${error.message}`);
  }
};

/**
 * Execute MongoDB operations with transaction support
 * Note: MongoDB transactions require replica set
 */
export const executeWithTransaction = async (operations) => {
  const mongoDb = getMongoDB();
  const client = mongoDb.client;
  const session = client.startSession();
  
  try {
    session.startTransaction();
    
    const results = await operations(session);
    
    await session.commitTransaction();
    return results;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Safe MongoDB operation with error handling
 */
export const safeMongoOperation = async (operation, defaultValue = null) => {
  try {
    return await operation();
  } catch (error) {
    console.error('MongoDB operation error:', error.message);
    throw error; // Re-throw for proper error handling upstream
  }
};

