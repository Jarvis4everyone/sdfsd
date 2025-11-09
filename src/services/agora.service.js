import agoraToken from 'agora-token';
const { RtcTokenBuilder, RtcRole } = agoraToken;

/**
 * Generate Agora RTC token for voice/video calls
 * @param {string} channelName - The channel name (roomId)
 * @param {string} userId - The user ID (UID)
 * @param {number} role - RtcRole.PUBLISHER or RtcRole.SUBSCRIBER
 * @param {number} expirationTimeInSeconds - Token expiration time (default: 24 hours)
 * @returns {string} - The generated token
 */
export const generateRtcToken = (
  channelName,
  userId,
  role = RtcRole.PUBLISHER,
  expirationTimeInSeconds = 86400 // 24 hours
) => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    const errorMsg = 'Agora App ID and App Certificate must be configured. Please add AGORA_APP_ID and AGORA_APP_CERTIFICATE to your .env file. Get credentials from https://console.agora.io/';
    console.error('❌ Agora Configuration Error:', errorMsg);
    throw new Error(errorMsg);
  }

  // Convert userId to number (Agora requires numeric UID for token generation)
  // If userId is a UUID, we'll use a hash or convert to number
  const numericUid = convertUserIdToNumeric(userId);

  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    numericUid,
    role,
    privilegeExpiredTs
  );

  return token;
};

/**
 * Convert user ID (UUID) to numeric UID for Agora
 * Agora supports string UIDs in newer versions, but for token generation we need numeric
 * We'll use a simple hash function to convert UUID to number
 */
const convertUserIdToNumeric = (userId) => {
  if (typeof userId === 'number') {
    return userId;
  }

  // Simple hash function to convert string to number
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Ensure positive number and within Agora's UID range (1 to 2^32-1)
  return Math.abs(hash) % 2147483647 || 1;
};

/**
 * Generate Agora token for a call participant
 * @param {string} channelName - The channel name (roomId)
 * @param {string} userId - The user ID
 * @param {string} mediaType - 'audio' or 'video'
 * @returns {Object} - Token and channel info
 */
export const generateCallToken = (channelName, userId, mediaType = 'audio') => {
  try {
    // Ensure channelName is a string and not empty
    const validChannelName = channelName && typeof channelName === 'string' ? channelName : String(channelName || 'default');
    
    const token = generateRtcToken(validChannelName, userId, RtcRole.PUBLISHER);
    const numericUid = convertUserIdToNumeric(userId);

    return {
      token,
      channelName: validChannelName, // Return the validated channel name
      uid: numericUid,
      appId: process.env.AGORA_APP_ID,
      mediaType,
    };
  } catch (error) {
    console.error('Error generating Agora token:', error);
    throw error;
  }
};

