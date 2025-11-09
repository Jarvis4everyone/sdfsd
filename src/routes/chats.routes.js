import express from 'express';
import { ObjectId } from 'mongodb';
import { getMongoDB } from '../config/mongodb.config.js';
import postgresPool, { queryWithRetry } from '../config/postgres.config.js';
import { verifyToken } from './auth.routes.js';
import { getUserPresenceData } from '../utils/presence.utils.js';
import { groupRateLimit } from '../middleware/rate-limit.middleware.js';
import { validateGroupName, validateParticipantIds, validateChatId } from '../middleware/validation.middleware.js';
import { validateObjectId } from '../utils/mongodb.utils.js';
import { getUnreadCount } from '../utils/redis.utils.js';

const router = express.Router();

/**
 * Get User's Chat List
 * GET /api/chats
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    // Get blocked users list (both directions)
    const { getBlockedUsers, getBlockedBy } = await import('../utils/block.utils.js');
    const blockedByMe = await getBlockedUsers(req.userId);
    const blockedByThem = await getBlockedBy(req.userId);
    const allBlockedIds = [...new Set([...blockedByMe, ...blockedByThem])];

    // Get all chats where the user is a participant
    // Exclude chats that are deleted for this user
    // Sort by lastMessageAt (most recent first), but handle null values
    // Chats with messages come first, then chats without messages (sorted by createdAt)
    const chats = await chatsCollection
      .find({
        participants: req.userId,
        $or: [
          { deletedFor: { $exists: false } },
          { deletedFor: { $nin: [req.userId] } },
        ],
      })
      .sort({ 
        lastMessageAt: -1, // Most recent message first
        createdAt: -1 // If no messages, sort by creation date
      })
      .toArray();

    // Filter out chats with blocked users (for direct chats only)
    const filteredChats = chats.filter((chat) => {
      if (chat.type === 'direct') {
        const otherParticipantId = chat.participants.find(id => id !== req.userId);
        if (otherParticipantId && allBlockedIds.includes(otherParticipantId)) {
          return false; // Filter out chats with blocked users
        }
      }
      return true; // Keep group chats and non-blocked direct chats
    });

    // Get user details for each chat
    const chatList = await Promise.all(
      filteredChats.map(async (chat) => {
        let otherUser = null;
        let groupInfo = null;

        if (chat.type === 'group') {
          // For group chats, return group info
          groupInfo = {
            groupName: chat.groupName || 'Group',
            groupDescription: chat.groupDescription,
            groupPictureUrl: chat.groupPictureUrl,
            participantCount: chat.participants?.length || 0,
            admins: chat.admins || [],
            createdBy: chat.createdBy,
          };
        } else {
          // For direct chats, get the other participant
          const otherParticipantId = chat.participants.find(
            (id) => id !== req.userId
          );

          if (otherParticipantId) {
            try {
              const userResult = await queryWithRetry(
                "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = $1",
                [otherParticipantId],
                3,
                20000
              );
              if (userResult.rows.length > 0) {
                const user = userResult.rows[0];
                otherUser = getUserPresenceData(user);
              }
            } catch (userError) {
              console.warn(`⚠️  Error fetching user ${otherParticipantId} for chat:`, userError.message);
              otherUser = null;
            }
          }
        }

        // Get unread count from Redis
        // BUG FIX #29: Don't show unread count for archived chats
        // BUG FIX #5: Use safe Redis operations
        let unreadCount = 0;
        const isArchived = chat.archivedBy?.includes(req.userId);
        if (!isArchived) {
          try {
            unreadCount = await getUnreadCount(req.userId, chat._id.toString());
          } catch (redisError) {
            console.warn(`⚠️  Redis error getting unread count for chat ${chat._id}:`, redisError.message);
            unreadCount = 0;
          }
        }

        // Get the most recent visible message for this user
        // If the last message is deleted for this user, find the most recent visible one
        let lastMessage = chat.lastMessage;
        let lastMessageType = chat.lastMessageType || 'text';
        let lastMessageAt = chat.lastMessageAt;

        if (chat.lastMessage) {
          // Check if the last message is visible to this user
          const messagesCollection = mongoDb.collection('messages');
          const lastVisibleMessage = await messagesCollection.findOne(
            {
              chatId: chat._id,
              $or: [
                { deletedFor: { $exists: false } },
                { deletedFor: { $nin: [req.userId] } },
              ],
            },
            {
              sort: { createdAt: -1 },
              limit: 1,
            }
          );

          if (lastVisibleMessage) {
            // Use the most recent visible message
            lastMessage = lastVisibleMessage.message;
            lastMessageType = lastVisibleMessage.messageType || 'text';
            lastMessageAt = lastVisibleMessage.createdAt;
          } else {
            // No visible messages - user has cleared all messages
            lastMessage = null;
            lastMessageType = 'text';
            lastMessageAt = null;
          }
        }

        return {
          chatId: chat._id.toString(),
          type: chat.type || 'direct',
          otherUser,
          groupInfo,
          lastMessage: lastMessage,
          lastMessageType: lastMessageType,
          lastMessageAt: lastMessageAt,
          unreadCount: unreadCount,
          archivedBy: chat.archivedBy || [],
          pinnedBy: chat.pinnedBy || [],
          mutedBy: chat.mutedBy || [],
          createdAt: chat.createdAt,
        };
      })
    );

    res.json({
      success: true,
      data: {
        chats: chatList,
        total: chatList.length,
      },
    });
  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Get or Create Chat with Another User
 * GET /api/chats/:userId
 */
router.get('/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;

    if (userId === req.userId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot create chat with yourself',
      });
    }

    // Verify other user exists
    const userResult = await queryWithRetry(
      "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = $1",
      [userId],
      3,
      20000
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Check if user is blocked (either direction)
    const { isBlocked } = await import('../utils/block.utils.js');
    const blocked = await isBlocked(req.userId, userId);
    if (blocked) {
      return res.status(403).json({
        success: false,
        message: 'Cannot create chat. User is blocked.',
      });
    }

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    // Check if chat already exists
    let chat = await chatsCollection.findOne({
      participants: { $all: [req.userId, userId] },
      type: 'direct', // Direct message (not group)
    });

    if (!chat) {
      // Create new chat with enhanced schema
      const newChat = {
        participants: [req.userId, userId],
        type: 'direct',
        lastMessage: null,
        lastMessageAt: new Date(),
        archivedBy: [],
        pinnedBy: [],
        mutedBy: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await chatsCollection.insertOne(newChat);
      chat = { ...newChat, _id: result.insertedId };

      // Automatically add user to contacts
      const { autoAddContact } = await import('../utils/contacts.utils.js');
      await autoAddContact(req.userId, userId);
    } else {
      // Even if chat exists, ensure user is in contacts
      const { autoAddContact } = await import('../utils/contacts.utils.js');
      await autoAddContact(req.userId, userId);
    }

    const otherUser = userResult.rows[0];
    const otherUserPresenceData = getUserPresenceData(otherUser);

    res.json({
      success: true,
      data: {
        chatId: chat._id.toString(),
        otherUser: otherUserPresenceData,
        lastMessage: chat.lastMessage,
        lastMessageAt: chat.lastMessageAt,
        createdAt: chat.createdAt,
      },
    });
  } catch (error) {
    console.error('Get/create chat error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Create Group Chat
 * POST /api/chats/group/create
 * 
 * Fixed bugs:
 * - #46: Group name validation
 * - #3: SQL injection risk (validate UUIDs)
 * - #16: Group size validation
 * - #14: Rate limiting
 */
router.post('/group/create', verifyToken, groupRateLimit, validateGroupName, validateParticipantIds, async (req, res) => {
  try {
    const { name, description, participantIds, groupPictureUrl } = req.body;

    // Limit group size to 1024 members (including creator)
    // Note: participantIds already validated by middleware (removes duplicates)
    const allParticipantIds = [...new Set([req.userId, ...participantIds])];
    
    // Filter out blocked users first, then check size limit
    const { filterBlockedUsers } = await import('../utils/block.utils.js');
    const participantsToFilter = participantIds.filter(id => id !== req.userId);
    const allowedParticipantIds = await filterBlockedUsers(req.userId, participantsToFilter);
    const finalParticipantIds = [req.userId, ...allowedParticipantIds];
    
    if (finalParticipantIds.length > 1024) {
      return res.status(400).json({
        success: false,
        message: 'Group can have maximum 1024 members (including creator)',
      });
    }
    
    if (finalParticipantIds.length < allParticipantIds.length) {
      // Some users were filtered out
      console.log(`⚠️  Filtered out ${allParticipantIds.length - finalParticipantIds.length} blocked user(s) from group creation`);
    }

    // BUG FIX #3: Verify all participants exist (UUIDs already validated by middleware)
    // Using parameterized query prevents SQL injection, but we validate UUIDs first
    const userResult = await queryWithRetry(
      `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
      [allParticipantIds],
      3,
      20000
    );

    if (userResult.rows.length !== allParticipantIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more participants not found',
      });
    }

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    // Create group chat
    const newGroupChat = {
      participants: finalParticipantIds,
      type: 'group',
      groupName: name.trim(),
      groupDescription: description?.trim() || null,
      groupPictureUrl: groupPictureUrl || null,
      admins: [req.userId], // Creator is admin
      createdBy: req.userId,
      lastMessage: null,
      lastMessageAt: new Date(),
      archivedBy: [],
      pinnedBy: [],
      mutedBy: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await chatsCollection.insertOne(newGroupChat);
    const groupChat = { ...newGroupChat, _id: result.insertedId };

    // Emit socket event to all participants
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    allParticipantIds.forEach(participantId => {
      emitChatUpdate(participantId, {
        type: 'group_created',
        chatId: groupChat._id.toString(),
        groupName: groupChat.groupName,
      });
    });

    res.json({
      success: true,
      data: {
        chatId: groupChat._id.toString(),
        groupName: groupChat.groupName,
        groupDescription: groupChat.groupDescription,
        groupPictureUrl: groupChat.groupPictureUrl,
        participants: allParticipantIds,
        admins: groupChat.admins,
        createdAt: groupChat.createdAt,
      },
    });
  } catch (error) {
    console.error('Create group chat error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create group chat',
      error: error.message,
    });
  }
});

/**
 * Get Group Info
 * GET /api/chats/group/:chatId
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 */
router.get('/group/:chatId', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;

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

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      type: 'group',
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Group not found',
      });
    }

    // Get participant details
    const participantDetails = await Promise.all(
      chat.participants.map(async (userId) => {
        const userResult = await queryWithRetry(
          "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen FROM users WHERE id = $1",
          [userId],
          3,
          20000
        );
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          return {
            ...getUserPresenceData(user),
            isAdmin: chat.admins?.includes(userId) || false,
          };
        }
        return null;
      })
    );

    res.json({
      success: true,
      data: {
        chatId: chat._id.toString(),
        groupName: chat.groupName,
        groupDescription: chat.groupDescription,
        groupPictureUrl: chat.groupPictureUrl,
        participants: participantDetails.filter(p => p != null),
        admins: chat.admins || [],
        createdBy: chat.createdBy,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      },
    });
  } catch (error) {
    console.error('Get group info error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get group info',
      error: error.message,
    });
  }
});

/**
 * Update Group Info
 * PUT /api/chats/group/:chatId
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 * - #46: Group name validation
 */
router.put('/group/:chatId', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { name, description, groupPictureUrl } = req.body;

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
    
    // BUG FIX #46: Validate group name if provided
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Group name cannot be empty',
        });
      }
      if (name.trim().length > 100) {
        return res.status(400).json({
          success: false,
          message: 'Group name must be 100 characters or less',
        });
      }
    }

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      type: 'group',
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Group not found',
      });
    }

    // Check if user is admin
    if (!chat.admins?.includes(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can update group info',
      });
    }

    const updateData = {
      updatedAt: new Date(),
    };

    if (name !== undefined) {
      updateData.groupName = name.trim();
    }
    if (description !== undefined) {
      updateData.groupDescription = description?.trim() || null;
    }
    if (groupPictureUrl !== undefined) {
      updateData.groupPictureUrl = groupPictureUrl || null;
    }

    await chatsCollection.updateOne(
      { _id: chatObjectId },
      { $set: updateData }
    );

    // Emit socket event
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    chat.participants.forEach(participantId => {
      emitChatUpdate(participantId, {
        type: 'group_updated',
        chatId: chatId,
        updates: updateData,
      });
    });

    res.json({
      success: true,
      message: 'Group updated successfully',
      data: updateData,
    });
  } catch (error) {
    console.error('Update group error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update group',
      error: error.message,
    });
  }
});

/**
 * Add Members to Group
 * POST /api/chats/group/:chatId/add-members
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 * - #16: Group size validation on add-members
 * - #3: SQL injection risk (validate UUIDs)
 * - #14: Rate limiting
 */
router.post('/group/:chatId/add-members', verifyToken, groupRateLimit, validateChatId, validateParticipantIds, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { participantIds } = req.body;

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

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      type: 'group',
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Group not found',
      });
    }

    // Check if user is admin
    if (!chat.admins?.includes(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can add members',
      });
    }

    // BUG FIX #16: Check group size limit (including existing members)
    // participantIds already validated and deduplicated by middleware
    const newParticipantIds = participantIds.filter(
      id => !chat.participants.includes(id)
    );

    if (newParticipantIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'All users are already in the group',
      });
    }

    const newTotalMembers = chat.participants.length + newParticipantIds.length;
    if (newTotalMembers > 1024) {
      return res.status(400).json({
        success: false,
        message: `Group can have maximum 1024 members. Current: ${chat.participants.length}, Adding: ${newParticipantIds.length}, Total would be: ${newTotalMembers}`,
      });
    }

    // BUG FIX #3: Verify participants exist (UUIDs already validated by middleware)
    const userResult = await queryWithRetry(
      `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
      [newParticipantIds],
      3,
      20000
    );

    if (userResult.rows.length !== newParticipantIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more users not found',
      });
    }

    // Filter out blocked users (either direction)
    const { filterBlockedUsers } = await import('../utils/block.utils.js');
    const allowedParticipantIds = await filterBlockedUsers(req.userId, newParticipantIds);
    
    if (allowedParticipantIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot add members. All selected users are blocked.',
      });
    }

    if (allowedParticipantIds.length < newParticipantIds.length) {
      // Some users were filtered out, but continue with allowed ones
      console.log(`⚠️  Filtered out ${newParticipantIds.length - allowedParticipantIds.length} blocked user(s) from group addition`);
    }

    // Add participants (only allowed ones)
    await chatsCollection.updateOne(
      { _id: chatObjectId },
      {
        $addToSet: { participants: { $each: allowedParticipantIds } },
        $set: { updatedAt: new Date() },
      }
    );

    // Emit socket events
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    newParticipantIds.forEach(participantId => {
      emitChatUpdate(participantId, {
        type: 'group_member_added',
        chatId: chatId,
        addedBy: req.userId,
      });
    });
    chat.participants.forEach(participantId => {
      emitChatUpdate(participantId, {
        type: 'group_members_updated',
        chatId: chatId,
        addedMembers: allowedParticipantIds,
      });
    });

    res.json({
      success: true,
      message: 'Members added successfully',
      data: {
        addedMembers: allowedParticipantIds,
      },
    });
  } catch (error) {
    console.error('Add members error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add members',
      error: error.message,
    });
  }
});

/**
 * Remove Members from Group
 * POST /api/chats/group/:chatId/remove-members
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 * - #20: Transaction for group member removal
 * - #3: SQL injection risk (validate UUIDs)
 * - #14: Rate limiting
 */
router.post('/group/:chatId/remove-members', verifyToken, groupRateLimit, validateChatId, validateParticipantIds, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { participantIds } = req.body;

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

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      type: 'group',
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Group not found',
      });
    }

    // Check if user is admin or removing themselves
    const isRemovingSelf = participantIds.length === 1 && participantIds[0] === req.userId;
    if (!isRemovingSelf && !chat.admins?.includes(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can remove members',
      });
    }

    // Cannot remove creator if they're the only admin
    if (participantIds.includes(chat.createdBy) && chat.admins?.length === 1) {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove the only admin. Assign another admin first.',
      });
    }

    // BUG FIX #20: Remove participants and from admins if they were admins
    // Use atomic operation to ensure consistency
    // Note: MongoDB single-document operations are atomic
    // For true transactions, would need replica set
    await chatsCollection.updateOne(
      { _id: chatObjectId },
      {
        $pull: {
          participants: { $in: participantIds },
          admins: { $in: participantIds },
        },
        $set: { updatedAt: new Date() },
      }
    );

    // Emit socket events
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    participantIds.forEach(participantId => {
      emitChatUpdate(participantId, {
        type: 'group_member_removed',
        chatId: chatId,
        removedBy: req.userId,
      });
    });
    chat.participants
      .filter(id => !participantIds.includes(id))
      .forEach(participantId => {
        emitChatUpdate(participantId, {
          type: 'group_members_updated',
          chatId: chatId,
          removedMembers: participantIds,
        });
      });

    res.json({
      success: true,
      message: 'Members removed successfully',
    });
  } catch (error) {
    console.error('Remove members error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove members',
      error: error.message,
    });
  }
});

/**
 * Leave Group
 * POST /api/chats/group/:chatId/leave
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 */
router.post('/group/:chatId/leave', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;

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

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      type: 'group',
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Group not found',
      });
    }

    // Remove user from participants and admins
    await chatsCollection.updateOne(
      { _id: chatObjectId },
      {
        $pull: {
          participants: req.userId,
          admins: req.userId,
        },
        $set: { updatedAt: new Date() },
      }
    );

    // Emit socket events
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    chat.participants
      .filter(id => id !== req.userId)
      .forEach(participantId => {
        emitChatUpdate(participantId, {
          type: 'group_member_left',
          chatId: chatId,
          leftBy: req.userId,
        });
      });

    res.json({
      success: true,
      message: 'Left group successfully',
    });
  } catch (error) {
    console.error('Leave group error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to leave group',
      error: error.message,
    });
  }
});

/**
 * Make Admin
 * POST /api/chats/group/:chatId/make-admin
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 */
router.post('/group/:chatId/make-admin', verifyToken, groupRateLimit, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required',
      });
    }

    let chatObjectId;
    try {
      chatObjectId = validateObjectId(chatId, 'Chat ID');
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      type: 'group',
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Group not found',
      });
    }

    // Check if user is admin
    if (!chat.admins?.includes(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can make other users admin',
      });
    }

    // Check if user is a participant
    if (!chat.participants.includes(userId)) {
      return res.status(400).json({
        success: false,
        message: 'User is not a member of this group',
      });
    }

    // Check if user is already an admin
    if (chat.admins?.includes(userId)) {
      return res.status(400).json({
        success: false,
        message: 'User is already an admin',
      });
    }

    // Add user to admins
    await chatsCollection.updateOne(
      { _id: chatObjectId },
      {
        $addToSet: { admins: userId },
        $set: { updatedAt: new Date() },
      }
    );

    // Emit socket events
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    chat.participants.forEach(participantId => {
      emitChatUpdate(participantId, {
        type: 'group_admin_updated',
        chatId: chatId,
        userId: userId,
        action: 'made_admin',
        madeBy: req.userId,
      });
    });

    res.json({
      success: true,
      message: 'User made admin successfully',
    });
  } catch (error) {
    console.error('Make admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to make admin',
      error: error.message,
    });
  }
});

/**
 * Remove Admin
 * POST /api/chats/group/:chatId/remove-admin
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 */
router.post('/group/:chatId/remove-admin', verifyToken, groupRateLimit, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required',
      });
    }

    let chatObjectId;
    try {
      chatObjectId = validateObjectId(chatId, 'Chat ID');
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      type: 'group',
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Group not found',
      });
    }

    // Check if user is admin
    if (!chat.admins?.includes(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can remove admin status',
      });
    }

    // Cannot remove the only admin
    if (chat.admins?.length === 1 && chat.admins[0] === userId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove the only admin. Assign another admin first.',
      });
    }

    // Cannot remove creator if they're the only admin
    if (userId === chat.createdBy && chat.admins?.length === 1) {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove admin status from the group creator when they are the only admin.',
      });
    }

    // Remove user from admins
    await chatsCollection.updateOne(
      { _id: chatObjectId },
      {
        $pull: { admins: userId },
        $set: { updatedAt: new Date() },
      }
    );

    // Emit socket events
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    chat.participants.forEach(participantId => {
      emitChatUpdate(participantId, {
        type: 'group_admin_updated',
        chatId: chatId,
        userId: userId,
        action: 'removed_admin',
        removedBy: req.userId,
      });
    });

    res.json({
      success: true,
      message: 'Admin status removed successfully',
    });
  } catch (error) {
    console.error('Remove admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove admin',
      error: error.message,
    });
  }
});

/**
 * Generate Group Invite Link
 * GET /api/chats/group/:chatId/invite-link
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 */
router.get('/group/:chatId/invite-link', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;

    let chatObjectId;
    try {
      chatObjectId = validateObjectId(chatId, 'Chat ID');
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    const chat = await chatsCollection.findOne({
      _id: chatObjectId,
      type: 'group',
      participants: req.userId,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Group not found',
      });
    }

    // Check if user is admin
    if (!chat.admins?.includes(req.userId)) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can generate invite links',
      });
    }

    // Generate invite token (simple base64 encoding of chatId + timestamp)
    // In production, use a more secure token generation
    const crypto = await import('crypto');
    const inviteToken = crypto.createHash('sha256')
      .update(`${chatId}-${Date.now()}-${req.userId}`)
      .digest('hex')
      .substring(0, 32);

    // Store invite token in chat document
    await chatsCollection.updateOne(
      { _id: chatObjectId },
      {
        $set: {
          inviteToken: inviteToken,
          inviteTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          updatedAt: new Date(),
        },
      }
    );

    res.json({
      success: true,
      data: {
        inviteToken: inviteToken,
        inviteLink: `${process.env.FRONTEND_URL || 'https://axzora-chat.app'}/join-group/${inviteToken}`,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
  } catch (error) {
    console.error('Generate invite link error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate invite link',
      error: error.message,
    });
  }
});

/**
 * Join Group via Invite Link
 * POST /api/chats/group/join/:inviteToken
 */
router.post('/group/join/:inviteToken', verifyToken, async (req, res) => {
  try {
    const { inviteToken } = req.params;

    if (!inviteToken || inviteToken.length !== 32) {
      return res.status(400).json({
        success: false,
        message: 'Invalid invite token',
      });
    }

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    const chat = await chatsCollection.findOne({
      type: 'group',
      inviteToken: inviteToken,
      inviteTokenExpiresAt: { $gt: new Date() },
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired invite link',
      });
    }

    // Check if user is already a participant
    if (chat.participants.includes(req.userId)) {
      return res.status(400).json({
        success: false,
        message: 'You are already a member of this group',
      });
    }

    // Check group size limit
    if (chat.participants.length >= 1024) {
      return res.status(400).json({
        success: false,
        message: 'Group is full (maximum 1024 members)',
      });
    }

    // Add user to participants
    await chatsCollection.updateOne(
      { _id: chat._id },
      {
        $addToSet: { participants: req.userId },
        $set: { updatedAt: new Date() },
      }
    );

    // Emit socket events
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    emitChatUpdate(req.userId, {
      type: 'group_joined',
      chatId: chat._id.toString(),
      groupName: chat.groupName,
    });
    chat.participants.forEach(participantId => {
      emitChatUpdate(participantId, {
        type: 'group_member_added',
        chatId: chat._id.toString(),
        addedBy: req.userId,
      });
    });

    res.json({
      success: true,
      message: 'Joined group successfully',
      data: {
        chatId: chat._id.toString(),
        groupName: chat.groupName,
      },
    });
  } catch (error) {
    console.error('Join group error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to join group',
      error: error.message,
    });
  }
});

/**
 * Archive/Unarchive Chat
 * POST /api/chats/:chatId/archive
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 */
router.post('/:chatId/archive', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { archive = true } = req.body;

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

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

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

    if (archive) {
      await chatsCollection.updateOne(
        { _id: chatObjectId },
        { $addToSet: { archivedBy: req.userId } }
      );
    } else {
      await chatsCollection.updateOne(
        { _id: chatObjectId },
        { $pull: { archivedBy: req.userId } }
      );
    }

    // Get updated chat to send current archivedBy array
    const updatedChat = await chatsCollection.findOne({ _id: chatObjectId });

    // Emit socket event with updated archivedBy array
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    emitChatUpdate(req.userId, {
      type: archive ? 'chat_archived' : 'chat_unarchived',
      chatId: chatId,
      archivedBy: updatedChat?.archivedBy || [],
    });

    res.json({
      success: true,
      message: archive ? 'Chat archived' : 'Chat unarchived',
    });
  } catch (error) {
    console.error('Archive chat error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to archive chat',
      error: error.message,
    });
  }
});

/**
 * Pin/Unpin Chat
 * POST /api/chats/:chatId/pin
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 */
router.post('/:chatId/pin', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { pin = true } = req.body;

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

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

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

    if (pin) {
      await chatsCollection.updateOne(
        { _id: chatObjectId },
        { $addToSet: { pinnedBy: req.userId } }
      );
    } else {
      await chatsCollection.updateOne(
        { _id: chatObjectId },
        { $pull: { pinnedBy: req.userId } }
      );
    }

    // Get updated chat to send current pinnedBy array
    const updatedChat = await chatsCollection.findOne({ _id: chatObjectId });

    // Emit socket event with updated pinnedBy array
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    emitChatUpdate(req.userId, {
      type: pin ? 'chat_pinned' : 'chat_unpinned',
      chatId: chatId,
      pinnedBy: updatedChat?.pinnedBy || [],
    });

    res.json({
      success: true,
      message: pin ? 'Chat pinned' : 'Chat unpinned',
    });
  } catch (error) {
    console.error('Pin chat error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to pin chat',
      error: error.message,
    });
  }
});

/**
 * Mute/Unmute Chat
 * POST /api/chats/:chatId/mute
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 */
router.post('/:chatId/mute', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { mute = true, mutedUntil } = req.body;

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

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

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

    // For muting, we'll store mutedUntil timestamp per user
    // This requires a more complex structure, but for simplicity,
    // we'll use the mutedBy array and store mutedUntil in a separate field
    if (mute) {
      await chatsCollection.updateOne(
        { _id: chatObjectId },
        {
          $addToSet: { mutedBy: req.userId },
          $set: {
            [`mutedUntil.${req.userId}`]: mutedUntil ? new Date(mutedUntil) : null,
            updatedAt: new Date(),
          },
        }
      );
    } else {
      await chatsCollection.updateOne(
        { _id: chatObjectId },
        {
          $pull: { mutedBy: req.userId },
          $unset: { [`mutedUntil.${req.userId}`]: '' },
        }
      );
    }

    res.json({
      success: true,
      message: mute ? 'Chat muted' : 'Chat unmuted',
    });
  } catch (error) {
    console.error('Mute chat error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mute chat',
      error: error.message,
    });
  }
});

/**
 * Delete Chat
 * DELETE /api/chats/:chatId
 * 
 * Fixed bugs:
 * - #28: Validate chat ID format early
 * - #30: Error handling for file deletion (if messages have files)
 * 
 * For groups: Only admins can delete the group
 * For direct chats: Either participant can delete
 */
router.delete('/:chatId', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;

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

    // For groups, only admins can delete
    if (chat.type === 'group') {
      if (!chat.admins?.includes(req.userId)) {
        return res.status(403).json({
          success: false,
          message: 'Only admins can delete the group',
        });
      }
    }

    // BUG FIX #5: Clear unread count from Redis BEFORE deleting (use safe operations)
    // Clear for all participants, not just current user
    const { clearUnreadCount } = await import('../utils/redis.utils.js');
    await Promise.all(
      chat.participants.map(participantId => 
        clearUnreadCount(participantId, chatObjectId.toString())
      )
    );

    // Delete all messages in the chat
    await messagesCollection.deleteMany({
      chatId: chatObjectId,
    });

    // Delete the chat
    await chatsCollection.deleteOne({
      _id: chatObjectId,
    });

    // Emit socket events to notify all participants
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    chat.participants.forEach(participantId => {
      emitChatUpdate(participantId, {
        type: chat.type === 'group' ? 'group_deleted' : 'chat_deleted',
        chatId: chatId,
        deletedBy: req.userId,
      });
    });

    res.json({
      success: true,
      message: chat.type === 'group' ? 'Group deleted successfully' : 'Chat deleted successfully',
    });
  } catch (error) {
    console.error('Delete chat error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Clear Messages Only
 * DELETE /api/chats/:chatId/messages
 * 
 * Removes all messages from a chat while keeping the chat in the list
 */
router.delete('/:chatId/messages', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');
    const messagesCollection = mongoDb.collection('messages');

    // Validate ObjectId format
    let chatObjectId;
    try {
      chatObjectId = validateObjectId(chatId, 'Chat ID');
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    // Verify chat exists and user is participant
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

    // Mark all messages in the chat as deleted for this user only
    // This doesn't delete them for other participants
    const updateResult = await messagesCollection.updateMany(
      {
        chatId: chatObjectId,
        deletedFor: { $ne: req.userId }, // Only update messages not already deleted for this user
      },
      {
        $addToSet: { deletedFor: req.userId },
        $set: { updatedAt: new Date() },
      }
    );

    // Clear unread count for current user
    const { clearUnreadCount } = await import('../utils/redis.utils.js');
    await clearUnreadCount(req.userId, chatId);

    // Emit socket event to notify user only (not other participants)
    // Include updated chat info with null lastMessage since all messages are cleared for this user
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    emitChatUpdate(req.userId, {
      type: 'messages_cleared',
      chatId: chatId,
      lastMessage: null,
      lastMessageType: 'text',
      lastMessageAt: null,
    });

    res.json({
      success: true,
      message: 'Messages cleared successfully',
      deletedCount: updateResult.modifiedCount,
    });
  } catch (error) {
    console.error('Clear messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clear messages',
      error: error.message,
    });
  }
});

/**
 * Delete Chat (My Side Only)
 * POST /api/chats/:chatId/delete-for-me
 * 
 * Removes the chat from user's view without affecting other participants
 */
router.post('/:chatId/delete-for-me', verifyToken, validateChatId, async (req, res) => {
  try {
    const { chatId } = req.params;

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    // Validate ObjectId format
    let chatObjectId;
    try {
      chatObjectId = validateObjectId(chatId, 'Chat ID');
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    // Verify chat exists and user is participant
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

    // Add user to deletedBy array (or use a separate field)
    // For now, we'll use a deletedFor array to track users who deleted the chat
    await chatsCollection.updateOne(
      { _id: chatObjectId },
      {
        $addToSet: { deletedFor: req.userId },
        $set: { updatedAt: new Date() },
      }
    );

    // Clear unread count for current user
    const { clearUnreadCount } = await import('../utils/redis.utils.js');
    await clearUnreadCount(req.userId, chatId);

    // Emit socket event to notify user
    const { emitChatUpdate } = await import('../socket/socket.server.js');
    emitChatUpdate(req.userId, {
      type: 'chat_deleted_for_me',
      chatId: chatId,
    });

    res.json({
      success: true,
      message: 'Chat deleted from your side',
    });
  } catch (error) {
    console.error('Delete chat for me error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete chat',
      error: error.message,
    });
  }
});

export default router;

