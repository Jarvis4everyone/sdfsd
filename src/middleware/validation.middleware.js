/**
 * Validation middleware for request validation
 */

/**
 * Validate message content
 */
export const validateMessage = (req, res, next) => {
  const { message, messageType = 'text' } = req.body;

  // Check if message exists
  if (!message || (typeof message === 'string' && message.trim().length === 0)) {
    return res.status(400).json({
      success: false,
      message: 'Message is required and cannot be empty',
    });
  }

  // Validate message length (max 10,000 characters for text messages)
  if (messageType === 'text' && typeof message === 'string') {
    const maxLength = 10000;
    if (message.length > maxLength) {
      return res.status(400).json({
        success: false,
        message: `Message too long. Maximum length is ${maxLength} characters.`,
      });
    }
  }

  // Validate message type
  const validMessageTypes = ['text', 'image', 'video', 'audio', 'file', 'document', 'call'];
  if (!validMessageTypes.includes(messageType)) {
    return res.status(400).json({
      success: false,
      message: `Invalid message type. Must be one of: ${validMessageTypes.join(', ')}`,
    });
  }

  next();
};

/**
 * Validate chat ID format (MongoDB ObjectId)
 */
export const validateChatId = (req, res, next) => {
  const { chatId } = req.params;
  
  if (!chatId) {
    return res.status(400).json({
      success: false,
      message: 'Chat ID is required',
    });
  }

  // Validate ObjectId format (24 hex characters)
  const objectIdPattern = /^[0-9a-fA-F]{24}$/;
  if (!objectIdPattern.test(chatId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid chat ID format',
    });
  }

  next();
};

/**
 * Validate message ID format
 */
export const validateMessageId = (req, res, next) => {
  const { messageId } = req.params;
  
  if (!messageId) {
    return res.status(400).json({
      success: false,
      message: 'Message ID is required',
    });
  }

  // Validate ObjectId format
  const objectIdPattern = /^[0-9a-fA-F]{24}$/;
  if (!objectIdPattern.test(messageId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid message ID format',
    });
  }

  next();
};

/**
 * Validate group name
 */
export const validateGroupName = (req, res, next) => {
  const { name } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Group name is required',
    });
  }

  const trimmedName = name.trim();
  const minLength = 1;
  const maxLength = 100;

  if (trimmedName.length < minLength || trimmedName.length > maxLength) {
    return res.status(400).json({
      success: false,
      message: `Group name must be between ${minLength} and ${maxLength} characters`,
    });
  }

  // Check for invalid characters (no control characters)
  if (/[\x00-\x1F\x7F]/.test(trimmedName)) {
    return res.status(400).json({
      success: false,
      message: 'Group name contains invalid characters',
    });
  }

  req.body.name = trimmedName; // Use trimmed version
  next();
};

/**
 * Validate participant IDs array
 */
export const validateParticipantIds = (req, res, next) => {
  const { participantIds } = req.body;

  if (!participantIds || !Array.isArray(participantIds)) {
    return res.status(400).json({
      success: false,
      message: 'participantIds must be an array',
    });
  }

  if (participantIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'At least one participant is required',
    });
  }

  // Validate UUID format for each participant ID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of participantIds) {
    if (typeof id !== 'string' || !uuidPattern.test(id)) {
      return res.status(400).json({
        success: false,
        message: `Invalid participant ID format: ${id}`,
      });
    }
  }

  // Remove duplicates
  req.body.participantIds = [...new Set(participantIds)];
  next();
};

/**
 * Validate emoji reaction
 */
export const validateReaction = (req, res, next) => {
  const { reaction } = req.body;

  if (!reaction || typeof reaction !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Reaction is required',
    });
  }

  // Basic emoji validation (check if it's a single emoji or emoji sequence)
  // This is a simple check - emojis can be complex (multiple code points)
  const emojiPattern = /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier_Base}\p{Emoji_Modifier}\p{Emoji_Component}]+$/u;
  
  if (!emojiPattern.test(reaction) || reaction.length > 10) {
    return res.status(400).json({
      success: false,
      message: 'Invalid reaction. Must be a valid emoji.',
    });
  }

  next();
};

