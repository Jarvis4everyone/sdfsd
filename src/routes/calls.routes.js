import express from 'express';
import postgresPool, { queryWithRetry } from '../config/postgres.config.js';
import { verifyToken } from './auth.routes.js';
import {
  getUserCallHistory,
  createCallSession,
  updateCallSession,
  appendCallEvent,
  markParticipantState,
  endCallSession,
  getCallSessionByRoom,
  markCallAsMissed,
  createCallHistoryMessage,
} from '../services/call.service.js';
import { generateCallToken } from '../services/agora.service.js';
import { getUserPresenceData } from '../utils/presence.utils.js';
import { logActivity } from '../services/analytics.service.js';

const router = express.Router();

const formatCallResponse = async (call) => {
  if (!call) return null;

  try {
    const uniqueUserIds = [
      ...new Set((call.participants || []).map((participant) => {
        // Handle both object and string participant formats
        return typeof participant === 'string' ? participant : (participant?.userId || participant);
      }).filter(Boolean)),
    ];

    const participantsDetails = {};

    if (uniqueUserIds.length > 0) {
      try {
        const userResult = await queryWithRetry(
          `SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online,
                  to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen, timezone
           FROM users WHERE id = ANY($1::uuid[])`,
          [uniqueUserIds],
          3, // 3 retries
          30000 // 30 second timeout
        );

        userResult.rows.forEach((row) => {
          participantsDetails[row.id] = getUserPresenceData(row);
        });
      } catch (dbError) {
        console.error('⚠️  Error fetching user details for call participants:', dbError.message || dbError);
        // Continue without user details
      }
    }

    const formattedParticipants = (call.participants || []).map((participant) => {
      const userId = typeof participant === 'string' ? participant : (participant?.userId || participant);
      return {
        userId: userId,
        state: typeof participant === 'object' ? (participant.state || 'ended') : 'ended',
        updatedAt: typeof participant === 'object' ? participant.updatedAt : call.updatedAt,
        user: participantsDetails[userId] || null,
      };
    });

    // Safely parse dates
    const createdAt = call.createdAt ? (call.createdAt instanceof Date ? call.createdAt : new Date(call.createdAt)) : new Date();
    const updatedAt = call.updatedAt ? (call.updatedAt instanceof Date ? call.updatedAt : new Date(call.updatedAt)) : new Date();
    const endedAt = call.endedAt ? (call.endedAt instanceof Date ? call.endedAt : new Date(call.endedAt)) : null;

    return {
      id: call._id?.toString() || call.id || null,
      roomId: call.roomId || null,
      status: call.status || 'ended', // Default to 'ended' for old calls
      mediaType: call.mediaType || 'audio',
      initiatorId: call.initiatorId || null,
      participants: formattedParticipants,
      createdAt: createdAt,
      updatedAt: updatedAt,
      endedAt: endedAt,
      endReason: call.endReason || null,
      endedBy: call.endedBy || null,
      events: call.events || [],
      durationSeconds: endedAt && createdAt
        ? Math.floor((endedAt - createdAt) / 1000)
        : null,
      metadata: call.metadata || null,
    };
  } catch (error) {
    console.error('❌ Error formatting call response:', error);
    console.error('Call data:', JSON.stringify(call, null, 2));
    throw error;
  }
};

router.get('/history', verifyToken, async (req, res) => {
  try {
    const { limit, before } = req.query;
    const history = await getUserCallHistory({
      userId: req.userId,
      limit: limit ? parseInt(limit, 10) : undefined,
      before,
    });

    // Format calls with error handling for malformed data
    const formatted = [];
    for (const call of history) {
      try {
        const formattedCall = await formatCallResponse(call);
        if (formattedCall) {
          formatted.push(formattedCall);
        }
      } catch (callError) {
        console.error(`⚠️  Error formatting call ${call?._id || call?.id || 'unknown'}:`, callError);
        // Continue processing other calls even if one fails
      }
    }

    res.json({
      success: true,
      data: {
        calls: formatted,
        total: formatted.length,
      },
    });
  } catch (error) {
    console.error('Get call history error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to load call history',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

router.post('/session', verifyToken, async (req, res) => {
  try {
    const { roomId, participants, mediaType = 'audio', metadata } = req.body;
    // signalPayload is ignored (not needed for Agora)

    if (!roomId || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'roomId and participants are required',
      });
    }

    const normalizedParticipants = participants.map((participantId) => ({
      userId: participantId,
      state: participantId === req.userId ? 'initiator' : 'ringing',
      updatedAt: new Date(),
    }));

    const session = await createCallSession({
      roomId,
      initiatorId: req.userId,
      participants: normalizedParticipants,
      mediaType,
      signalPayload: null, // Not used with Agora
      metadata,
    });
    
    // Log activity
    const ipAddress = req.ip || req.connection.remoteAddress;
    const deviceId = req.headers['x-device-id'] || 'unknown';
    await logActivity({
      userId: req.userId,
      activityType: 'call_initiated',
      activityData: {
        roomId,
        mediaType,
        participantCount: normalizedParticipants.length,
      },
      ipAddress,
      deviceId,
    });

    const formatted = await formatCallResponse(session);

    res.status(201).json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error('Create call session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create call session',
    });
  }
});

// IMPORTANT: Route ordering matters! More specific routes must come before parameterized routes
// Route: POST /api/calls/token (must come before /:roomId/end)
router.post('/token', verifyToken, (req, res) => {
  try {
    const { roomId, mediaType = 'audio' } = req.body;

    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: 'roomId is required',
      });
    }

    const tokenData = generateCallToken(roomId, req.userId, mediaType);

    res.json({
      success: true,
      data: tokenData,
    });
  } catch (error) {
    console.error('Generate Agora token error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate token',
    });
  }
});

router.post('/:roomId/state', verifyToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { state } = req.body;

    if (!state) {
      return res.status(400).json({
        success: false,
        message: 'state is required',
      });
    }

    const updated = await markParticipantState(roomId, req.userId, state);
    
    // Log activity if answered
    if (state === 'answered') {
      const ipAddress = req.ip || req.connection.remoteAddress;
      const deviceId = req.headers['x-device-id'] || 'unknown';
      await logActivity({
        userId: req.userId,
        activityType: 'call_answered',
        activityData: {
          roomId,
          mediaType: updated?.mediaType || 'audio',
        },
        ipAddress,
        deviceId,
      });
    }

    // If session not found, return 200 with a message (socket events handle the actual state)
    // This prevents frontend errors when the session might have already been ended via socket
    if (!updated) {
      return res.status(200).json({
        success: true,
        message: 'Call session not found (may have been ended via socket)',
        data: null,
      });
    }

    await appendCallEvent(roomId, {
      type: 'participant_state',
      state,
      userId: req.userId,
    });

    const formatted = await formatCallResponse(updated);

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error('Update call state error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update call state',
    });
  }
});

// Route: POST /api/calls/:roomId/end
router.post('/:roomId/end', verifyToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { reason } = req.body || {};

    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: 'roomId is required',
      });
    }

    console.log(`📞 [API] Ending call session: roomId=${roomId}, reason=${reason || 'ended'}, endedBy=${req.userId}`);

    const session = await endCallSession({
      roomId,
      reason: reason || 'ended',
      endedBy: req.userId,
    });
    
    // Log activity
    const ipAddress = req.ip || req.connection.remoteAddress;
    const deviceId = req.headers['x-device-id'] || 'unknown';
    await logActivity({
      userId: req.userId,
      activityType: 'call_ended',
      activityData: {
        roomId,
        reason: reason || 'ended',
        duration: session?.durationSeconds || null,
      },
      ipAddress,
      deviceId,
    });

    // If session not found, return 200 with a message (socket events handle the actual ending)
    // This prevents frontend errors when the session might have already been ended via socket
    if (!session) {
      return res.status(200).json({
        success: true,
        message: 'Call session not found (may have been ended via socket)',
        data: null,
      });
    }

    await appendCallEvent(roomId, {
      type: 'end',
      reason: reason || 'ended',
      userId: req.userId,
    });

    // Mark participants who didn't answer as missed
    const participants = session.participants || [];
    for (const participant of participants) {
      if (participant.userId !== req.userId && 
          !['answered', 'declined', 'missed'].includes(participant.state)) {
        await markCallAsMissed(roomId, participant.userId);
      }
    }

    // NOTE: Call history message creation is handled by the socket handler (call_end event)
    // to avoid duplicates. The socket handler is the primary source of truth for call events.
    // We don't create it here to prevent duplicate messages when both socket and REST API are called.

    const formatted = await formatCallResponse(session);

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error('End call session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to end call session',
    });
  }
});

router.get('/session/:roomId', verifyToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const session = await getCallSessionByRoom(roomId);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Call session not found',
      });
    }

    const formatted = await formatCallResponse(session);

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error('Get call session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load call session',
    });
  }
});

export default router;


