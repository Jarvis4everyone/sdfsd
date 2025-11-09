/**
 * Centralized utility for user presence (online/offline status)
 * Simple: Just use what's stored in the database
 * last_seen is ONLY updated on: connect, disconnect, heartbeat
 */

/**
 * Serialize date to ISO string for consistent API responses
 * CRITICAL: PostgreSQL returns timestamps without timezone as local time
 * We must explicitly treat them as UTC to avoid timezone conversion errors
 * @param {Date|string|null} dateValue - Date value to serialize
 * @returns {string|null} - ISO string or null
 */
function serializeDate(dateValue) {
  if (!dateValue) return null;
  
  if (dateValue instanceof Date) {
    // CRITICAL FIX: If the Date was created from a timestamp without timezone,
    // it might be interpreted as local time. We need to ensure it's treated as UTC.
    // The issue: PostgreSQL returns (last_seen AT TIME ZONE 'UTC')::timestamp
    // which is a timestamp WITHOUT timezone. Node.js pg library interprets this
    // as local time (IST), not UTC. We need to correct this.
    
    // Get the UTC components directly to avoid timezone conversion
    const utcYear = dateValue.getUTCFullYear();
    const utcMonth = dateValue.getUTCMonth();
    const utcDate = dateValue.getUTCDate();
    const utcHours = dateValue.getUTCHours();
    const utcMinutes = dateValue.getUTCMinutes();
    const utcSeconds = dateValue.getUTCSeconds();
    const utcMilliseconds = dateValue.getUTCMilliseconds();
    
    // Create a new Date object explicitly in UTC
    const utcDateObj = new Date(Date.UTC(utcYear, utcMonth, utcDate, utcHours, utcMinutes, utcSeconds, utcMilliseconds));
    
    return utcDateObj.toISOString();
  }
  
  if (typeof dateValue === 'string') {
    // If already a string, try to parse and re-serialize to ensure consistency
    try {
      // Parse as UTC explicitly
      const parsed = new Date(dateValue);
      if (isNaN(parsed.getTime())) {
        return dateValue; // Return as-is if invalid
      }
      return parsed.toISOString();
    } catch (e) {
      return dateValue; // Return as-is if parsing fails
    }
  }
  
  return null;
}

/**
 * Get user presence data from database
 * Simply returns what's in the database - no complex calculations
 * @param {Object} user - User object from database
 * @returns {Object} - User presence data with properly serialized dates
 */
export function getUserPresenceData(user) {
  if (!user) return null;
  
  // Simple: User is online if is_online flag is true AND last_seen is within 5 minutes
  let isActuallyOnline = false;
  if (user.is_online && user.last_seen) {
    const lastSeenDate = user.last_seen instanceof Date ? user.last_seen : new Date(user.last_seen);
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    isActuallyOnline = lastSeenDate > fiveMinutesAgo;
  }
  
  return {
    id: user.id,
    fullName: user.full_name,
    phoneNumber: user.phone_number,
    countryCode: user.country_code,
    bio: user.bio,
    profilePictureUrl: user.profile_picture_url,
    isOnline: isActuallyOnline,
    lastSeen: serializeDate(user.last_seen), // Serialize to ISO string for consistency
    timezone: user.timezone,
  };
}

/**
 * Prepare presence data for Socket.IO broadcast
 * Ensures all dates are properly serialized as ISO strings
 * @param {Object} userPresenceData - User presence data from getUserPresenceData
 * @returns {Object} - Presence data ready for Socket.IO emission
 */
export function preparePresenceForBroadcast(userPresenceData) {
  if (!userPresenceData) return null;
  
  return {
    userId: userPresenceData.id,
    isOnline: userPresenceData.isOnline,
    lastSeen: userPresenceData.lastSeen, // Already serialized by getUserPresenceData
    fullName: userPresenceData.fullName,
    profilePictureUrl: userPresenceData.profilePictureUrl,
  };
}
