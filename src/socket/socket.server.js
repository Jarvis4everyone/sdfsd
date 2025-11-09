import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { getMongoDB } from '../config/mongodb.config.js';
import postgresPool, { queryWithRetry } from '../config/postgres.config.js';
import { getRedisClient } from '../config/redis.config.js';
import { ObjectId } from 'mongodb';
import { getUserPresenceData, preparePresenceForBroadcast } from '../utils/presence.utils.js';
import {
  createCallSession,
  appendCallEvent,
  markParticipantState,
  endCallSession,
  getCallSessionByRoom,
  updateCallSession,
  markCallAsMissed,
  createCallHistoryMessage,
} from '../services/call.service.js';
import { generateCallToken } from '../services/agora.service.js';
import { logActivity } from '../services/analytics.service.js';

let io = null;

/**
 * Initialize Socket.IO server
 */
export const initializeSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN?.split(',').map(o => o.trim()) || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Authentication middleware for Socket.IO
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.phoneNumber = decoded.phoneNumber;
      next();
    } catch (error) {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    console.log(`✅ User connected: ${socket.userId}`);

    // Update user online status when they connect - IMMEDIATELY
    try {
      const updateResult = await queryWithRetry(
        "UPDATE users SET is_online = true, last_seen = (NOW() AT TIME ZONE 'UTC') WHERE id = $1 RETURNING last_seen AT TIME ZONE 'UTC' as last_seen_utc",
        [socket.userId],
        3,
        20000
      );
      
      if (updateResult.rows.length > 0) {
        console.log(`🔄 Updated user ${socket.userId} - is_online=true, last_seen_utc=${updateResult.rows[0].last_seen_utc}`);
      }
      
      // Broadcast presence update IMMEDIATELY to all users who have chats with this user
      // This ensures real-time online status updates
      await _broadcastPresenceUpdate(socket.userId, true);
    } catch (error) {
      console.error('❌ Error updating online status on connect:', error);
    }

    // Join user's personal room - CRITICAL for receiving call invites
    socket.join(`user:${socket.userId}`);
    console.log(`📞 [Socket] User ${socket.userId} joined room user:${socket.userId}`);

    // Check for active call sessions waiting for this user and resend invite if needed
    try {
      const { getCallSessionByRoom } = await import('../services/call.service.js');
      const mongoDb = getMongoDB();
      const callSessionsCollection = mongoDb.collection('calls');
      
      // Find active call sessions where this user is a participant with 'ringing' state
      const activeCalls = await callSessionsCollection.find({
        'participants.userId': socket.userId,
        'participants.state': 'ringing',
        status: { $in: ['ringing', 'active'] },
        endedAt: null,
      }).toArray();
      
      if (activeCalls.length > 0) {
        console.log(`📞 [Socket] Found ${activeCalls.length} active call(s) waiting for user ${socket.userId}`);
        
        for (const session of activeCalls) {
          // Get the initiator's user details
          const initiatorId = session.initiatorId;
          if (!initiatorId || initiatorId === socket.userId) continue;
          
          // Check if initiator is still connected
          const initiatorSockets = await io.in(`user:${initiatorId}`).fetchSockets();
          if (initiatorSockets.length === 0) {
            console.log(`📞 [Socket] Initiator ${initiatorId} is not connected, skipping call invite resend`);
            continue;
          }
          
          // Resend call invite to the user who just came online
          const { generateCallToken } = await import('../services/agora.service.js');
          try {
            const callerTokenData = generateCallToken(session.roomId, initiatorId, session.mediaType || 'audio');
            
            const payload = {
              roomId: session.roomId,
              mediaType: session.mediaType || 'audio',
              metadata: session.metadata || {},
              initiatorId: initiatorId,
              agoraConfig: {
                appId: callerTokenData.appId,
                channelName: callerTokenData.channelName,
                uid: callerTokenData.uid,
                token: callerTokenData.token,
              },
              participants: session.participants || [],
            };
            
            console.log(`📞 [Socket] Resending call_invite to user ${socket.userId} for room ${session.roomId}`);
            socket.emit('call_invite', payload);
          } catch (error) {
            console.error(`❌ [Socket] Failed to resend call invite for room ${session.roomId}: ${error.message}`);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error checking for active calls on user connect:', error);
      // Don't block connection if this fails
    }

    // Join all chat rooms the user is part of
    await _joinUserChats(socket.userId, socket);

    const joinCallRoom = (roomId) => {
      if (!roomId) return;
      socket.join(`call:${roomId}`);
    };

    const emitToCallParticipants = (participants, event, payload, excludeUserId) => {
      if (!Array.isArray(participants)) return;

      participants.forEach((participant) => {
        const participantId = typeof participant === 'string' ? participant : participant.userId;
        if (!participantId || participantId === excludeUserId) return;
        io.to(`user:${participantId}`).emit(event, payload);
      });
    };

    // Handle new message
    // BUG FIX #12: Wrap in try-catch to prevent unhandled promise rejections
    // BUG FIX #6: Add message deduplication to prevent duplicate messages
    socket.on('send_message', async (data) => {
      try {
        const { chatId, message, messageType = 'text', recipientId, messageId: clientMessageId } = data;
        
        // BUG FIX #6: Prevent duplicate messages by checking for existing messageId
        // If client sends messageId, check if message already exists
        if (clientMessageId) {
          try {
            const mongoDb = getMongoDB();
            const messagesCollection = mongoDb.collection('messages');
            const existingMessage = await messagesCollection.findOne({ _id: new ObjectId(clientMessageId) });
            if (existingMessage) {
              // Message already exists, just emit confirmation
              socket.emit('message_sent', {
                success: true,
                messageId: clientMessageId,
                chatId: existingMessage.chatId.toString(),
                isDuplicate: true,
              });
              return;
            }
          } catch (e) {
            // Invalid messageId, continue with normal flow
          }
        }

        if (!message) {
          socket.emit('error', { message: 'Message is required' });
          return;
        }

        const mongoDb = getMongoDB();
        const chatsCollection = mongoDb.collection('chats');
        const messagesCollection = mongoDb.collection('messages');

        let chat;
        let chatObjectId;

        // If chatId is provided, verify it exists
        if (chatId) {
          try {
            chatObjectId = new ObjectId(chatId);
            chat = await chatsCollection.findOne({
              _id: chatObjectId,
              participants: socket.userId,
            });
          } catch (error) {
            // Invalid chatId, will create new chat if recipientId provided
            chat = null;
          }
        }

        // If chat doesn't exist but recipientId is provided, create new chat
        if (!chat && recipientId && recipientId !== socket.userId) {
          // Verify recipient exists
          const recipientResult = await queryWithRetry(
            'SELECT id FROM users WHERE id = $1',
            [recipientId],
            3,
            20000
          );

          if (recipientResult.rows.length === 0) {
            socket.emit('error', { message: 'Recipient not found' });
            return;
          }

          // Check if user is blocked (either direction)
          const { isBlocked } = await import('../utils/block.utils.js');
          const blocked = await isBlocked(socket.userId, recipientId);
          if (blocked) {
            socket.emit('error', { message: "Can't send message" });
            return;
          }

          // Check if chat already exists between these users
          const existingChat = await chatsCollection.findOne({
            participants: { $all: [socket.userId, recipientId] },
            type: 'direct',
          });

          if (existingChat) {
            chat = existingChat;
            chatObjectId = existingChat._id;
          } else {
            // Create new chat with enhanced schema
            const newChat = {
              participants: [socket.userId, recipientId],
              type: 'direct',
              lastMessage: null,
              lastMessageAt: new Date(),
              archivedBy: [],
              pinnedBy: [],
              mutedBy: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            };

            const chatResult = await chatsCollection.insertOne(newChat);
            chat = { ...newChat, _id: chatResult.insertedId };
            chatObjectId = chatResult.insertedId;

            // Automatically add recipient to contacts
            const { autoAddContact } = await import('../utils/contacts.utils.js');
            await autoAddContact(socket.userId, recipientId);
          }
        }

        if (!chat) {
          socket.emit('error', { message: 'Chat not found and recipient not specified' });
          return;
        }

        if (!chatObjectId) {
          chatObjectId = chat._id;
        }

        // For direct chats, check if user is blocked (either direction) and auto-add to contacts
        if (chat.type === 'direct') {
          const otherParticipantId = chat.participants.find(id => id !== socket.userId);
          if (otherParticipantId) {
            const { isBlocked } = await import('../utils/block.utils.js');
            const blocked = await isBlocked(socket.userId, otherParticipantId);
            if (blocked) {
              socket.emit('error', { message: "Can't send message" });
              return;
            }

            // Automatically add to contacts if not already there
            const { autoAddContact } = await import('../utils/contacts.utils.js');
            await autoAddContact(socket.userId, otherParticipantId);
          }
        }

        // Parse mentions if this is a group chat
        let mentions = [];
        if (chat.type === 'group' && messageType === 'text') {
          const { parseMentions } = await import('../utils/mentions.utils.js');
          // Get participant details for mention parsing
          const participantDetails = await Promise.all(
            chat.participants.map(async (userId) => {
              const userResult = await queryWithRetry(
                "SELECT id, full_name FROM users WHERE id = $1",
                [userId],
                3,
                20000
              );
              if (userResult.rows.length > 0) {
                return {
                  id: userResult.rows[0].id,
                  fullName: userResult.rows[0].full_name,
                };
              }
              return null;
            })
          );
          const validParticipants = participantDetails.filter(p => p != null);
          mentions = parseMentions(message, validParticipants);
        }

        // Create message with enhanced schema
        const newMessage = {
          chatId: chatObjectId,
          senderId: socket.userId,
          message: message,
          messageType: messageType,
          readBy: [socket.userId], // Sender has read it
          readReceipts: [
            {
              userId: socket.userId,
              readAt: new Date(),
            },
          ],
          mentions: mentions, // Array of mentioned user IDs
          editedAt: null,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const messageResult = await messagesCollection.insertOne(newMessage);
        const messageId = messageResult.insertedId.toString();
        
        // Log activity (with error handling)
        try {
          await logActivity({
            userId: socket.userId,
            activityType: 'message_sent',
            activityData: {
              chatId: chatIdString,
              messageType,
              messageLength: message.length,
            },
            ipAddress: socket.handshake.address,
            deviceId: socket.handshake.auth.deviceId || 'unknown',
          });
        } catch (logError) {
          console.error('Error logging activity:', logError);
          // Don't fail message send if logging fails
        }

        // Update last_seen when user sends a message (they're clearly active)
        // This ensures last_seen is current even if heartbeat fails or is delayed
        try {
          const updateResult = await queryWithRetry(
            "UPDATE users SET last_seen = (NOW() AT TIME ZONE 'UTC'), is_online = true WHERE id = $1 RETURNING last_seen AT TIME ZONE 'UTC' as last_seen_utc",
            [socket.userId],
            3,
            20000
          );
          if (updateResult.rows.length > 0) {
            console.log(`💬 Message sent by ${socket.userId} - Updated last_seen_utc=${updateResult.rows[0].last_seen_utc}`);
          }
        } catch (error) {
          console.error('❌ Error updating last_seen on message send:', error);
        }

        // Update chat's last message
        const otherParticipantId = chat.participants.find((id) => id !== socket.userId);
        await chatsCollection.updateOne(
          { _id: chatObjectId },
          {
            $set: {
              lastMessage: message,
              lastMessageAt: new Date(),
              updatedAt: new Date(),
            },
          }
        );

        // Increment unread count for other participant
        // NOTE: Call messages should NOT increment unread count as they're system messages
        // that both participants can see. They're already marked as read in createCallHistoryMessage.
        // BUG FIX #1: Use safe Redis operations to prevent race conditions
        if (otherParticipantId && messageType !== 'call') {
          const { incrementUnreadCount } = await import('../utils/redis.utils.js');
          await incrementUnreadCount(otherParticipantId, chatObjectId.toString(), 1);
        }

        const chatIdString = chatObjectId.toString();
        
        // Get sender name for group chats
        let senderName = null;
        if (chat.type === 'group') {
          const senderResult = await queryWithRetry(
            `SELECT full_name FROM users WHERE id = $1`,
            [socket.userId],
            3,
            20000
          );
          if (senderResult.rows.length > 0) {
            senderName = senderResult.rows[0].full_name || null;
          }
        }
        
        // Prepare message data for clients with enhanced schema
        const messageData = {
          id: messageId,
          chatId: chatIdString,
          senderId: socket.userId,
          message: message,
          messageType: messageType,
          readBy: [socket.userId],
          readReceipts: [
            {
              userId: socket.userId,
              readAt: newMessage.createdAt.toISOString(),
            },
          ],
          mentions: newMessage.mentions || [], // Include mentions
          editedAt: null,
          deletedAt: null,
          status: 'sent', // Message is sent to server
          createdAt: newMessage.createdAt.toISOString(),
          updatedAt: newMessage.updatedAt.toISOString(),
        };
        
        // Include sender name for group chats
        if (senderName) {
          messageData.senderName = senderName;
        }

        // Emit to all participants in the chat room
        io.to(`chat:${chatIdString}`).emit('new_message', messageData);
        
        // Also emit directly to user rooms to ensure delivery even if chat room join fails
        chat.participants.forEach((participantId) => {
          if (participantId !== socket.userId) {
            io.to(`user:${participantId}`).emit('new_message', messageData);
          }
        });
        
        // Also emit to update chat list for all participants with unread count
        const lastMessageAt = new Date();
        const redisClient = getRedisClient();
        const isGroup = chat.type === 'group';
        
        // Get fresh sender user data after updating last_seen
        const updatedSenderUserResult = await queryWithRetry(
          "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = $1",
          [socket.userId],
          3,
          20000
        );
        const updatedSenderUser = updatedSenderUserResult.rows[0];
        const updatedSenderPresenceData = getUserPresenceData(updatedSenderUser);

        // Emit chat update to all participants
        for (const participantId of chat.participants) {
          const participantUnreadCount = await redisClient.get(`unread:${participantId}:${chatObjectId}`) || '0';
          
          const chatUpdateData = {
            chatId: chatIdString,
            type: chat.type || 'direct',
            lastMessage: message,
            lastMessageAt: lastMessageAt.toISOString(),
            unreadCount: parseInt(participantUnreadCount),
            isNewChat: !chatId,
            archivedBy: chat.archivedBy || [],
            pinnedBy: chat.pinnedBy || [],
            mutedBy: chat.mutedBy || [],
          };
          
          // For direct chats, include otherUser info
          // For groups, include groupInfo
          if (isGroup) {
            chatUpdateData.groupInfo = {
              groupName: chat.groupName,
              groupDescription: chat.groupDescription,
              groupPictureUrl: chat.groupPictureUrl,
              participantCount: chat.participants.length,
              admins: chat.admins || [],
              createdBy: chat.createdBy,
            };
          } else if (participantId !== socket.userId) {
            // For direct chats, include sender's presence data for the other participant
            chatUpdateData.otherUser = updatedSenderPresenceData;
            
            // Also broadcast presence update to receiver IMMEDIATELY with fresh data
            if (io && updatedSenderPresenceData) {
              const presenceData = preparePresenceForBroadcast(updatedSenderPresenceData);
              if (presenceData) {
                io.to(`user:${participantId}`).emit('presence_update', presenceData);
              }
            }
          }
          
          io.to(`user:${participantId}`).emit('chat_updated', chatUpdateData);
        }

        // Send confirmation to sender with chatId (in case it was created)
        socket.emit('message_sent', {
          success: true,
          messageId: messageId,
          chatId: chatIdString,
          isNewChat: !chatId,
        });
      } catch (error) {
        // BUG FIX #12: Proper error handling for unhandled promise rejections
        console.error('Socket send_message error:', error);
        if (socket.connected) {
          socket.emit('error', { 
            message: 'Failed to send message',
            error: error.message 
          });
        }
      }
    });

    // Call signaling: invite participants to a call session (Agora)
    // BUG FIX #12: Wrap in try-catch to prevent unhandled promise rejections
    // BUG FIX #17: Add deduplication for call session creation
    socket.on('call_invite', async (data) => {
      try {
        console.log(`📞 [Socket] Received call_invite event from ${socket.userId}:`, JSON.stringify(data, null, 2));
        const { roomId, participants = [], mediaType = 'audio', metadata } = data || {};

        if (!roomId) {
          console.error(`📞 [Socket] call_invite error: roomId is required`);
          socket.emit('call_error', { message: 'roomId is required for call_invite' });
          return;
        }

        // Log call sent
        console.log(`📞 [Socket] Call sent: ${mediaType} call from ${socket.userId} to ${participants.length} participant(s), roomId=${roomId}`);
        
        // Log activity
        await logActivity({
          userId: socket.userId,
          activityType: 'call_initiated',
          activityData: {
            roomId,
            mediaType,
            participantCount: participants.length,
          },
          ipAddress: socket.handshake.address,
          deviceId: socket.handshake.auth.deviceId || 'unknown',
        });

        // Ensure current user is within participants list
        const uniqueParticipants = new Set(participants);
        uniqueParticipants.add(socket.userId);

        const participantEntries = Array.from(uniqueParticipants).map((participantId) => ({
          userId: participantId,
          state: participantId === socket.userId ? 'initiator' : 'ringing',
          updatedAt: new Date(),
        }));

        // BUG FIX #17: Check for existing session first to prevent race conditions
        let session = await getCallSessionByRoom(roomId);

        if (!session) {
          console.log(`📞 [Socket] No existing session for roomId=${roomId}, creating new session`);
          try {
            // BUG FIX #17: Use try-catch with proper error handling for duplicate sessions
            session = await createCallSession({
              roomId,
              initiatorId: socket.userId,
              participants: participantEntries,
              mediaType,
              signalPayload: null, // No WebRTC offer needed for Agora
              metadata,
            });
            console.log(`📞 [Socket] Successfully created call session for roomId=${roomId}, sessionId=${session._id}`);
            
            // Verify session was created by fetching it again (ensures it's committed)
            const verifySession = await getCallSessionByRoom(roomId);
            if (!verifySession) {
              console.error(`⚠️  [Socket] Session creation verification failed for roomId=${roomId} - session not found after creation`);
            } else {
              console.log(`✅ [Socket] Session verified for roomId=${roomId}`);
            }
          } catch (error) {
            // If duplicate key error, session already exists (created via API or concurrent request)
            // BUG FIX #17: Handle race condition where multiple invites create sessions simultaneously
            if (error.code === 11000 || error.codeName === 'DuplicateKey') {
              console.log(`📞 [Socket] Call session already exists for roomId=${roomId} (race condition), fetching existing session`);
              session = await getCallSessionByRoom(roomId);
              if (!session) {
                console.error(`📞 [Socket] Failed to fetch existing session for roomId=${roomId}`);
                if (socket.connected) {
                  socket.emit('call_error', { message: 'Failed to create call session', roomId });
                }
                return;
              }
            } else {
              console.error(`📞 [Socket] Error creating call session: ${error.message}`);
              if (socket.connected) {
                socket.emit('call_error', { message: 'Failed to create call session', roomId });
              }
              return;
            }
          }
        } else {
          const existingParticipantIds = new Set(
            (session.participants || []).map((participant) => participant.userId)
          );

          if ((!session.metadata || Object.keys(session.metadata).length === 0) && metadata) {
            const updatedWithMetadata = await updateCallSession(roomId, { metadata });
            session = updatedWithMetadata || session;
          }

          const newParticipants = participantEntries.filter(
            (entry) => !existingParticipantIds.has(entry.userId)
          );

          if (newParticipants.length > 0) {
            const updated = await updateCallSession(roomId, {
              participants: [...(session.participants || []), ...newParticipants],
            });
            session = updated || session;
          }
        }

        // Join caller to call room immediately so they can receive call_answer
        joinCallRoom(roomId);
        console.log(`📞 [Socket] Caller ${socket.userId} joined call room call:${roomId}`);

        const effectiveParticipants = session?.participants || participantEntries;

        // Generate Agora token for the caller
        let callerTokenData;
        try {
          callerTokenData = generateCallToken(roomId, socket.userId, mediaType);
        } catch (error) {
          console.error(`❌ [Socket] Failed to generate Agora token for caller: ${error.message}`);
          socket.emit('call_error', { 
            message: 'Failed to generate call token. Please check Agora configuration.',
            roomId 
          });
          return;
        }

        const payload = {
          roomId,
          mediaType,
          metadata,
          initiatorId: socket.userId,
          agoraConfig: {
            appId: callerTokenData.appId,
            channelName: callerTokenData.channelName,
            uid: callerTokenData.uid,
            token: callerTokenData.token,
          },
          participants: effectiveParticipants,
        };

        // Emit to all participants (excluding caller)
        console.log(`📞 [Socket] Emitting call_invite to ${effectiveParticipants.length} participant(s)`);
        let emittedCount = 0;
        const recipientIds = [];
        
        for (const participant of effectiveParticipants) {
          const participantId = typeof participant === 'string' ? participant : participant.userId;
          if (participantId && participantId !== socket.userId) {
            recipientIds.push(participantId);
            const userRoom = `user:${participantId}`;
            
            // Check if user is connected
            const userSockets = await io.in(userRoom).fetchSockets();
            console.log(`📞 [Socket] User ${participantId} has ${userSockets.length} socket(s) in room ${userRoom}`);
            
            if (userSockets.length > 0) {
              console.log(`📞 [Socket] Emitting call_invite to ${participantId} via room ${userRoom}`);
              io.to(userRoom).emit('call_invite', payload);
              emittedCount++;
            } else {
              console.warn(`⚠️  [Socket] User ${participantId} is not connected - cannot deliver call_invite`);
            }
          }
        }
        
        // Also emit to call room as backup (participants will join when they answer)
        io.to(`call:${roomId}`).emit('call_invite', payload);
        
        console.log(`📞 [Socket] Successfully emitted call_invite to ${emittedCount}/${recipientIds.length} participant(s)`);

        // Emit call_invite_sent to the caller with agoraConfig
        const inviteSentPayload = {
          success: true,
          roomId,
          participants: effectiveParticipants,
          agoraConfig: {
            appId: callerTokenData.appId,
            channelName: callerTokenData.channelName,
            uid: callerTokenData.uid,
            token: callerTokenData.token, // Include the token!
          },
        };
        console.log(`📞 [Socket] Emitting call_invite_sent to caller ${socket.userId} with agoraConfig`);
        socket.emit('call_invite_sent', inviteSentPayload);

        // Set timeout to auto-end call if not answered within 60 seconds
        // This ensures missed calls are properly recorded
        const callTimeout = setTimeout(async () => {
          try {
            // Check if call is still active (not answered or ended)
            const currentSession = await getCallSessionByRoom(roomId);
            if (!currentSession) return; // Call already ended
            
            // Check if any participant has answered
            const hasAnswered = (currentSession.participants || []).some(
              p => p.state === 'answered'
            );
            
            // Check if call is already ended
            if (currentSession.status && ['ended', 'missed', 'rejected'].includes(currentSession.status)) {
              return; // Already handled
            }
            
            // If no one answered, mark as missed and end the call
            if (!hasAnswered) {
              console.log(`⏰ [Socket] Call timeout: roomId=${roomId} - no answer after 60s, marking as missed`);
              
              // Check if call is already being ended by another handler
              // We'll use the initiator's socket to check (if available)
              // For now, just proceed but use deduplication in createCallHistoryMessage
              
              // Mark all non-initiator participants as missed
              const participants = currentSession.participants || [];
              for (const participant of participants) {
                if (participant.userId !== currentSession.initiatorId && 
                    !['answered', 'declined', 'missed'].includes(participant.state)) {
                  await markCallAsMissed(roomId, participant.userId);
                }
              }
              
              // End the call session
              const endedSession = await endCallSession({
                roomId,
                reason: 'timeout',
                endedBy: currentSession.initiatorId,
              });
              
              if (endedSession) {
                // Create call history message for missed call (deduplication handled inside)
                await createCallHistoryMessage(endedSession, 'missed', currentSession.initiatorId, io);
                
                // Notify all participants - use Set to avoid duplicates
                const uniqueParticipantIds = new Set();
                participants.forEach(p => {
                  const participantId = typeof p === 'string' ? p : p.userId;
                  if (participantId) {
                    uniqueParticipantIds.add(participantId);
                  }
                });
                
                const callEndedPayload = {
                  roomId,
                  reason: 'timeout',
                  endedBy: currentSession.initiatorId,
                };
                
                // Emit once per participant via user rooms
                uniqueParticipantIds.forEach(participantId => {
                  io.to(`user:${participantId}`).emit('call_ended', callEndedPayload);
                });
                
                // Also emit to call room as backup
                io.to(`call:${roomId}`).emit('call_ended', callEndedPayload);
              }
            }
          } catch (error) {
            console.error('⚠️  [Socket] Error in call timeout handler:', error);
          }
        }, 60000); // 60 seconds timeout

        // BUG FIX #18: Store timeout in socket data so we can clear it if call is answered/ended
        if (!socket.data.callTimeouts) {
          socket.data.callTimeouts = new Map();
        }
        socket.data.callTimeouts.set(roomId, callTimeout);
      } catch (error) {
        // BUG FIX #12: Proper error handling
        console.error('Socket call_invite error:', error);
        if (socket.connected) {
          socket.emit('call_error', { message: 'Failed to process call invite: ' + error.message });
        }
      }
    });

    // Call signaling: answer call (Agora)
    // BUG FIX #12: Wrap in try-catch to prevent unhandled promise rejections
    socket.on('call_answer', async (data) => {
      try {
        const { roomId } = data || {};

        if (!roomId) {
          socket.emit('call_error', { message: 'roomId is required' });
          return;
        }

        // Get session first
        const session = await getCallSessionByRoom(roomId);
        
        if (!session) {
          socket.emit('call_error', { message: 'Call session not found' });
          return;
        }

        // Log call picked
        console.log(`📞 Call picked: ${socket.userId} answered call in room ${roomId}`);
        
        // Log activity
        await logActivity({
          userId: socket.userId,
          activityType: 'call_answered',
          activityData: {
            roomId,
            mediaType: session.mediaType || 'audio',
          },
          ipAddress: socket.handshake.address,
          deviceId: socket.handshake.auth.deviceId || 'unknown',
        });

        const updatedSession = await markParticipantState(roomId, socket.userId, 'answered');

        if (!updatedSession) {
          socket.emit('call_error', { message: 'Failed to update call state' });
          return;
        }

        // Update session status to 'answered' if at least one participant has answered
        // This ensures the session status reflects the call state
        const hasAnswered = (updatedSession.participants || []).some(p => p.state === 'answered');
        if (hasAnswered && updatedSession.status === 'ringing') {
          await updateCallSession(roomId, { status: 'answered' });
          updatedSession.status = 'answered';
        }

        // Clear call timeout since call was answered
        if (socket.data.callTimeouts && socket.data.callTimeouts.has(roomId)) {
          clearTimeout(socket.data.callTimeouts.get(roomId));
          socket.data.callTimeouts.delete(roomId);
        }

        await appendCallEvent(roomId, {
          type: 'answer',
          userId: socket.userId,
          payload: { timestamp: new Date().toISOString() },
        });

        joinCallRoom(roomId);

        // Generate Agora token for the callee
        let calleeTokenData;
        try {
          calleeTokenData = generateCallToken(roomId, socket.userId, updatedSession.mediaType || session.mediaType || 'audio');
        } catch (error) {
          console.error(`❌ [Socket] Failed to generate Agora token for callee: ${error.message}`);
          socket.emit('call_error', { 
            message: 'Failed to generate call token. Please check Agora configuration.',
            roomId 
          });
          return;
        }

        const answerPayload = {
          roomId,
          userId: socket.userId,
          agoraConfig: {
            appId: calleeTokenData.appId,
            channelName: calleeTokenData.channelName,
            uid: calleeTokenData.uid,
            token: calleeTokenData.token,
          },
        };
        
        // Emit to the call room (reaches all participants who have joined)
        const callRoomName = `call:${roomId}`;
        console.log(`📞 [Socket] Emitting call_answer to call room: ${callRoomName}`);
        io.to(callRoomName).emit('call_answer', answerPayload);
        
        // Also send directly to initiator via their user room (CRITICAL - ensures caller receives it)
        const effectiveSession = updatedSession || session;
        if (effectiveSession.initiatorId && effectiveSession.initiatorId !== socket.userId) {
          const initiatorRoomName = `user:${effectiveSession.initiatorId}`;
          console.log(`📞 [Socket] Emitting call_answer to initiator ${effectiveSession.initiatorId} via room ${initiatorRoomName}`);
          io.to(initiatorRoomName).emit('call_answer', answerPayload);
          
          // Verify initiator is connected
          const initiatorSockets = await io.in(initiatorRoomName).fetchSockets();
          console.log(`📞 [Socket] Initiator ${effectiveSession.initiatorId} has ${initiatorSockets.length} socket(s) in room ${initiatorRoomName}`);
        }
        
        // Backup: emit to all participants via their user rooms
        if (effectiveSession.participants && effectiveSession.participants.length > 0) {
          console.log(`📞 [Socket] Emitting call_answer to ${effectiveSession.participants.length} participant(s) via user rooms`);
          emitToCallParticipants(effectiveSession.participants, 'call_answer', answerPayload, socket.userId);
        }
        
        console.log(`📞 [Socket] call_answer event emitted successfully for room ${roomId}`);
      } catch (error) {
        // BUG FIX #12: Proper error handling
        console.error('Socket call_answer error:', error);
        if (socket.connected) {
          socket.emit('call_error', { message: 'Failed to send call answer: ' + error.message });
        }
      }
    });

    // Note: ICE candidates not needed for Agora - Agora handles connectivity automatically

    // Track when users join the Agora channel for timer synchronization
    const userJoinedTracker = new Map(); // roomId -> Set of userIds who joined
    
    socket.on('call_user_joined', async (data = {}) => {
      try {
        const { roomId } = data;
        if (!roomId || !socket.userId) return;
        
        // Track this user as having joined
        if (!userJoinedTracker.has(roomId)) {
          userJoinedTracker.set(roomId, new Set());
        }
        const joinedUsers = userJoinedTracker.get(roomId);
        joinedUsers.add(socket.userId);
        
        console.log(`📞 [Socket] User ${socket.userId} joined Agora channel for room ${roomId}. Joined users: ${Array.from(joinedUsers).join(', ')}`);
        
        // Get the call session to check how many participants should join
        const session = await getCallSessionByRoom(roomId);
        if (!session) {
          console.log(`⚠️  [Socket] No session found for room ${roomId}`);
          return;
        }
        
        // Check if all participants have joined (at least 2 for a call)
        const expectedParticipants = session.participants?.length || 0;
        const actualJoined = joinedUsers.size;
        
        console.log(`📞 [Socket] Room ${roomId}: ${actualJoined}/${expectedParticipants} participants joined`);
        
        // When both users have joined, emit call_connected with server timestamp
        if (actualJoined >= 2 && expectedParticipants >= 2) {
          const serverTimestamp = new Date().toISOString();
          const connectedPayload = {
            roomId,
            timestamp: serverTimestamp,
            participants: Array.from(joinedUsers),
          };
          
          console.log(`📞 [Socket] ✅ Both users connected! Emitting call_connected with timestamp: ${serverTimestamp}`);
          
          // Emit to all participants in the call room
          io.to(`call:${roomId}`).emit('call_connected', connectedPayload);
          
          // Also emit to individual user rooms as backup
          joinedUsers.forEach(userId => {
            io.to(`user:${userId}`).emit('call_connected', connectedPayload);
          });
          
          // Clean up tracker after a delay (in case of reconnection)
          setTimeout(() => {
            userJoinedTracker.delete(roomId);
          }, 60000); // Clean up after 1 minute
        }
      } catch (error) {
        console.error('Socket call_user_joined error:', error);
      }
    });

    // Call signaling: revoke invitation / decline call
    // BUG FIX #12: Wrap in try-catch to prevent unhandled promise rejections
    socket.on('call_decline', async (data = {}) => {
      try {
        const { roomId, reason = 'declined' } = data;

        console.log(`📞 [Socket] Received call_decline from ${socket.userId} for roomId=${roomId}`);

        if (!roomId) {
          console.log('⚠️  [Socket] call_decline missing roomId');
          return;
        }

        // Try to get session first
        let session = await getCallSessionByRoom(roomId);
        
        // If session doesn't exist, try to create a minimal one or find caller from recent invites
        if (!session) {
          console.log(`⚠️  [Socket] No session found for roomId=${roomId}, trying to find caller from call room`);
          
          // Try to find caller from call room participants
          // The caller should have joined the call room when they sent the invite
          const callRoomSockets = await io.in(`call:${roomId}`).fetchSockets();
          const callerSocket = callRoomSockets.find(s => s.userId !== socket.userId);
          
          if (callerSocket) {
            console.log(`📞 [Socket] Found caller ${callerSocket.userId} in call room, emitting decline event`);
            // Emit directly to caller even without session
            io.to(`user:${callerSocket.userId}`).emit('call_declined', {
              roomId,
              userId: socket.userId,
              reason,
            });
            console.log(`📞 [Socket] call_declined event emitted to caller ${callerSocket.userId} (no session)`);
          } else {
            console.log(`⚠️  [Socket] Could not find caller for roomId=${roomId}`);
          }
          
          // Still try to mark participant state (might create session if it doesn't exist)
          session = await markParticipantState(roomId, socket.userId, 'declined');
          
          if (!session) {
            console.log(`⚠️  [Socket] Still no session after markParticipantState for roomId=${roomId}`);
            // Even without session, we've already tried to notify the caller above
            return;
          }
        } else {
          // Session exists, mark participant state
          session = await markParticipantState(roomId, socket.userId, 'declined');
          if (!session) {
            console.log(`⚠️  [Socket] Failed to mark participant state for roomId=${roomId}`);
            // Try to emit anyway with the original session data
            session = await getCallSessionByRoom(roomId);
          }
        }

        if (!session) {
          console.log(`⚠️  [Socket] No session available for roomId=${roomId}, cannot process decline`);
          return;
        }

        console.log(`📞 [Socket] Call declined by ${socket.userId}, session initiatorId=${session.initiatorId}, participants=${JSON.stringify(session.participants?.map(p => typeof p === 'string' ? p : p.userId))}`);

        // Check if this is a group call
        const isGroupCall = session.metadata && session.metadata.isGroup === true;
        
        await appendCallEvent(roomId, {
          type: 'decline',
          userId: socket.userId,
          reason,
        });

        // Emit declined event to all participants (especially the caller)
        // Use a Set to avoid duplicate emissions to the same user
        const uniqueParticipantIds = new Set();
        session.participants.forEach(p => {
          const participantId = typeof p === 'string' ? p : p.userId;
          if (participantId) {
            uniqueParticipantIds.add(participantId);
          }
        });
        
        const declinedPayload = {
          roomId,
          userId: socket.userId,
          reason,
          isGroup: isGroupCall,
        };
        
        // Emit once per participant via user rooms (most reliable)
        uniqueParticipantIds.forEach(participantId => {
          if (participantId !== socket.userId) { // Don't emit to the person who declined
            io.to(`user:${participantId}`).emit('call_declined', declinedPayload);
          }
        });
        
        // Also emit to call room as backup (but participants should already have it from user room)
        io.to(`call:${roomId}`).emit('call_declined', declinedPayload);

        // For group calls: Don't end the call immediately - let others continue
        // Only end if ALL participants decline or if initiator ends it
        if (isGroupCall) {
          console.log(`📞 [Socket] Group call: ${socket.userId} declined, but call continues for others`);
          
          // Check if all non-initiator participants have declined
          const nonInitiatorParticipants = session.participants.filter(p => {
            const participantId = typeof p === 'string' ? p : p.userId;
            return participantId !== session.initiatorId;
          });
          
          const allDeclined = nonInitiatorParticipants.every(p => {
            const state = typeof p === 'string' ? 'declined' : p.state;
            return state === 'declined' || state === 'ended';
          });
          
          if (allDeclined && nonInitiatorParticipants.length > 0) {
            console.log(`📞 [Socket] Group call: All participants declined, ending call`);
            // All participants declined, end the call
            const endedSession = await endCallSession({ 
              roomId, 
              reason: 'all_declined', 
              endedBy: socket.userId 
            });
            
            if (endedSession) {
              try {
                await createCallHistoryMessage(endedSession, 'rejected', socket.userId, io);
              } catch (error) {
                console.error('⚠️  Error creating call history message:', error);
              }
            }
            
            const callEndedPayload = {
              roomId,
              endedBy: socket.userId,
              reason: 'all_declined',
            };
            
            uniqueParticipantIds.forEach(participantId => {
              io.to(`user:${participantId}`).emit('call_ended', callEndedPayload);
            });
            io.to(`call:${roomId}`).emit('call_ended', callEndedPayload);
          } else {
            // Call continues - just notify that someone declined
            console.log(`📞 [Socket] Group call continues: ${nonInitiatorParticipants.length - nonInitiatorParticipants.filter(p => {
              const state = typeof p === 'string' ? 'declined' : p.state;
              return state === 'declined' || state === 'ended';
            }).length} participants still available`);
          }
        } else {
          // Personal call: End immediately when someone declines
          console.log(`📞 [Socket] Personal call: ${socket.userId} declined, ending call`);
          
          // Clear call timeout if exists
          if (socket.data.callTimeouts && socket.data.callTimeouts.has(roomId)) {
            clearTimeout(socket.data.callTimeouts.get(roomId));
            socket.data.callTimeouts.delete(roomId);
          }

          const endedSession = await endCallSession({ 
            roomId, 
            reason: 'declined', 
            endedBy: socket.userId 
          });
          
          if (endedSession) {
            try {
              await createCallHistoryMessage(endedSession, 'rejected', socket.userId, io);
            } catch (error) {
              console.error('⚠️  Error creating call history message for rejected call:', error);
            }
          }
          
          const callEndedPayload = {
            roomId,
            endedBy: socket.userId,
            reason: 'declined',
          };
          
          uniqueParticipantIds.forEach(participantId => {
            io.to(`user:${participantId}`).emit('call_ended', callEndedPayload);
          });
          io.to(`call:${roomId}`).emit('call_ended', callEndedPayload);
        }
      } catch (error) {
        // BUG FIX #12: Proper error handling
        console.error('Socket call_decline error:', error);
      }
    });


    // Call signaling: end call
    // BUG FIX #12: Wrap in try-catch to prevent unhandled promise rejections
    socket.on('call_end', async (data = {}) => {
      try {
        const { roomId, reason = 'ended' } = data;
        if (!roomId) {
          console.log('⚠️  [Socket] call_end received without roomId');
          return;
        }

        console.log(`📞 [Socket] Processing call_end: roomId=${roomId}, reason=${reason}, userId=${socket.userId}`);

        // Track ended calls to prevent duplicate processing
        // Use a Set stored in socket data to track calls that are being/have been ended
        if (!socket.data.endingCalls) {
          socket.data.endingCalls = new Set();
        }
        
        // If this call is already being processed, skip it
        if (socket.data.endingCalls.has(roomId)) {
          console.log(`⚠️  [Socket] Call ${roomId} is already being ended, skipping duplicate call_end`);
          return;
        }
        
        // Mark this call as being ended
        socket.data.endingCalls.add(roomId);
        
        // Clean up the flag after a delay (5 seconds should be enough)
        setTimeout(() => {
          if (socket.data.endingCalls) {
            socket.data.endingCalls.delete(roomId);
          }
        }, 5000);

        // Try to get existing session first (might already be ended)
        let session = await getCallSessionByRoom(roomId);
        
        // If session exists, try to end it properly
        if (session) {
          session = await endCallSession({
            roomId,
            reason,
            endedBy: socket.userId,
          });
        } else {
          // Session not found - might have been deleted or never created
          // Try to end it anyway (endCallSession will handle it gracefully)
          console.log(`⚠️  [Socket] Session not found for roomId=${roomId}, attempting to end anyway`);
          session = await endCallSession({
            roomId,
            reason,
            endedBy: socket.userId,
          });
        }

        // If we still don't have a session, try to get it one more time
        // (it might have been created by endCallSession)
        if (!session) {
          session = await getCallSessionByRoom(roomId);
        }

        // If session exists, process it
        if (session) {
          await appendCallEvent(roomId, {
            type: 'end',
            userId: socket.userId,
            reason,
          });

          // Mark participants who didn't answer as missed
          const participants = session.participants || [];
          for (const participant of participants) {
            if (participant.userId !== socket.userId && 
                !['answered', 'declined', 'missed'].includes(participant.state)) {
              await markCallAsMissed(roomId, participant.userId);
            }
          }

          // BUG FIX #18: Clear call timeout if exists
          if (socket.data.callTimeouts && socket.data.callTimeouts.has(roomId)) {
            clearTimeout(socket.data.callTimeouts.get(roomId));
            socket.data.callTimeouts.delete(roomId);
          }

          // Create call history message in chat - CRITICAL: Always try to create history
          try {
            // Determine call status - use session.status if available, otherwise infer from reason
            let callStatus = session.status || 'ended';
            if (callStatus === 'ringing' && reason === 'ended') {
              // If call was connected (both users joined), it should be 'answered'
              const hasAnswered = (session.participants || []).some(p => p.state === 'answered');
              callStatus = hasAnswered ? 'answered' : 'missed';
            }
            
            console.log(`📞 [Socket] Creating call history message: roomId=${roomId}, status=${callStatus}, reason=${reason}`);
            await createCallHistoryMessage(session, callStatus, socket.userId, io);
            console.log(`✅ [Socket] Call history message created successfully for roomId=${roomId}`);
          } catch (error) {
            console.error('⚠️  Error creating call history message in socket handler:', error);
            console.error('   Error stack:', error.stack);
            // Continue even if call history creation fails
          }

          // Notify all participants that call ended
          // Use a Set to avoid duplicate emissions to the same user
          const uniqueParticipantIds = new Set();
          participants.forEach(p => {
            const participantId = typeof p === 'string' ? p : p.userId;
            if (participantId) {
              uniqueParticipantIds.add(participantId);
            }
          });
          
          // Emit once per participant via user rooms (most reliable)
          const callEndedPayload = {
            roomId,
            reason,
            endedBy: socket.userId,
          };
          
          uniqueParticipantIds.forEach(participantId => {
            io.to(`user:${participantId}`).emit('call_ended', callEndedPayload);
          });
          
          // Also emit to call room as backup (but participants should already have it from user room)
          io.to(`call:${roomId}`).emit('call_ended', callEndedPayload);
        } else {
          // Session not found - still try to create call history message if we can find the chat
          console.log(`⚠️  [Socket] Session not found for roomId=${roomId}, but will try to create call history message`);
          
          // Try to create call history message even without session
          // We'll need to reconstruct basic session info from roomId
          try {
            // Try to get session one more time from database
            const finalSession = await getCallSessionByRoom(roomId);
            if (finalSession) {
              let callStatus = finalSession.status || 'missed';
              if (callStatus === 'ringing') {
                callStatus = 'missed';
              }
              console.log(`📞 [Socket] Found session on retry, creating call history: roomId=${roomId}, status=${callStatus}`);
              await createCallHistoryMessage(finalSession, callStatus, socket.userId, io);
            } else {
              console.log(`⚠️  [Socket] Cannot create call history: session not found for roomId=${roomId}`);
            }
          } catch (error) {
            console.error('⚠️  Error creating call history message when session not found:', error);
          }
          
          // Try to find participants from call room
          const callRoomSockets = await io.in(`call:${roomId}`).fetchSockets();
          const participantIds = new Set();
          callRoomSockets.forEach(s => {
            if (s.userId) participantIds.add(s.userId);
          });
          
          // Emit to any participants we found
          participantIds.forEach(participantId => {
            io.to(`user:${participantId}`).emit('call_ended', {
              roomId,
              endedBy: socket.userId,
              reason,
            });
          });
        }
      } catch (error) {
        console.error('Socket call_end error:', error);
        console.error('   Error stack:', error.stack);
      }
    });

    // Call signaling: toggle media state (mute/unmute, video on/off)
    socket.on('call_toggle_media', async (data = {}) => {
      const { roomId, kind, enabled } = data;
      if (!roomId || !kind) return;

      console.log(`📞 [Socket] User ${socket.userId} toggled ${kind} to ${enabled} in room ${roomId}`);

      // Emit to call room (all participants in the call)
      io.to(`call:${roomId}`).emit('call_toggle_media', {
        roomId,
        kind,
        enabled,
        userId: socket.userId,
      });
      
      // Also emit to individual user rooms as backup
      try {
        const session = await getCallSessionByRoom(roomId);
        if (session && session.participants) {
          session.participants.forEach((participant) => {
            const participantId = typeof participant === 'string' ? participant : participant.userId;
            if (participantId && participantId !== socket.userId) {
              io.to(`user:${participantId}`).emit('call_toggle_media', {
                roomId,
                kind,
                enabled,
                userId: socket.userId,
              });
            }
          });
        }
      } catch (error) {
        console.error(`⚠️  [Socket] Error getting session for toggle_media: ${error.message}`);
        // Continue anyway - call room emit should be sufficient
      }
    });

    // Call signaling: screen share updates
    socket.on('call_screen_share', (data = {}) => {
      const { roomId, action } = data;
      if (!roomId || !action) return;

      socket.to(`call:${roomId}`).emit('call_screen_share', {
        roomId,
        action,
        userId: socket.userId,
      });
    });

    // Handle message read receipt
    // BUG FIX #12: Wrap in try-catch to prevent unhandled promise rejections
    socket.on('message_read', async (data) => {
      try {
        const { chatId, messageId } = data;

        if (!chatId || !messageId) {
          return;
        }

        // DO NOT update last_seen here - it's only updated on connect/disconnect/heartbeat

        const mongoDb = getMongoDB();
        const messagesCollection = mongoDb.collection('messages');

        // Update message readBy array
        let messageObjectId;
        try {
          messageObjectId = new ObjectId(messageId);
        } catch (error) {
          return; // Invalid message ID
        }
        
        const message = await messagesCollection.findOne({ _id: messageObjectId });

        if (message && !message.readBy.includes(socket.userId)) {
          await messagesCollection.updateOne(
            { _id: messageObjectId },
            { $addToSet: { readBy: socket.userId } }
          );

          // Check if all messages in this chat are now read by this user
          // Get the chat to find the other participant
          const chatsCollection = mongoDb.collection('chats');
          let chatObjectId;
          try {
            chatObjectId = new ObjectId(chatId);
          } catch (error) {
            return;
          }
          
          const chat = await chatsCollection.findOne({ _id: chatObjectId });
          if (chat) {
            const otherParticipantId = chat.participants.find((id) => id !== socket.userId);
            
            // Count unread messages from other participant
            const unreadCount = await messagesCollection.countDocuments({
              chatId: chatObjectId,
              senderId: otherParticipantId,
              readBy: { $ne: socket.userId }
            });
            
            // BUG FIX #5: Update unread count in Redis with safe operations
            const { setUnreadCount, clearUnreadCount } = await import('../utils/redis.utils.js');
            if (unreadCount === 0) {
              // All messages read, clear unread count
              await clearUnreadCount(socket.userId, chatObjectId.toString());
            } else {
              // Update unread count
              await setUnreadCount(socket.userId, chatObjectId.toString(), unreadCount);
            }
            
            // Emit chat update with new unread count (0 if all read)
            // Include archivedBy, pinnedBy, mutedBy to maintain correct state
            io.to(`user:${socket.userId}`).emit('chat_updated', {
              chatId: chatId,
              unreadCount: unreadCount,
              archivedBy: chat.archivedBy || [],
              pinnedBy: chat.pinnedBy || [],
              mutedBy: chat.mutedBy || [],
            });
          }

          // Emit read receipt to chat room immediately (real-time)
          io.to(`chat:${chatId}`).emit('message_read_receipt', {
            messageId: messageId,
            readBy: socket.userId,
            chatId: chatId,
          });
        }
      } catch (error) {
        console.error('Socket message_read error:', error);
      }
    });

    // Handle typing indicator
    // BUG FIX #12: Wrap in try-catch to prevent unhandled promise rejections
    // BUG FIX #25: Fix race condition in typing indicator
    socket.on('typing', async (data) => {
      try {
        const { chatId, isTyping } = data;

        if (!chatId) return;

        // BUG FIX #25: Use atomic Redis operations to prevent race conditions
        // BUG FIX #5: Use safe Redis operations
        const { safeRedisOperation } = await import('../utils/redis.utils.js');
        if (isTyping) {
          await safeRedisOperation(async (redisClient) => {
            await redisClient.setEx(
              `typing:${chatId}:${socket.userId}`,
              5, // 5 seconds TTL
              'true'
            );
          });
        } else {
          await safeRedisOperation(async (redisClient) => {
            await redisClient.del(`typing:${chatId}:${socket.userId}`);
          });
        }

        // Emit typing status to other participants
        socket.to(`chat:${chatId}`).emit('typing_status', {
          userId: socket.userId,
          isTyping: isTyping,
          chatId: chatId, // Include chatId so frontend can filter
        });
      } catch (error) {
        console.error('Socket typing error:', error);
      }
    });

    // Handle disconnect
    // BUG FIX #26: Add cleanup on user disconnect
    // BUG FIX #4: Properly clean up event listeners and resources
    socket.on('disconnect', async () => {
      console.log(`❌ User disconnected: ${socket.userId}`);
      
      // BUG FIX #18: Clear all call timeouts
      if (socket.data.callTimeouts) {
        socket.data.callTimeouts.forEach((timeout) => clearTimeout(timeout));
        socket.data.callTimeouts.clear();
      }
      
      // BUG FIX #26: Clean up typing indicators
      try {
        const mongoDb = getMongoDB();
        const chatsCollection = mongoDb.collection('chats');
        const userChats = await chatsCollection.find({
          participants: socket.userId,
        }).project({ _id: 1 }).toArray();
        
        const { safeRedisOperation } = await import('../utils/redis.utils.js');
        await Promise.all(
          userChats.map(async (chat) => {
            await safeRedisOperation(async (redisClient) => {
              await redisClient.del(`typing:${chat._id.toString()}:${socket.userId}`);
            });
          })
        );
      } catch (error) {
        console.error('Error cleaning up typing indicators on disconnect:', error);
      }
      
      // Update user offline status when they disconnect
      try {
        await queryWithRetry(
          "UPDATE users SET is_online = false, last_seen = (NOW() AT TIME ZONE 'UTC') WHERE id = $1",
          [socket.userId],
          3,
          20000
        );
        
        // Broadcast presence update to all users who have chats with this user
        await _broadcastPresenceUpdate(socket.userId, false);
      } catch (error) {
        console.error('Error updating offline status on disconnect:', error);
      }
      
      // BUG FIX #4: Remove all event listeners to prevent memory leaks
      socket.removeAllListeners();
    });
  });

  return io;
};

/**
 * Get Socket.IO instance
 */
export const getSocketIO = () => {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initializeSocket() first.');
  }
  return io;
};

/**
 * Join user to all their chat rooms
 */
async function _joinUserChats(userId, socket) {
  try {
    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    // Find all chats where user is a participant
    const chats = await chatsCollection.find({
      participants: userId,
    }).toArray();

    // Join all chat rooms
    chats.forEach((chat) => {
      socket.join(`chat:${chat._id.toString()}`);
    });

    if (chats.length > 0) {
      console.log(`   Joined ${chats.length} chat room(s) for user ${userId}`);
    }
  } catch (error) {
    console.error('Error joining user chats:', error);
  }
}

/**
 * Emit message to chat room (for use in REST API routes)
 */
export const emitNewMessage = async (chatId, messageData) => {
  if (io) {
    // Emit to chat room
    io.to(`chat:${chatId}`).emit('new_message', messageData);
    
    // Also get chat participants and emit directly to their user rooms for guaranteed delivery
    try {
      const mongoDb = getMongoDB();
      const chatsCollection = mongoDb.collection('chats');
      const chat = await chatsCollection.findOne({ _id: new ObjectId(chatId) });
      
      if (chat && chat.participants) {
        chat.participants.forEach((participantId) => {
          if (participantId !== messageData.senderId) {
            io.to(`user:${participantId}`).emit('new_message', messageData);
          }
        });
      }
    } catch (error) {
      console.error('Error emitting message to participants:', error);
      // Still emit to chat room even if participant lookup fails
    }
  }
};

/**
 * Emit chat update to user
 */
export const emitChatUpdate = (userId, chatData) => {
  if (io) {
    io.to(`user:${userId}`).emit('chat_updated', chatData);
  }
};

/**
 * Broadcast presence update (online/offline) to all users who have chats with this user
 * This function ensures IMMEDIATE real-time updates when users come online/offline
 */
async function _broadcastPresenceUpdate(userId, isOnline) {
  try {
    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');
    
    // Find all chats where this user is a participant
    const chats = await chatsCollection.find({
      participants: userId,
    }).toArray();
    
    // Get FRESH user details for presence update (always get latest from database)
    // CRITICAL: Convert last_seen to UTC to ensure consistent timezone handling
    const userResult = await postgresPool.query(
      "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = $1",
      [userId]
    );
    
    if (userResult.rows.length === 0) return;
    
    const user = userResult.rows[0];
    const userPresenceData = getUserPresenceData(user);
    
    if (!userPresenceData) return;
    
    // Prepare presence data using centralized function (ensures proper ISO string serialization)
    const presenceData = preparePresenceForBroadcast(userPresenceData);
    
    if (!presenceData) return;
    
    // For each chat, notify the other participant IMMEDIATELY
    for (const chat of chats) {
      const otherParticipantId = chat.participants.find((id) => id !== userId);
      if (otherParticipantId) {
        // Emit presence update to the other participant IMMEDIATELY
        if (io) {
          io.to(`user:${otherParticipantId}`).emit('presence_update', presenceData);
          
          // Also update their chat list with new presence info for immediate UI update
          io.to(`user:${otherParticipantId}`).emit('chat_updated', {
            chatId: chat._id.toString(),
            otherUser: userPresenceData,
            archivedBy: chat.archivedBy || [],
            pinnedBy: chat.pinnedBy || [],
            mutedBy: chat.mutedBy || [],
          });
        }
      }
    }
    
    console.log(`✅ Broadcasted presence update for user ${userId} (online: ${presenceData.isOnline}) to ${chats.length} chat(s)`);
  } catch (error) {
    console.error('Error broadcasting presence update:', error);
  }
}

/**
 * Emit status update to all contacts
 * @param {string} userId - User ID who updated status
 * @param {object} statusData - Status update data
 */
export const emitStatusUpdate = async (userId, statusData) => {
  try {
    if (!io) return;

    // Get all contacts of this user from PostgreSQL
    const contactsResult = await postgresPool.query(
      `SELECT u.id as user_id
       FROM contacts c
       LEFT JOIN users u ON u.phone_number = c.contact_phone_number 
         AND u.country_code = c.contact_country_code
       WHERE c.user_id = $1 AND u.id IS NOT NULL`,
      [userId]
    );

    const contactIds = contactsResult.rows.map(row => row.user_id);

    // Emit to all contacts
    contactIds.forEach(contactId => {
      io.to(`user:${contactId}`).emit('status_update', {
        ...statusData,
        userId: userId,
      });
    });

    // Also emit to the user who created the status (for real-time updates)
    io.to(`user:${userId}`).emit('status_update', {
      ...statusData,
      userId: userId,
    });

    console.log(`✅ Broadcasted status update for user ${userId} to ${contactIds.length} contact(s) and self`);
  } catch (error) {
    console.error('Error broadcasting status update:', error);
  }
};

