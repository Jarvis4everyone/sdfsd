import { getMongoDB } from '../config/mongodb.config.js';

// Get call sessions collection
const getCallCollection = () => {
  const mongoDb = getMongoDB();
  return mongoDb.collection('calls');
};

// Get call session by roomId
export const getCallSessionByRoom = async (roomId) => {
  const collection = getCallCollection();
  return await collection.findOne({ roomId });
};

// Create a new call session
export const createCallSession = async ({ roomId, initiatorId, participants, mediaType, signalPayload, metadata }) => {
  const collection = getCallCollection();
  const now = new Date();

  const session = {
    roomId,
    initiatorId,
    participants: participants || [],
    mediaType: mediaType || 'audio',
    status: 'ringing',
    signalPayload: signalPayload || null,
    metadata: metadata || null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    endReason: null,
    endedBy: null,
    events: [],
  };

  const result = await collection.insertOne(session);
  return { ...session, _id: result.insertedId };
};

// Update call session
export const updateCallSession = async (roomId, updates) => {
  const collection = getCallCollection();
  const result = await collection.findOneAndUpdate(
    { roomId },
    {
      $set: {
        ...updates,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );
  return result?.value || null;
};

// Append event to call session
export const appendCallEvent = async (roomId, event) => {
  const collection = getCallCollection();
  await collection.updateOne(
    { roomId },
    {
      $push: {
        events: {
          ...event,
          timestamp: new Date(),
        },
      },
    }
  );
};

// Mark participant state in call session
export const markParticipantState = async (roomId, userId, state) => {
  const collection = getCallCollection();
  const { value } = await collection.findOneAndUpdate(
    { roomId, 'participants.userId': userId },
    {
      $set: {
        'participants.$.state': state,
        'participants.$.updatedAt': new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  return value;
};

export const endCallSession = async ({ roomId, reason, endedBy }) => {
  const collection = getCallCollection();
  const now = new Date();

  // Get session first to determine final status
  const session = await collection.findOne({ roomId });
  if (!session) {
    console.log(`⚠️  Call session not found for roomId: ${roomId}`);
    return null;
  }

  // Determine final call status based on participant states
  const participants = session.participants || [];
  const hasAnswered = participants.some(p => p.state === 'answered');
  const allDeclined = participants.every(p => 
    p.userId === session.initiatorId || ['declined', 'ended'].includes(p.state)
  );
  const hasRejected = participants.some(p => p.state === 'declined');
  const hasMissed = !hasAnswered && reason !== 'declined' && !allDeclined && !hasRejected;

  // Determine final status - prioritize answered over missed
  let finalStatus = 'ended';
  if (hasAnswered) {
    finalStatus = 'answered';
  } else if (hasRejected || reason === 'declined') {
    finalStatus = 'rejected';
  } else if (hasMissed) {
    finalStatus = 'missed';
  }

  console.log(`📞 Call status determination: roomId=${roomId}, hasAnswered=${hasAnswered}, hasRejected=${hasRejected}, hasMissed=${hasMissed}, finalStatus=${finalStatus}`);

  const result = await collection.findOneAndUpdate(
    { roomId },
    {
      $set: {
        status: finalStatus,
        endedAt: now,
        endReason: reason,
        endedBy,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' }
  );

  return result?.value || null;
};

// Mark call as missed for participants who didn't answer
export const markCallAsMissed = async (roomId, userId) => {
  const collection = getCallCollection();
  await collection.updateOne(
    { roomId, 'participants.userId': userId },
    {
      $set: {
        'participants.$.state': 'missed',
        'participants.$.updatedAt': new Date(),
        updatedAt: new Date(),
      },
    }
  );
};

// Get user's call history
export const getUserCallHistory = async ({ userId, limit, before }) => {
  const collection = getCallCollection();
  
  // Build query - find all calls where user is a participant
  const query = {
    $or: [
      { 'participants.userId': userId },
      { 'participants': userId }, // Handle both object and string formats
    ],
    status: { $in: ['answered', 'missed', 'rejected', 'ended'] }, // Only ended calls
  };
  
  // Add before cursor if provided
  if (before) {
    try {
      const beforeDate = new Date(before);
      if (!isNaN(beforeDate.getTime())) {
        query.updatedAt = { $lt: beforeDate };
      }
    } catch (error) {
      console.warn('Invalid before date:', before);
    }
  }
  
  // Build find options
  const findOptions = {
    sort: { updatedAt: -1 }, // Most recent first
  };
  
  if (limit) {
    findOptions.limit = Math.min(limit, 100); // Max 100 calls per request
  }
  
  const calls = await collection.find(query, findOptions).toArray();
  return calls;
};

// Format call duration for display
const formatCallDuration = (seconds) => {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

// Create call history message in chat for ALL participants
export const createCallHistoryMessage = async (session, callStatus, currentUserId, socketIO = null) => {
  try {
    console.log(`📞 [CallService] createCallHistoryMessage called: roomId=${session?.roomId}, callStatus=${callStatus}, currentUserId=${currentUserId}, hasSocketIO=${!!socketIO}`);
    
    if (!session) {
      console.error('❌ Cannot create call history: session is null or undefined');
      return null;
    }
    
    if (!session.roomId) {
      console.error('❌ Cannot create call history: session.roomId is missing');
      return null;
    }
    
    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');
    const messagesCollection = mongoDb.collection('messages');

    // Find or create chat between participants
    const participants = session.participants || [];
    const participantIds = participants.map(p => {
      if (typeof p === 'string') return p;
      return p?.userId || p;
    }).filter(Boolean);
    
    if (participantIds.length < 2) {
      console.log(`⚠️  Cannot create call history: insufficient participants (${participantIds.length})`);
      return null;
    }

    console.log(`📞 [CallService] Participants: ${participantIds.join(', ')}`);

    // Check if this is a group call (has chatId in metadata)
    const isGroupCall = session.metadata && session.metadata.chatId;
    let chat;

    if (isGroupCall) {
      // For group calls, find the group chat by chatId
      const { ObjectId } = await import('mongodb');
      let chatObjectId;
      try {
        chatObjectId = new ObjectId(session.metadata.chatId);
      } catch (error) {
        console.error(`❌ Invalid chatId in metadata: ${session.metadata.chatId}`);
        return null;
      }

      chat = await chatsCollection.findOne({
        _id: chatObjectId,
        type: 'group',
      });

      if (!chat) {
        console.error(`❌ Group chat not found: ${session.metadata.chatId}`);
        return null;
      }

      console.log(`📞 [CallService] Found group chat: ${chat._id.toString()}, groupName: ${chat.groupName || 'Unknown'}`);
    } else {
      // For direct calls, find existing chat
      chat = await chatsCollection.findOne({
        participants: { $all: participantIds },
        type: 'direct',
      });

      if (!chat) {
        // Create new chat if doesn't exist
        const newChat = {
          participants: participantIds,
          type: 'direct',
          lastMessage: null,
          lastMessageType: null,
          lastMessageAt: new Date(),
          archivedBy: [],
          pinnedBy: [],
          mutedBy: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const chatResult = await chatsCollection.insertOne(newChat);
        chat = { ...newChat, _id: chatResult.insertedId };
        console.log(`📞 [CallService] Created new chat: ${chat._id.toString()}`);
      }
    }

    // Determine call message text
    const mediaTypeText = (session.mediaType === 'video') ? 'video' : 'voice';
    const sessionCreatedAt = session.createdAt ? new Date(session.createdAt) : new Date();
    const sessionEndedAt = session.endedAt ? new Date(session.endedAt) : new Date();
    const duration = sessionEndedAt && sessionCreatedAt
      ? Math.floor((sessionEndedAt - sessionCreatedAt) / 1000)
      : null;
    const durationText = duration != null ? formatCallDuration(duration) : '';
    
    // For group calls, show "Conference call" instead of just "call"
    const callTypeText = isGroupCall ? 'Conference call' : 'call';
    
    let callMessage = '';
    if (callStatus === 'missed') {
      callMessage = `Missed ${mediaTypeText} ${callTypeText}`;
    } else if (callStatus === 'answered') {
      callMessage = `${mediaTypeText} ${callTypeText}${durationText ? ` • ${durationText}` : ''}`;
    } else if (callStatus === 'rejected') {
      callMessage = `${mediaTypeText} ${callTypeText}`;
    } else {
      callMessage = `${mediaTypeText} ${callTypeText}`;
    }

    // Determine sender ID
    const initiator = participantIds.find(id => id === session.initiatorId);
    let messageSenderId;
    if (callStatus === 'rejected') {
      messageSenderId = currentUserId;
    } else {
      messageSenderId = initiator || currentUserId || participantIds[0];
    }

    const now = new Date();
    const callId = session._id 
      ? (typeof session._id === 'object' && session._id.toString ? session._id.toString() : String(session._id))
      : (session.id || null);
    
    const callMessageData = {
      chatId: chat._id,
      senderId: messageSenderId,
      message: callMessage,
      messageType: 'call',
      callData: {
        roomId: session.roomId,
        callId: callId,
        mediaType: session.mediaType || 'audio',
        status: callStatus,
        duration: duration,
        initiatorId: session.initiatorId,
        createdAt: sessionCreatedAt,
        endedAt: sessionEndedAt,
      },
      readBy: participantIds,
      readReceipts: participantIds.map(pid => ({
        userId: pid,
        readAt: now,
      })),
      editedAt: null,
      deletedAt: null,
      createdAt: sessionEndedAt || sessionCreatedAt || now,
      updatedAt: now,
    };

    // Check if message already exists
    const existingCallMessage = await messagesCollection.findOne({
      chatId: chat._id,
      messageType: 'call',
      'callData.roomId': session.roomId,
    });

    let insertedMessage;
    if (existingCallMessage) {
      console.log(`⚠️  [CallService] Call history message already exists for roomId=${session.roomId}, using existing`);
      insertedMessage = existingCallMessage;
    } else {
      // Insert new message
      try {
        const insertResult = await messagesCollection.insertOne(callMessageData);
        insertedMessage = { ...callMessageData, _id: insertResult.insertedId };
        console.log(`✅ [CallService] Created new call history message for roomId=${session.roomId}`);
      } catch (error) {
        if (error.code === 11000) {
          // Duplicate key - find existing
          const existing = await messagesCollection.findOne({
            chatId: chat._id,
            messageType: 'call',
            'callData.roomId': session.roomId,
          });
          if (existing) {
            insertedMessage = existing;
            console.log(`⚠️  [CallService] Found existing message after duplicate key error`);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }
    
    if (!insertedMessage) {
      console.error(`❌ [CallService] Failed to create or retrieve message for roomId=${session.roomId}`);
      return null;
    }

    // ALWAYS update chat - this is the critical part
    const callMessageAt = insertedMessage.createdAt instanceof Date 
      ? insertedMessage.createdAt 
      : new Date(insertedMessage.createdAt);
    
    const updateResult = await chatsCollection.updateOne(
      { _id: chat._id },
      {
        $set: {
          lastMessage: callMessage,
          lastMessageType: 'call',
          lastMessageAt: callMessageAt,
          updatedAt: new Date(),
        },
      }
    );
    
    console.log(`📞 [CallService] Updated chat ${chat._id.toString()}: lastMessage="${callMessage}", lastMessageType="call", matchedCount=${updateResult.matchedCount}, modifiedCount=${updateResult.modifiedCount}`);

    // ALWAYS emit chat_updated event to update frontend
    if (socketIO) {
      const { getRedisClient } = await import('../config/redis.config.js');
      const redisClient = getRedisClient();
      
      for (const participantId of participantIds) {
        try {
          const unreadCountStr = await redisClient.get(`unread:${participantId}:${chat._id.toString()}`) || '0';
          const unreadCount = parseInt(unreadCountStr) || 0;
          
          const chatUpdateData = {
            chatId: chat._id.toString(),
            type: chat.type || 'direct',
            lastMessage: callMessage,
            lastMessageType: 'call',
            lastMessageAt: callMessageAt.toISOString(),
            unreadCount: unreadCount,
          };
          
          socketIO.to(`user:${participantId}`).emit('chat_updated', chatUpdateData);
          console.log(`📞 [CallService] ✅ Emitted chat_updated to user:${participantId} for chatId=${chat._id.toString()}, lastMessage="${callMessage}", lastMessageType="call"`);
        } catch (error) {
          console.error(`⚠️  [CallService] Error emitting chat_updated to user ${participantId}:`, error);
        }
      }
    }

    // Emit new_message event if this is a new message
    if (socketIO && !existingCallMessage) {
      const messageForSocket = {
        id: insertedMessage._id?.toString() || insertedMessage.id,
        chatId: chat._id.toString(),
        senderId: insertedMessage.senderId,
        message: insertedMessage.message,
        messageType: insertedMessage.messageType,
        callData: insertedMessage.callData ? {
          roomId: insertedMessage.callData.roomId,
          callId: insertedMessage.callData.callId,
          mediaType: insertedMessage.callData.mediaType,
          status: insertedMessage.callData.status,
          duration: insertedMessage.callData.duration,
          initiatorId: insertedMessage.callData.initiatorId,
          createdAt: insertedMessage.callData.createdAt?.toISOString?.() || (insertedMessage.callData.createdAt instanceof Date ? insertedMessage.callData.createdAt.toISOString() : insertedMessage.callData.createdAt),
          endedAt: insertedMessage.callData.endedAt?.toISOString?.() || (insertedMessage.callData.endedAt instanceof Date ? insertedMessage.callData.endedAt.toISOString() : insertedMessage.callData.endedAt),
        } : null,
        readBy: insertedMessage.readBy || [],
        readReceipts: (insertedMessage.readReceipts || []).map(r => ({
          userId: r.userId,
          readAt: r.readAt?.toISOString?.() || (r.readAt instanceof Date ? r.readAt.toISOString() : r.readAt),
        })),
        editedAt: insertedMessage.editedAt?.toISOString?.() || (insertedMessage.editedAt instanceof Date ? insertedMessage.editedAt.toISOString() : insertedMessage.editedAt),
        deletedAt: insertedMessage.deletedAt?.toISOString?.() || (insertedMessage.deletedAt instanceof Date ? insertedMessage.deletedAt.toISOString() : insertedMessage.deletedAt),
        status: 'sent',
        createdAt: insertedMessage.createdAt?.toISOString?.() || (insertedMessage.createdAt instanceof Date ? insertedMessage.createdAt.toISOString() : insertedMessage.createdAt),
        updatedAt: insertedMessage.updatedAt?.toISOString?.() || (insertedMessage.updatedAt instanceof Date ? insertedMessage.updatedAt.toISOString() : insertedMessage.updatedAt),
      };
      
      participantIds.forEach(participantId => {
        socketIO.to(`user:${participantId}`).emit('new_message', messageForSocket);
      });
      
      socketIO.to(`chat:${chat._id.toString()}`).emit('new_message', messageForSocket);
    }

    console.log(`✅ [CallService] Call history message processed: roomId=${session.roomId}, status=${callStatus}, chatId=${chat._id.toString()}`);
    return insertedMessage;
  } catch (error) {
    console.error('❌ Error creating call history message:', error);
    console.error('   Session data:', {
      roomId: session?.roomId,
      hasParticipants: !!session?.participants,
      participantCount: session?.participants?.length,
      callStatus,
      currentUserId,
    });
    console.error('   Error stack:', error.stack);
    return null;
  }
};
