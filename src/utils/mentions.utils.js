/**
 * Utility functions for parsing and handling @mentions in messages
 */

/**
 * Parse @mentions from message text
 * Returns array of mentioned user IDs
 * Format: @username (supports names with spaces: @John Doe)
 * 
 * @param {string} message - Message text
 * @param {Array} participants - Array of participant objects with id and fullName
 * @returns {Array} Array of mentioned user IDs
 */
export function parseMentions(message, participants = []) {
  if (!message || typeof message !== 'string') {
    return [];
  }

  const mentions = [];
  // Match @ followed by word characters or spaces (for names like "John Doe")
  // Stops at punctuation, newlines, or end of string
  const mentionPattern = /@([\w\s]+?)(?=\s|$|[.,!?;:])/g;
  const matches = message.matchAll(mentionPattern);

  for (const match of matches) {
    const mentionText = match[1].trim().toLowerCase();
    if (!mentionText) continue;
    
    // Try to find user by username (fullName) or user ID
    // Match by full name (with or without spaces) or user ID
    const mentionedUser = participants.find(p => {
      const fullName = (p.fullName || '').toLowerCase().trim();
      const fullNameNoSpaces = fullName.replace(/\s+/g, '');
      const userId = (p.id || '').toLowerCase();
      
      // Match exact full name, name without spaces, or user ID
      return fullName === mentionText || 
             fullNameNoSpaces === mentionText || 
             userId === mentionText ||
             fullName.startsWith(mentionText) || // Partial match for names
             fullNameNoSpaces.startsWith(mentionText);
    });

    if (mentionedUser && !mentions.includes(mentionedUser.id)) {
      mentions.push(mentionedUser.id);
    }
  }

  return mentions;
}

/**
 * Extract mention text from message (the text after @)
 * Returns array of mention objects with position and text
 * 
 * @param {string} message - Message text
 * @returns {Array} Array of {start, end, text} objects
 */
export function extractMentionPositions(message) {
  if (!message || typeof message !== 'string') {
    return [];
  }

  const mentions = [];
  const mentionPattern = /@(\w+)/g;
  let match;

  while ((match = mentionPattern.exec(message)) !== null) {
    mentions.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[1],
      fullMatch: match[0],
    });
  }

  return mentions;
}

/**
 * Replace @mentions with formatted text for display
 * 
 * @param {string} message - Message text
 * @param {Array} participants - Array of participant objects
 * @returns {string} Formatted message with mentions highlighted
 */
export function formatMentions(message, participants = []) {
  if (!message || typeof message !== 'string') {
    return message;
  }

  let formatted = message;
  const mentionPattern = /@(\w+)/g;

  formatted = formatted.replace(mentionPattern, (match, mentionText) => {
    const lowerMention = mentionText.toLowerCase();
    const mentionedUser = participants.find(p => {
      const fullName = (p.fullName || '').toLowerCase().replace(/\s+/g, '');
      const userId = (p.id || '').toLowerCase();
      return fullName === lowerMention || userId === lowerMention;
    });

    if (mentionedUser) {
      return `@${mentionedUser.fullName || mentionedUser.id}`;
    }

    return match; // Return original if not found
  });

  return formatted;
}

