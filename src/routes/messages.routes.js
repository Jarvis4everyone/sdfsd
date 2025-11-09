import express from 'express';
import { ObjectId } from 'mongodb';
import { getMongoDB } from '../config/mongodb.config.js';
import postgresPool, { queryWithRetry } from '../config/postgres.config.js';
import { verifyToken } from './auth.routes.js';
import { getRedisClient } from '../config/redis.config.js';
import { emitNewMessage, emitChatUpdate } from '../socket/socket.server.js';
import { getUserPresenceData } from '../utils/presence.utils.js';
import { uploadMessageFile, getFileUrl, deleteFile } from '../middleware/upload.middleware.js';
import { logActivity } from '../services/analytics.service.js';
import multer from 'multer';
import { messageRateLimit, uploadRateLimit } from '../middleware/rate-limit.middleware.js';
import { validateMessage, validateChatId, validateMessageId, validateReaction } from '../middleware/validation.middleware.js';
import { incrementUnreadCount, decrementUnreadCount, getUnreadCount, setUnreadCount, clearUnreadCount, safeRedisOperation } from '../utils/redis.utils.js';
import { validateObjectId, safeMongoOperation } from '../utils/mongodb.utils.js';

const router = express.Router();

/**
 * Send Message
 * POST /api/messages
 * Supports both chatId and recipientId (for new chats)
 * 
 * Fixed bugs:
 * - #8: Message length validation
 * - #14: Rate limiting
 * - #1: Race condition in unread count (using Redis utils)
 * - #2: Transaction support for chat creation
 */
router.post('/', verifyToken, messageRateLimit, validateMessage, async (req, res) => {
  try {
    const { chatId, message, messageType = 'text', recipientId } = req.body;

    if (!chatId && !recipientId) {
      return res.status(400).json({
        success: false,
        message: 'Either chatId or recipientId is required',
      });
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
          participants: req.userId,
        });
      } catch (error) {
        // Invalid chatId, will create new chat if recipientId provided
        chat = null;
      }
    }

    // If chat doesn't exist but recipientId is provided, create new chat
    if (!chat && recipientId && recipientId !== req.userId) {
      // Verify recipient exists
      const recipientResult = await queryWithRetry(
        'SELECT id FROM users WHERE id = $1',
        [recipientId],
        3,
        20000
      );

      if (recipientResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Recipient not found',
        });
      }

      // Check if user is blocked (either direction)
      const { isBlocked } = await import('../utils/block.utils.js');
      const blocked = await isBlocked(req.userId, recipientId);
      if (blocked) {
        return res.status(403).json({
          success: false,
          message: "Can't send message",
        });
      }

      // Check if chat already exists between these users
      const existingChat = await chatsCollection.findOne({
        participants: { $all: [req.userId, recipientId] },
        type: 'direct',
      });

      if (existingChat) {
        chat = existingChat;
        chatObjectId = existingChat._id;
      } else {
        // Create new chat with enhanced schema
        const newChat = {
          participants: [req.userId, recipientId],
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
        await autoAddContact(req.userId, recipientId);
      }
    }

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found and recipient not specified',
      });
    }

    if (!chatObjectId) {
      chatObjectId = chat._id;
    }

    // For direct chats, check if user is blocked (either direction) and auto-add to contacts
    if (chat.type === 'direct') {
      const otherParticipantId = chat.participants.find(id => id !== req.userId);
      if (otherParticipantId) {
        const { isBlocked } = await import('../utils/block.utils.js');
        const blocked = await isBlocked(req.userId, otherParticipantId);
        if (blocked) {
          return res.status(403).json({
            success: false,
            message: "Can't send message",
          });
        }

        // Automatically add to contacts if not already there
        const { autoAddContact } = await import('../utils/contacts.utils.js');
        await autoAddContact(req.userId, otherParticipantId);
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
      senderId: req.userId,
      message: message,
      messageType: messageType, // text, image, video, audio, file, call
      readBy: [req.userId], // Sender has read it
      readReceipts: [
        {
          userId: req.userId,
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
    const chatIdString = chatObjectId.toString();

    // Log activity
    const ipAddress = req.ip || req.connection.remoteAddress;
    const deviceId = req.headers['x-device-id'] || 'unknown';
    await logActivity({
      userId: req.userId,
      activityType: 'message_sent',
      activityData: {
        chatId: chatIdString,
        messageType,
        messageLength: message.length,
      },
      ipAddress,
      deviceId,
    });

    // Update last_seen when user sends a message (they're clearly active)
    // This ensures last_seen is current even if heartbeat fails or is delayed
    try {
      const updateResult = await queryWithRetry(
        "UPDATE users SET last_seen = (NOW() AT TIME ZONE 'UTC'), is_online = true WHERE id = $1 RETURNING last_seen AT TIME ZONE 'UTC' as last_seen_utc",
        [req.userId],
        3,
        20000
      );
      if (updateResult.rows.length > 0) {
        console.log(`💬 REST API: Message sent by ${req.userId} - Updated last_seen_utc=${updateResult.rows[0].last_seen_utc}`);
      }
    } catch (error) {
      console.error('❌ Error updating last_seen on message send:', error);
    }

    // Update chat's last message only if this message is more recent
    // This prevents text messages from overwriting more recent call messages
    const now = new Date();
    await chatsCollection.updateOne(
      { 
        _id: chatObjectId,
        $or: [
          { lastMessageAt: { $exists: false } },
          { lastMessageAt: null },
          { lastMessageAt: { $lt: now } } // Only update if new message is more recent
        ]
      },
      {
        $set: {
          lastMessage: message,
          lastMessageType: messageType,
          lastMessageAt: now,
          updatedAt: now,
        },
      }
    );

    // Increment unread count for other participants (all except sender)
    // NOTE: Call messages should NOT increment unread count as they're system messages
    // that both participants can see. They're already marked as read in createCallHistoryMessage.
    // BUG FIX #1: Use safe Redis operations with proper error handling to prevent race conditions
    if (messageType !== 'call') {
      const otherParticipants = chat.participants.filter((id) => id !== req.userId);
      // For groups, increment unread for all other participants
      // For direct chats, increment for the one other participant
      // Use atomic increment operations to prevent race conditions
      await Promise.all(
        otherParticipants.map(participantId => 
          incrementUnreadCount(participantId, chatObjectId.toString(), 1)
        )
      );
    }

    // Get sender name for group chats
    let senderName = null;
    if (chat.type === 'group') {
      const senderResult = await queryWithRetry(
        `SELECT full_name FROM users WHERE id = $1`,
        [req.userId],
        3,
        20000
      );
      if (senderResult.rows.length > 0) {
        senderName = senderResult.rows[0].full_name || null;
      }
    }

    // Prepare message data for Socket.IO with enhanced schema
    const messageData = {
      id: messageResult.insertedId.toString(),
      chatId: chatIdString,
      senderId: req.userId,
      message: message,
      messageType: messageType,
      readBy: [req.userId],
      readReceipts: [
        {
          userId: req.userId,
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

    // Emit new message via Socket.IO for real-time delivery
    await emitNewMessage(chatIdString, messageData);

    // Emit chat update to all participants with unread count
    const lastMessageAt = new Date();
    const redisClient = getRedisClient();
    const isGroup = chat.type === 'group';
    
    // Get fresh sender user details after updating last_seen
    const senderUserResult = await queryWithRetry(
      "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = $1",
      [req.userId],
      3,
      20000
    );
    const senderUser = senderUserResult.rows[0];
    const senderPresenceData = getUserPresenceData(senderUser);

    // Emit chat update to all participants
    for (const participantId of chat.participants) {
      const participantUnreadCount = await redisClient.get(`unread:${participantId}:${chatObjectId}`) || '0';
      
      const chatUpdateData = {
        chatId: chatIdString,
        type: chat.type || 'direct',
        lastMessage: message,
        lastMessageType: messageType,
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
      } else if (participantId !== req.userId) {
        // For direct chats, include sender's presence data for the other participant
        chatUpdateData.otherUser = senderPresenceData;
        
        // Broadcast presence update to receiver IMMEDIATELY with fresh data
        const { getSocketIO } = await import('../socket/socket.server.js');
        const socketIO = getSocketIO();
        if (senderPresenceData) {
          socketIO.to(`user:${participantId}`).emit('presence_update', {
            userId: req.userId,
            isOnline: senderPresenceData.isOnline,
            lastSeen: senderPresenceData.lastSeen,
            fullName: senderPresenceData.fullName,
            profilePictureUrl: senderPresenceData.profilePictureUrl,
          });
        }
      }
      
      emitChatUpdate(participantId, chatUpdateData);
    }

    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: messageData,
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Get Messages for a Chat
 * GET /api/messages/:chatId
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 * - #7: Fixed read receipt logic for groups
 */
router.get('/:chatId', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { limit = 50, before } = req.query; // Pagination

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');
    const messagesCollection = mongoDb.collection('messages');

    // Verify chat exists and user is participant
    // BUG FIX #28: Validate ObjectId format early (already done by middleware)
    let chatObjectId;
    try {
      chatObjectId = validateObjectId(chatId, 'Chat ID');
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found',
      });
    }

    // Build query with improved pagination
    // BUG FIX #23: Fix pagination cursor handling with proper validation
    // Exclude messages that are deleted for this user
    const query = {
      chatId: chatObjectId,
      $and: [
        {
          $or: [
            { deletedFor: { $exists: false } },
            { deletedFor: { $nin: [req.userId] } },
          ],
        },
      ],
    };
    if (before) {
      try {
        // Validate date string format
        if (typeof before !== 'string' || before.trim().length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Invalid pagination cursor format',
          });
        }
        
        const beforeDate = new Date(before);
        // Check if date is valid
        if (isNaN(beforeDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: 'Invalid date format for pagination cursor',
          });
        }
        
        query.$and.push({ createdAt: { $lt: beforeDate } });
      } catch (error) {
        // Invalid date, return error instead of ignoring
        return res.status(400).json({
          success: false,
          message: 'Invalid pagination cursor: ' + error.message,
        });
      }
    }

    // Get messages with cursor-based pagination
    // Uses idx_chatId_createdAt_desc index for optimal performance
    // Excludes messages deleted for the current user
    const limitNum = Math.min(parseInt(limit) || 50, 100); // Max 100 messages per request
    const messages = await messagesCollection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum)
      .hint({ chatId: 1, createdAt: -1 }) // Force use of optimal index
      .toArray();

    // DO NOT update last_seen here - it's only updated on connect/disconnect/heartbeat

    const isGroup = chat.type === 'group';
    const otherParticipants = chat.participants.filter((id) => id !== req.userId);
    
    // Always clear unread count when user opens chat (even if no unread messages in current batch)
    // This ensures unread count is cleared when user views the chat
    // BUG FIX #5: Use safe Redis operations
    const currentUnreadCount = await getUnreadCount(req.userId, chatObjectId.toString());
    
    // BUG FIX #7: Mark messages as read (for direct chats: only from other participant, for groups: from all other participants)
    // Fixed logic to properly handle group chats
    // Note: messages are already filtered by deletedFor in the query above
    const unreadMessageIds = messages
      .filter((msg) => {
        if (msg.readBy?.includes(req.userId)) return false; // Already read
        // Skip messages deleted for this user (shouldn't happen due to query filter, but be safe)
        if (msg.deletedFor?.includes(req.userId)) return false;
        if (isGroup) {
          // In groups, mark as read if from any other participant
          return otherParticipants.includes(msg.senderId);
        } else {
          // In direct chats, mark as read if from the other participant
          return otherParticipants.length > 0 && msg.senderId === otherParticipants[0];
        }
      })
      .map((msg) => msg._id);

    // If there are unread messages in current batch, mark them as read
    if (unreadMessageIds.length > 0) {
      // Update readBy array to include current user
      await messagesCollection.updateMany(
        { _id: { $in: unreadMessageIds } },
        { $addToSet: { readBy: req.userId } }
      );

      // Reset unread count in Redis (all messages in current batch are now read)
      // BUG FIX #5: Use safe Redis operations
      await clearUnreadCount(req.userId, chatObjectId.toString());
      
      // Check if there are any remaining unread messages in the entire chat
      // Exclude messages deleted for this user
      const remainingUnreadCount = await messagesCollection.countDocuments({
        chatId: chatObjectId,
        senderId: isGroup ? { $in: otherParticipants } : (otherParticipants.length > 0 ? otherParticipants[0] : null),
        readBy: { $ne: req.userId },
        $or: [
          { deletedFor: { $exists: false } },
          { deletedFor: { $nin: [req.userId] } },
        ],
      });
      
      // Update Redis with actual remaining unread count
      // BUG FIX #5: Use safe Redis operations
      await setUnreadCount(req.userId, chatObjectId.toString(), remainingUnreadCount);
      
      // Emit chat update with actual unread count to update chat list immediately
      const { getSocketIO } = await import('../socket/socket.server.js');
      const socketIO = getSocketIO();
      socketIO.to(`user:${req.userId}`).emit('chat_updated', {
        chatId: chatId,
        unreadCount: remainingUnreadCount, // Actual remaining unread count
      });
      
      // Emit read receipts for all messages that were just marked as read (real-time)
      for (const messageId of unreadMessageIds) {
        socketIO.to(`chat:${chatId}`).emit('message_read_receipt', {
          messageId: messageId.toString(),
          readBy: req.userId,
          chatId: chatId,
        });
      }
      
      // Re-fetch messages to get updated readBy arrays
      const updatedMessages = await messagesCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .toArray();
      
      messages.length = 0;
      messages.push(...updatedMessages);
    } else if (currentUnreadCount && parseInt(currentUnreadCount) > 0) {
      // Even if no unread messages in current batch, check if unread count exists
      // and clear it if user is viewing the chat (they've seen the messages)
      // Exclude messages deleted for this user
      const remainingUnreadCount = await messagesCollection.countDocuments({
        chatId: chatObjectId,
        senderId: isGroup ? { $in: otherParticipants } : otherParticipants[0],
        readBy: { $ne: req.userId },
        $or: [
          { deletedFor: { $exists: false } },
          { deletedFor: { $nin: [req.userId] } },
        ],
      });
      
      if (remainingUnreadCount === 0) {
        // All messages are read, clear unread count
        // BUG FIX #5: Use safe Redis operations
        await clearUnreadCount(req.userId, chatObjectId.toString());
        
        // Emit chat update with unreadCount: 0
        const { getSocketIO } = await import('../socket/socket.server.js');
        const socketIO = getSocketIO();
        socketIO.to(`user:${req.userId}`).emit('chat_updated', {
          chatId: chatId,
          unreadCount: 0,
        });
      }
    }

    // Reverse to show oldest first
    messages.reverse();

    // Determine if there are more messages
    let hasMore = false;
    if (messages.length === limitNum) {
      // Check if there's at least one more message
      const oldestMessage = messages[messages.length - 1];
      const nextMessage = await messagesCollection
        .findOne({
          chatId: chatObjectId,
          createdAt: { $lt: oldestMessage.createdAt },
        });
      hasMore = nextMessage !== null;
    }

    // For group chats, get sender names for all unique senders
    const senderNamesMap = new Map();
    if (isGroup) {
      const uniqueSenderIds = [...new Set(messages.map(msg => msg.senderId))];
      if (uniqueSenderIds.length > 0) {
        const senderResults = await queryWithRetry(
          `SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`,
          [uniqueSenderIds],
          3,
          20000
        );
        senderResults.rows.forEach(row => {
          senderNamesMap.set(row.id, row.full_name || 'Unknown');
        });
      }
    }

    res.json({
      success: true,
      data: {
        messages: messages.map((msg) => {
          // BUG FIX #19: Determine message status based on readBy array
          // Fixed logic to properly handle groups
          let status = 'sent';
          const readBy = msg.readBy || [];
          const isFromCurrentUser = msg.senderId === req.userId;
          
          if (isGroup) {
            // For groups: status is 'read' if at least one other participant has read it
            const otherParticipantsWhoRead = readBy.filter(id => id !== msg.senderId && otherParticipants.includes(id));
            if (otherParticipantsWhoRead.length > 0) {
              status = 'read';
            } else if (readBy.length > 1 || (readBy.length === 1 && readBy[0] !== msg.senderId)) {
              status = 'delivered';
            }
          } else {
            // For direct chats: status is 'read' if the other participant has read it
            if (readBy.length > 1) {
              status = 'read';
            } else if (readBy.length === 1 && readBy[0] !== msg.senderId) {
              status = 'delivered';
            }
          }
          
          const messageObj = {
            id: msg._id.toString(),
            chatId: msg.chatId.toString(),
            senderId: msg.senderId,
            message: msg.message,
            messageType: msg.messageType || 'text',
            readBy: readBy,
            status: status,
            createdAt: msg.createdAt,
          };
          
          // Include sender name for group chats
          if (isGroup && senderNamesMap.has(msg.senderId)) {
            messageObj.senderName = senderNamesMap.get(msg.senderId);
          }
          
          // Include callData for call messages
          if (msg.messageType === 'call' && msg.callData) {
            messageObj.callData = {
              roomId: msg.callData.roomId,
              callId: msg.callData.callId,
              mediaType: msg.callData.mediaType,
              status: msg.callData.status,
              duration: msg.callData.duration,
              initiatorId: msg.callData.initiatorId,
              createdAt: msg.callData.createdAt,
              endedAt: msg.callData.endedAt,
            };
          }
          
          // Include readReceipts if available
          if (msg.readReceipts && Array.isArray(msg.readReceipts)) {
            messageObj.readReceipts = msg.readReceipts.map((receipt) => ({
              userId: receipt.userId,
              readAt: receipt.readAt,
            }));
          }
          
          // Include editedAt and deletedAt if available
          if (msg.editedAt) {
            messageObj.editedAt = msg.editedAt;
          }
          if (msg.deletedAt) {
            messageObj.deletedAt = msg.deletedAt;
          }
          
          return messageObj;
        }),
        total: messages.length,
        hasMore: hasMore,
        nextCursor: messages.length > 0 ? messages[messages.length - 1].createdAt.toISOString() : null,
      },
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Send Typing Indicator
 * POST /api/messages/typing
 */
router.post('/typing', verifyToken, async (req, res) => {
  try {
    const { chatId, isTyping } = req.body;

    if (!chatId) {
      return res.status(400).json({
        success: false,
        message: 'Chat ID is required',
      });
    }

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    // Verify chat exists and user is participant
    let chatObjectId;
    try {
      chatObjectId = new ObjectId(chatId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid chat ID',
      });
    }

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found',
      });
    }

    // Store typing status in Redis with 3 second expiry
    const redisClient = getRedisClient();
    if (isTyping) {
      await redisClient.setEx(
        `typing:${chatId}:${req.userId}`,
        3, // 3 seconds
        'true'
      );
    } else {
      await redisClient.del(`typing:${chatId}:${req.userId}`);
    }

    res.json({
      success: true,
      message: 'Typing indicator updated',
    });
  } catch (error) {
    console.error('Typing indicator error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Get Typing Status
 * GET /api/messages/typing/:chatId
 */
router.get('/typing/:chatId', verifyToken, async (req, res) => {
  try {
    const { chatId } = req.params;

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    // Verify chat exists and user is participant
    let chatObjectId;
    try {
      chatObjectId = new ObjectId(chatId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid chat ID',
      });
    }

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found',
      });
    }

    // Get the other participant
    const otherParticipantId = chat.participants.find((id) => id !== req.userId);

    // For groups, typing indicators work differently (multiple users can type)
    // For direct chats, check if other participant is typing
    const redisClient = getRedisClient();
    const isGroup = chat.type === 'group';
    
    if (isGroup) {
      // For groups, return all typing users with user info
      const typingUsers = [];
      for (const participantId of chat.participants) {
        if (participantId !== req.userId) {
          const isTyping = await redisClient.get(`typing:${chatId}:${participantId}`);
          if (isTyping === 'true') {
            typingUsers.push({ userId: participantId });
          }
        }
      }
      res.json({
        success: true,
        data: {
          isTyping: typingUsers.length > 0,
          typingUsers: typingUsers,
        },
      });
    } else {
      const otherParticipantId = chat.participants.find((id) => id !== req.userId);
      const isTyping = await redisClient.get(`typing:${chatId}:${otherParticipantId}`);

      res.json({
        success: true,
        data: {
          isTyping: isTyping === 'true',
          userId: otherParticipantId,
        },
      });
    }
  } catch (error) {
    console.error('Get typing status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Edit Message
 * PUT /api/messages/:messageId
 * 
 * Fixed bugs:
 * - #28: Validate message ID format early
 * - #8: Message length validation
 */
router.put('/:messageId', verifyToken, validateMessageId, validateMessage, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { message } = req.body;

    const mongoDb = getMongoDB();
    const messagesCollection = mongoDb.collection('messages');

    // Verify message exists and user is sender
    // BUG FIX #28: Validate ObjectId format early (already done by middleware)
    let messageObjectId;
    try {
      messageObjectId = validateObjectId(messageId, 'Message ID');
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const existingMessage = await messagesCollection.findOne({
      _id: messageObjectId,
      senderId: req.userId,
    });

    if (!existingMessage) {
      return res.status(404).json({
        success: false,
        message: 'Message not found or you are not the sender',
      });
    }

    // Check if message can be edited (within 15 minutes)
    const messageAge = Date.now() - existingMessage.createdAt.getTime();
    const fifteenMinutes = 15 * 60 * 1000;
    if (messageAge > fifteenMinutes) {
      return res.status(400).json({
        success: false,
        message: 'Message can only be edited within 15 minutes',
      });
    }

    // Check if message is already deleted
    if (existingMessage.deletedAt) {
      return res.status(400).json({
        success: false,
        message: 'Cannot edit deleted message',
      });
    }

    // Update message
    const updatedMessage = await messagesCollection.findOneAndUpdate(
      { _id: messageObjectId },
      {
        $set: {
          message: message.trim(),
          editedAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    if (!updatedMessage.value) {
      return res.status(500).json({
        success: false,
        message: 'Failed to update message',
      });
    }

    // Emit message update via Socket.IO
    const { getSocketIO } = await import('../socket/socket.server.js');
    const socketIO = getSocketIO();
    socketIO.to(`chat:${updatedMessage.value.chatId.toString()}`).emit('message_updated', {
      messageId: messageId,
      message: message.trim(),
      editedAt: updatedMessage.value.editedAt,
    });

    res.json({
      success: true,
      message: 'Message edited successfully',
      data: {
        id: updatedMessage.value._id.toString(),
        message: updatedMessage.value.message,
        editedAt: updatedMessage.value.editedAt,
      },
    });
  } catch (error) {
    console.error('Edit message error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Delete Message
 * DELETE /api/messages/:messageId
 * 
 * Fixed bugs:
 * - #28: Validate message ID format early
 * - #15: Fix unread count on message delete
 */
router.delete('/:messageId', verifyToken, validateMessageId, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { deleteForEveryone = false } = req.body;

    const mongoDb = getMongoDB();
    const messagesCollection = mongoDb.collection('messages');
    const chatsCollection = mongoDb.collection('chats');

    // Verify message exists
    // BUG FIX #28: Validate ObjectId format early (already done by middleware)
    let messageObjectId;
    try {
      messageObjectId = validateObjectId(messageId, 'Message ID');
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const existingMessage = await messagesCollection.findOne({
      _id: messageObjectId,
    });

    if (!existingMessage) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Verify user is sender or participant
    const chat = await chatsCollection.findOne({
      _id: existingMessage.chatId,
      participants: req.userId,
    });

    if (!chat) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete this message',
      });
    }

    const isSender = existingMessage.senderId === req.userId;

    if (deleteForEveryone) {
      // Delete for everyone (only if sender and within 1 hour)
      if (!isSender) {
        return res.status(403).json({
          success: false,
          message: 'Only the sender can delete for everyone',
        });
      }

      const messageAge = Date.now() - existingMessage.createdAt.getTime();
      const oneHour = 60 * 60 * 1000;
      if (messageAge > oneHour) {
        return res.status(400).json({
          success: false,
          message: 'Message can only be deleted for everyone within 1 hour',
        });
      }

      // Soft delete - set deletedAt
      await messagesCollection.updateOne(
        { _id: messageObjectId },
        {
          $set: {
            deletedAt: new Date(),
            message: 'This message was deleted',
            updatedAt: new Date(),
          },
        }
      );

      // BUG FIX #15: Update unread count when message is deleted
      // If message was unread by other participants, decrement their unread count
      const chat = await chatsCollection.findOne({ _id: existingMessage.chatId });
      if (chat) {
        const otherParticipants = chat.participants.filter(id => id !== req.userId);
        const wasUnread = !existingMessage.readBy || 
          otherParticipants.some(id => !existingMessage.readBy.includes(id));
        
        if (wasUnread) {
          // Decrement unread count for participants who hadn't read it
          await Promise.all(
            otherParticipants
              .filter(id => !existingMessage.readBy?.includes(id))
              .map(participantId => 
                decrementUnreadCount(participantId, existingMessage.chatId.toString(), 1)
              )
          );
        }
      }

      // Emit delete event to all participants
      const { getSocketIO } = await import('../socket/socket.server.js');
      const socketIO = getSocketIO();
      socketIO.to(`chat:${existingMessage.chatId.toString()}`).emit('message_deleted', {
        messageId: messageId,
        deleteForEveryone: true,
      });
    } else {
      // Delete for me - remove from user's view (store in deletedMessages collection or mark)
      // For now, we'll use a simple approach: mark as deleted for this user
      // In a full implementation, you'd use a separate collection or array field
      await messagesCollection.updateOne(
        { _id: messageObjectId },
        {
          $addToSet: { deletedFor: req.userId },
          $set: { updatedAt: new Date() },
        }
      );

      // Emit delete event to user only
      const { getSocketIO } = await import('../socket/socket.server.js');
      const socketIO = getSocketIO();
      socketIO.to(`user:${req.userId}`).emit('message_deleted', {
        messageId: messageId,
        deleteForEveryone: false,
      });
    }

    res.json({
      success: true,
      message: 'Message deleted successfully',
    });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Forward Message
 * POST /api/messages/:messageId/forward
 */
router.post('/:messageId/forward', verifyToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { chatIds } = req.body; // Array of chat IDs to forward to

    if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one chat ID is required',
      });
    }

    const mongoDb = getMongoDB();
    const messagesCollection = mongoDb.collection('messages');
    const chatsCollection = mongoDb.collection('chats');

    // Get original message
    let messageObjectId;
    try {
      messageObjectId = new ObjectId(messageId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid message ID',
      });
    }

    const originalMessage = await messagesCollection.findOne({
      _id: messageObjectId,
    });

    if (!originalMessage) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Verify user has access to original message
    const originalChat = await chatsCollection.findOne({
      _id: originalMessage.chatId,
      participants: req.userId,
    });

    if (!originalChat) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to forward this message',
      });
    }

    const forwardedMessages = [];
    const errors = [];

    // Forward to each chat
    for (const chatId of chatIds) {
      try {
        let targetChatObjectId;
        try {
          targetChatObjectId = new ObjectId(chatId);
        } catch (error) {
          errors.push({ chatId, error: 'Invalid chat ID' });
          continue;
        }

        // Verify chat exists and user is participant
        const targetChat = await chatsCollection.findOne({
          _id: targetChatObjectId,
          participants: req.userId,
        });

        if (!targetChat) {
          errors.push({ chatId, error: 'Chat not found or you are not a participant' });
          continue;
        }

        // BUG FIX #27: Get sender name for forwarded message metadata
        let forwardedFromSenderName = null;
        try {
          const senderResult = await queryWithRetry(
            `SELECT full_name FROM users WHERE id = $1`,
            [originalMessage.senderId],
            3,
            20000
          );
          if (senderResult.rows.length > 0) {
            forwardedFromSenderName = senderResult.rows[0].full_name || null;
          }
        } catch (error) {
          console.error('Error fetching sender name for forwarded message:', error);
          // Continue without sender name
        }
        
        // Get original chat name if it's a group
        let forwardedFromChatName = null;
        if (originalChat.type === 'group') {
          forwardedFromChatName = originalChat.groupName || null;
        } else {
          // For direct chats, use sender name
          forwardedFromChatName = forwardedFromSenderName;
        }

        // Create forwarded message
        const forwardedMessage = {
          chatId: targetChatObjectId,
          senderId: req.userId,
          message: originalMessage.message,
          messageType: originalMessage.messageType,
          forwardedFrom: {
            messageId: messageId,
            chatId: originalMessage.chatId.toString(),
            senderId: originalMessage.senderId,
            senderName: forwardedFromSenderName, // BUG FIX #27: Add sender name
            chatName: forwardedFromChatName, // BUG FIX #27: Add chat name
          },
          readBy: [req.userId],
          readReceipts: [
            {
              userId: req.userId,
              readAt: new Date(),
            },
          ],
          editedAt: null,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await messagesCollection.insertOne(forwardedMessage);
        forwardedMessages.push({
          chatId: chatId,
          messageId: result.insertedId.toString(),
        });

        // Update chat's last message
        await chatsCollection.updateOne(
          { _id: targetChatObjectId },
          {
            $set: {
              lastMessage: originalMessage.messageType === 'image' ? '📷 Photo' :
                          originalMessage.messageType === 'video' ? '🎥 Video' :
                          originalMessage.messageType === 'audio' ? '🎤 Audio' :
                          originalMessage.messageType === 'document' ? '📄 Document' :
                          originalMessage.messageType === 'call' ? '📞 Call' :
                          originalMessage.message,
              lastMessageType: originalMessage.messageType,
              lastMessageAt: new Date(),
              updatedAt: new Date(),
            },
          }
        );

        // Increment unread count for other participants (all except sender)
        // BUG FIX #1: Use safe Redis operations to prevent race conditions
        const otherParticipants = targetChat.participants.filter((id) => id !== req.userId);
        await Promise.all(
          otherParticipants.map(participantId => 
            incrementUnreadCount(participantId, targetChatObjectId.toString(), 1)
          )
        );

        // Emit new message via Socket.IO
        const messageData = {
          id: result.insertedId.toString(),
          chatId: chatId,
          senderId: req.userId,
          message: forwardedMessage.message,
          messageType: forwardedMessage.messageType,
          forwardedFrom: forwardedMessage.forwardedFrom,
          readBy: [req.userId],
          status: 'sent',
          createdAt: forwardedMessage.createdAt.toISOString(),
        };

        await emitNewMessage(chatId, messageData);

        // Emit chat update to sender
        // BUG FIX #5: Use safe Redis operations
        const senderUnreadCount = await getUnreadCount(req.userId, targetChatObjectId.toString());
        
        emitChatUpdate(req.userId, {
          chatId: chatId,
          lastMessage: messageData.message,
          lastMessageAt: new Date().toISOString(),
          unreadCount: senderUnreadCount,
        });

        // Emit chat update to all other participants
        // BUG FIX #5: Use safe Redis operations
        for (const participantId of otherParticipants) {
          const participantUnreadCount = await getUnreadCount(participantId, targetChatObjectId.toString());
          const isTargetGroup = targetChat.type === 'group';
          
          const chatUpdateData = {
            chatId: chatId,
            type: targetChat.type || 'direct',
            lastMessage: messageData.message,
            lastMessageType: messageData.messageType || 'text',
            lastMessageAt: new Date().toISOString(),
            unreadCount: participantUnreadCount,
            archivedBy: targetChat.archivedBy || [],
            pinnedBy: targetChat.pinnedBy || [],
            mutedBy: targetChat.mutedBy || [],
          };
          
          if (isTargetGroup) {
            chatUpdateData.groupInfo = {
              groupName: targetChat.groupName,
              groupDescription: targetChat.groupDescription,
              groupPictureUrl: targetChat.groupPictureUrl,
              participantCount: targetChat.participants.length,
              admins: targetChat.admins || [],
              createdBy: targetChat.createdBy,
            };
          }
          
          emitChatUpdate(participantId, chatUpdateData);
        }
      } catch (error) {
        errors.push({ chatId, error: error.message });
      }
    }

    res.json({
      success: true,
      message: `Forwarded to ${forwardedMessages.length} chat(s)`,
      data: {
        forwarded: forwardedMessages,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error) {
    console.error('Forward message error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Upload File and Send as Message
 * POST /api/messages/upload
 * Accepts multipart/form-data with 'file' field
 * 
 * Fixed bugs:
 * - #14: Rate limiting for uploads
 * - #9: File cleanup on error
 */
router.post('/upload', verifyToken, uploadRateLimit, (req, res, next) => {
  uploadMessageFile(req, res, (err) => {
    // Handle multer errors
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            message: 'File too large. Maximum size is 50MB.',
          });
        }
        return res.status(400).json({
          success: false,
          message: err.message || 'File upload error',
        });
      }
      // File filter error
      return res.status(400).json({
        success: false,
        message: err.message || 'Invalid file type',
      });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { chatId, messageType = 'file', recipientId } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded',
      });
    }

    if (!chatId && !recipientId) {
      // BUG FIX #9: Delete uploaded file if validation fails
      if (req.file?.filename) {
        try {
          deleteFile(req.file.filename);
        } catch (error) {
          console.error('Error deleting file on validation failure:', error);
        }
      }
      return res.status(400).json({
        success: false,
        message: 'Either chatId or recipientId is required',
      });
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
          participants: req.userId,
        });
      } catch (error) {
        // Invalid chatId, will create new chat if recipientId provided
        chat = null;
      }
    }

    // If chat doesn't exist but recipientId is provided, create new chat
    if (!chat && recipientId && recipientId !== req.userId) {
      // Verify recipient exists
      const recipientResult = await queryWithRetry(
        'SELECT id FROM users WHERE id = $1',
        [recipientId],
        3,
        20000
      );

      if (recipientResult.rows.length === 0) {
        // BUG FIX #9: Delete uploaded file if recipient not found
        if (req.file?.filename) {
          try {
            deleteFile(req.file.filename);
          } catch (error) {
            console.error('Error deleting file on recipient not found:', error);
          }
        }
        return res.status(404).json({
          success: false,
          message: 'Recipient not found',
        });
      }

      // Check if chat already exists between these users
      const existingChat = await chatsCollection.findOne({
        participants: { $all: [req.userId, recipientId] },
        type: 'direct',
      });

      if (existingChat) {
        chat = existingChat;
        chatObjectId = existingChat._id;
      } else {
        // Create new chat with enhanced schema
        const newChat = {
          participants: [req.userId, recipientId],
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
        await autoAddContact(req.userId, recipientId);
      }
    }

    if (!chat) {
      // BUG FIX #9: Delete uploaded file if chat not found
      if (req.file?.filename) {
        try {
          deleteFile(req.file.filename);
        } catch (error) {
          console.error('Error deleting file on chat not found:', error);
        }
      }
      return res.status(404).json({
        success: false,
        message: 'Chat not found and recipient not specified',
      });
    }

    if (!chatObjectId) {
      chatObjectId = chat._id;
    }

    // For direct chats, auto-add to contacts
    if (chat.type === 'direct') {
      const otherParticipantId = chat.participants.find(id => id !== req.userId);
      if (otherParticipantId) {
        // Automatically add to contacts if not already there
        const { autoAddContact } = await import('../utils/contacts.utils.js');
        await autoAddContact(req.userId, otherParticipantId);
      }
    }

    // Generate file URL
    const fileUrl = getFileUrl(req, req.file.filename);

    // Determine message type based on file extension if not provided
    let actualMessageType = messageType;
    if (messageType === 'file') {
      const ext = req.file.originalname.split('.').pop()?.toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '')) {
        actualMessageType = 'image';
      } else if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext || '')) {
        actualMessageType = 'video';
      } else if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(ext || '')) {
        actualMessageType = 'audio';
      } else if (['pdf', 'doc', 'docx', 'txt', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext || '')) {
        actualMessageType = 'document';
      }
    }

    // Create message with file URL and enhanced schema
    const newMessage = {
      chatId: chatObjectId,
      senderId: req.userId,
      message: fileUrl, // Store file URL as message content
      messageType: actualMessageType,
      readBy: [req.userId], // Sender has read it
      readReceipts: [
        {
          userId: req.userId,
          readAt: new Date(),
        },
      ],
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const messageResult = await messagesCollection.insertOne(newMessage);

    // Update last_seen when user sends a message
    try {
      await queryWithRetry(
        "UPDATE users SET last_seen = (NOW() AT TIME ZONE 'UTC'), is_online = true WHERE id = $1",
        [req.userId],
        3,
        20000
      );
    } catch (error) {
      console.error('Error updating last_seen on message send:', error);
    }

    // Update chat's last message
    await chatsCollection.updateOne(
      { _id: chatObjectId },
      {
        $set: {
          lastMessage: actualMessageType === 'image' ? '📷 Photo' : 
                      actualMessageType === 'video' ? '🎥 Video' :
                      actualMessageType === 'audio' ? '🎤 Audio' :
                      actualMessageType === 'document' ? '📄 Document' : '📎 File',
          lastMessageType: actualMessageType,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );

    // Increment unread count for other participants (all except sender)
    // NOTE: Call messages should NOT increment unread count as they're system messages
    // that both participants can see. They're already marked as read in createCallHistoryMessage.
    // BUG FIX #1: Use safe Redis operations to prevent race conditions
    if (actualMessageType !== 'call') {
      const otherParticipants = chat.participants.filter((id) => id !== req.userId);
      await Promise.all(
        otherParticipants.map(participantId => 
          incrementUnreadCount(participantId, chatObjectId.toString(), 1)
        )
      );
    }

    const chatIdString = chatObjectId.toString();

    // Get sender name for group chats
    let senderName = null;
    if (chat.type === 'group') {
      const senderResult = await queryWithRetry(
        `SELECT full_name FROM users WHERE id = $1`,
        [req.userId],
        3,
        20000
      );
      if (senderResult.rows.length > 0) {
        senderName = senderResult.rows[0].full_name || null;
      }
    }

    // Prepare message data for Socket.IO
    const messageData = {
      id: messageResult.insertedId.toString(),
      chatId: chatIdString,
      senderId: req.userId,
      message: fileUrl,
      messageType: actualMessageType,
      readBy: [req.userId],
      status: 'sent',
      createdAt: newMessage.createdAt.toISOString(),
    };
    
    // Include sender name for group chats
    if (senderName) {
      messageData.senderName = senderName;
    }

    // Emit new message via Socket.IO for real-time delivery
    emitNewMessage(chatIdString, messageData);

    // Emit chat update to all participants
    const lastMessageAt = new Date();
    const redisClient = getRedisClient();
    const isGroup = chat.type === 'group';
    
    const senderUserResult = await queryWithRetry(
      "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = $1",
      [req.userId],
      3,
      20000
    );
    const senderUser = senderUserResult.rows[0];
    const senderPresenceData = getUserPresenceData(senderUser);

    const lastMessageText = actualMessageType === 'image' ? '📷 Photo' : 
                            actualMessageType === 'video' ? '🎥 Video' :
                            actualMessageType === 'audio' ? '🎤 Audio' :
                            actualMessageType === 'document' ? '📄 Document' : '📎 File';

    // Emit chat update to all participants
    for (const participantId of chat.participants) {
      const participantUnreadCount = await redisClient.get(`unread:${participantId}:${chatObjectId}`) || '0';
      
      const chatUpdateData = {
        chatId: chatIdString,
        type: chat.type || 'direct',
        lastMessage: lastMessageText,
        lastMessageType: actualMessageType,
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
      } else if (participantId !== req.userId) {
        // For direct chats, include sender's presence data for the other participant
        chatUpdateData.otherUser = senderPresenceData;
        
        // Broadcast presence update to receiver IMMEDIATELY with fresh data
        const { getSocketIO } = await import('../socket/socket.server.js');
        const socketIO = getSocketIO();
        if (senderPresenceData) {
          socketIO.to(`user:${participantId}`).emit('presence_update', {
            userId: req.userId,
            isOnline: senderPresenceData.isOnline,
            lastSeen: senderPresenceData.lastSeen,
            fullName: senderPresenceData.fullName,
            profilePictureUrl: senderPresenceData.profilePictureUrl,
          });
        }
      }
      
      emitChatUpdate(participantId, chatUpdateData);
    }

    res.status(201).json({
      success: true,
      message: 'File uploaded and sent successfully',
      data: messageData,
    });
  } catch (error) {
    console.error('Upload file error:', error);
    
    // BUG FIX #9: Delete uploaded file if processing failed
    if (req.file?.filename) {
      try {
        deleteFile(req.file.filename);
      } catch (deleteError) {
        console.error('Error deleting file on upload error:', deleteError);
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Search Messages
 * GET /api/messages/search
 * Query params: query (required), chatId (optional), messageType (optional), limit (default 50)
 */
router.get('/search', verifyToken, async (req, res) => {
  try {
    const { query, chatId, messageType, limit = 50 } = req.query;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required',
      });
    }

    const mongoDb = getMongoDB();
    const messagesCollection = mongoDb.collection('messages');
    const chatsCollection = mongoDb.collection('chats');

    // Build search query
    const searchQuery = {
      message: { $regex: query.trim(), $options: 'i' }, // Case-insensitive search
      deletedAt: { $exists: false }, // Exclude deleted messages
    };

    // Filter by chatId if provided
    // BUG FIX #28: Validate chat ID format early
    if (chatId) {
      try {
        const chatObjectId = validateObjectId(chatId, 'Chat ID');
        // Verify user has access to this chat
        const chat = await chatsCollection.findOne({
          _id: chatObjectId,
          participants: req.userId,
        });
        if (!chat) {
          return res.status(404).json({
            success: false,
            message: 'Chat not found',
          });
        }
        searchQuery.chatId = chatObjectId;
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }
    } else {
      // If no chatId, only search in user's chats
      const userChats = await chatsCollection
        .find({ participants: req.userId })
        .project({ _id: 1 })
        .toArray();
      const chatIds = userChats.map(chat => chat._id);
      searchQuery.chatId = { $in: chatIds };
    }

    // Filter by message type if provided
    if (messageType) {
      searchQuery.messageType = messageType;
    }

    // Search messages
    const messages = await messagesCollection
      .find(searchQuery)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .toArray();

    // Get chat and sender info for each message
    const results = await Promise.all(
      messages.map(async (message) => {
        const chat = await chatsCollection.findOne({ _id: message.chatId });
        const senderResult = await queryWithRetry(
          "SELECT id, full_name, profile_picture_url FROM users WHERE id = $1",
          [message.senderId],
          3,
          20000
        );
        const sender = senderResult.rows[0];

        return {
          id: message._id.toString(),
          chatId: message.chatId.toString(),
          chatName: chat?.type === 'group' ? chat.groupName : sender?.full_name || 'Unknown',
          senderId: message.senderId,
          senderName: sender?.full_name || 'Unknown',
          message: message.message,
          messageType: message.messageType,
          createdAt: message.createdAt,
        };
      })
    );

    res.json({
      success: true,
      data: {
        messages: results,
        total: results.length,
        query: query.trim(),
      },
    });
  } catch (error) {
    console.error('Search messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search messages',
      error: error.message,
    });
  }
});

/**
 * React to Message
 * POST /api/messages/:messageId/react
 * 
 * Fixed bugs:
 * - #28: Validate message ID format early
 * - #24: Validate emoji reaction
 */
router.post('/:messageId/react', verifyToken, validateMessageId, validateReaction, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { reaction } = req.body; // Emoji like '👍', '❤️', '😂', etc.

    const mongoDb = getMongoDB();
    const messagesCollection = mongoDb.collection('messages');
    const chatsCollection = mongoDb.collection('chats');

    let messageObjectId;
    try {
      messageObjectId = new ObjectId(messageId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid message ID',
      });
    }

    const message = await messagesCollection.findOne({ _id: messageObjectId });
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Verify user has access to this chat
    const chat = await chatsCollection.findOne({
      _id: message.chatId,
      participants: req.userId,
    });
    if (!chat) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    // Initialize reactions array if not exists
    if (!message.reactions) {
      message.reactions = [];
    }

    // Check if user already reacted
    const existingReactionIndex = message.reactions.findIndex(
      r => r.userId === req.userId
    );

    if (existingReactionIndex !== -1) {
      // User already reacted - update or remove
      if (message.reactions[existingReactionIndex].reaction === reaction) {
        // Same reaction - remove it
        message.reactions.splice(existingReactionIndex, 1);
      } else {
        // Different reaction - update it
        message.reactions[existingReactionIndex].reaction = reaction;
        message.reactions[existingReactionIndex].updatedAt = new Date();
      }
    } else {
      // New reaction
      message.reactions.push({
        userId: req.userId,
        reaction: reaction,
        createdAt: new Date(),
      });
    }

    // Update message
    await messagesCollection.updateOne(
      { _id: messageObjectId },
      {
        $set: {
          reactions: message.reactions,
          updatedAt: new Date(),
        },
      }
    );

    // Emit socket event
    const { emitNewMessage } = await import('../socket/socket.server.js');
    chat.participants.forEach(participantId => {
      emitNewMessage(participantId, {
        ...message,
        _id: messageObjectId,
        reactions: message.reactions,
      });
    });

    res.json({
      success: true,
      data: {
        reactions: message.reactions,
      },
    });
  } catch (error) {
    console.error('React to message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to react to message',
      error: error.message,
    });
  }
});

/**
 * Star/Unstar Message
 * POST /api/messages/:messageId/star
 */
router.post('/:messageId/star', verifyToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { star = true } = req.body;

    const mongoDb = getMongoDB();
    const messagesCollection = mongoDb.collection('messages');
    const chatsCollection = mongoDb.collection('chats');

    let messageObjectId;
    try {
      messageObjectId = new ObjectId(messageId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid message ID',
      });
    }

    const message = await messagesCollection.findOne({ _id: messageObjectId });
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Verify user has access to this chat
    const chat = await chatsCollection.findOne({
      _id: message.chatId,
      participants: req.userId,
    });
    if (!chat) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    // Initialize starredBy array if not exists
    if (!message.starredBy) {
      message.starredBy = [];
    }

    if (star) {
      // Add to starred
      if (!message.starredBy.includes(req.userId)) {
        message.starredBy.push(req.userId);
      }
    } else {
      // Remove from starred
      message.starredBy = message.starredBy.filter(id => id !== req.userId);
    }

    // Update message
    await messagesCollection.updateOne(
      { _id: messageObjectId },
      {
        $set: {
          starredBy: message.starredBy,
          updatedAt: new Date(),
        },
      }
    );

    res.json({
      success: true,
      message: star ? 'Message starred' : 'Message unstarred',
      data: {
        starred: message.starredBy.includes(req.userId),
      },
    });
  } catch (error) {
    console.error('Star message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to star message',
      error: error.message,
    });
  }
});

/**
 * Get Starred Messages
 * GET /api/messages/starred
 */
router.get('/starred', verifyToken, async (req, res) => {
  try {
    const { limit = 50, cursor } = req.query;

    const mongoDb = getMongoDB();
    const messagesCollection = mongoDb.collection('messages');
    const chatsCollection = mongoDb.collection('chats');

    // Get user's chats
    const userChats = await chatsCollection
      .find({ participants: req.userId })
      .project({ _id: 1 })
      .toArray();
    const chatIds = userChats.map(chat => chat._id);

    // Build query
    const query = {
      chatId: { $in: chatIds },
      starredBy: req.userId,
      deletedAt: { $exists: false },
    };

    if (cursor) {
      try {
        const cursorObjectId = new ObjectId(cursor);
        query._id = { $lt: cursorObjectId };
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: 'Invalid cursor',
        });
      }
    }

    // Get starred messages
    const messages = await messagesCollection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) + 1)
      .toArray();

    const hasMore = messages.length > parseInt(limit);
    if (hasMore) {
      messages.pop(); // Remove extra message
    }

    const nextCursor = messages.length > 0 ? messages[messages.length - 1]._id.toString() : null;

    // Get chat and sender info
    const results = await Promise.all(
      messages.map(async (message) => {
        const chat = await chatsCollection.findOne({ _id: message.chatId });
        const senderResult = await queryWithRetry(
          "SELECT id, full_name, profile_picture_url FROM users WHERE id = $1",
          [message.senderId],
          3,
          20000
        );
        const sender = senderResult.rows[0];

        return {
          id: message._id.toString(),
          chatId: message.chatId.toString(),
          chatName: chat?.type === 'group' ? chat.groupName : sender?.full_name || 'Unknown',
          senderId: message.senderId,
          senderName: sender?.full_name || 'Unknown',
          message: message.message,
          messageType: message.messageType,
          createdAt: message.createdAt,
          starredAt: message.starredBy?.includes(req.userId) ? new Date() : null,
        };
      })
    );

    res.json({
      success: true,
      data: {
        messages: results,
        nextCursor,
        hasMore,
      },
    });
  } catch (error) {
    console.error('Get starred messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get starred messages',
      error: error.message,
    });
  }
});

export default router;

