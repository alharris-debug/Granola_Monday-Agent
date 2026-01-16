import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Monday.com API helper
async function mondayRequest(query, variables = {}) {
  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': process.env.MONDAY_API_TOKEN,
      'API-Version': '2024-01'
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();
  if (data.errors) {
    throw new Error(`Monday.com API Error: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

// Get boards from Monday.com
async function getBoards() {
  const query = `
    query {
      boards(limit: 50) {
        id
        name
        groups {
          id
          title
        }
        columns {
          id
          title
          type
        }
      }
    }
  `;
  const result = await mondayRequest(query);
  return result.data.boards;
}

// Get users from Monday.com
async function getUsers() {
  const query = `
    query {
      users {
        id
        name
        email
      }
    }
  `;
  const result = await mondayRequest(query);
  return result.data.users;
}

// Create item in Monday.com
async function createMondayItem(boardId, groupId, itemName, columnValues = {}) {
  const query = `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON) {
      create_item(
        board_id: $boardId
        group_id: $groupId
        item_name: $itemName
        column_values: $columnValues
      ) {
        id
        name
      }
    }
  `;

  const result = await mondayRequest(query, {
    boardId,
    groupId,
    itemName,
    columnValues: JSON.stringify(columnValues)
  });

  return result.data.create_item;
}

// Add update/comment to Monday item
async function addItemUpdate(itemId, body) {
  const query = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
  `;

  const result = await mondayRequest(query, { itemId, body });
  return result.data.create_update;
}

// Extraction prompt for Claude
const EXTRACTION_PROMPT = `You are an expert meeting analyst. Extract ALL action items from the meeting notes.

## What to Extract:
- Explicit assignments: "John will...", "Sarah to follow up on..."
- Implied tasks: "We need to...", "Someone should..."
- Decisions requiring action
- Follow-up items and deadlines

## For Each Action Item Extract:
1. task_title: Clear, actionable title (verb + object format)
2. description: Full context from the meeting (2-3 sentences max)
3. assignee: Name of person responsible (null if unspecified)
4. deadline: ISO date if mentioned, or relative term ("end of week")
5. priority: "high", "medium", or "low" based on urgency language
6. project_context: Project/initiative name if mentioned

## Priority Rules:
- HIGH: "urgent", "ASAP", "blocking", "critical", deadline within 3 days
- MEDIUM: Has deadline, mentioned multiple times, tied to deliverable
- LOW: "when you get a chance", "nice to have", no deadline

## Output Format (JSON only, no markdown):
{
  "meeting_summary": "One sentence summary",
  "action_items": [
    {
      "task_title": "Schedule Q1 planning session",
      "description": "Need to book a 2-hour block for leadership team",
      "assignee": "Sarah",
      "deadline": "2025-01-20",
      "priority": "high",
      "project_context": "Q1 Planning"
    }
  ]
}`;

// Extract action items using Claude
async function extractActionItems(meetingNotes, meetingTitle = '') {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `${EXTRACTION_PROMPT}

Meeting Title: ${meetingTitle || 'Untitled Meeting'}
Meeting Date: ${new Date().toISOString().split('T')[0]}

Meeting Notes:
${meetingNotes}`
      }
    ]
  });

  const content = response.content[0].text;

  // Parse JSON from response (handle potential markdown wrapping)
  let jsonStr = content;
  if (content.includes('```')) {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) jsonStr = match[1];
  }

  return JSON.parse(jsonStr.trim());
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get Monday.com boards
app.get('/api/boards', async (req, res) => {
  try {
    const boards = await getBoards();
    res.json({ success: true, boards });
  } catch (error) {
    console.error('Error fetching boards:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Monday.com users
app.get('/api/users', async (req, res) => {
  try {
    const users = await getUsers();
    res.json({ success: true, users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Extract action items from meeting notes
app.post('/api/extract', async (req, res) => {
  try {
    const { meetingNotes, meetingTitle } = req.body;

    if (!meetingNotes || meetingNotes.trim().length < 50) {
      return res.status(400).json({
        success: false,
        error: 'Meeting notes must be at least 50 characters'
      });
    }

    const result = await extractActionItems(meetingNotes, meetingTitle);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error extracting action items:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create tasks in Monday.com
app.post('/api/create-tasks', async (req, res) => {
  try {
    const { actionItems, boardId, groupId, meetingTitle } = req.body;

    if (!actionItems || !Array.isArray(actionItems) || actionItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No action items provided'
      });
    }

    const targetBoardId = boardId || process.env.MONDAY_DEFAULT_BOARD_ID;
    if (!targetBoardId) {
      return res.status(400).json({
        success: false,
        error: 'No board ID specified and no default configured'
      });
    }

    // Get board info to find default group and column mappings
    const boards = await getBoards();
    const board = boards.find(b => b.id === targetBoardId);

    if (!board) {
      return res.status(404).json({
        success: false,
        error: `Board ${targetBoardId} not found`
      });
    }

    // Use provided group or first available group
    const targetGroupId = groupId || board.groups[0]?.id;
    if (!targetGroupId) {
      return res.status(400).json({
        success: false,
        error: 'No group available in the board'
      });
    }

    // Find common column types
    const dateColumn = board.columns.find(c => c.type === 'date');
    const statusColumn = board.columns.find(c => c.type === 'status' || c.type === 'color');
    const personColumn = board.columns.find(c => c.type === 'people');

    const results = [];
    const errors = [];

    for (const item of actionItems) {
      try {
        // Build column values
        const columnValues = {};

        // Set due date if we have a date column and deadline
        if (dateColumn && item.deadline) {
          try {
            const date = new Date(item.deadline);
            if (!isNaN(date.getTime())) {
              columnValues[dateColumn.id] = { date: date.toISOString().split('T')[0] };
            }
          } catch (e) {
            // Skip invalid dates
          }
        }

        // Create the item
        const created = await createMondayItem(
          targetBoardId,
          targetGroupId,
          item.task_title,
          columnValues
        );

        // Add context as an update/comment
        const contextNote = `📝 **From Meeting: ${meetingTitle || 'Untitled'}**

${item.description || ''}

**Priority:** ${item.priority || 'Medium'}
${item.assignee ? `**Assigned to:** ${item.assignee}` : ''}
${item.deadline ? `**Deadline:** ${item.deadline}` : ''}
${item.project_context ? `**Project:** ${item.project_context}` : ''}

*Auto-created by Granola → Monday Agent*`;

        await addItemUpdate(created.id, contextNote);

        results.push({
          success: true,
          item: created,
          original: item
        });
      } catch (error) {
        errors.push({
          success: false,
          error: error.message,
          original: item
        });
      }
    }

    res.json({
      success: true,
      created: results.length,
      failed: errors.length,
      results,
      errors,
      board: { id: board.id, name: board.name },
      group: { id: targetGroupId }
    });
  } catch (error) {
    console.error('Error creating tasks:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Full pipeline: extract and create
app.post('/api/process-meeting', async (req, res) => {
  try {
    const { meetingNotes, meetingTitle, boardId, groupId, autoCreate = false } = req.body;

    if (!meetingNotes || meetingNotes.trim().length < 50) {
      return res.status(400).json({
        success: false,
        error: 'Meeting notes must be at least 50 characters'
      });
    }

    // Step 1: Extract action items
    const extraction = await extractActionItems(meetingNotes, meetingTitle);

    if (!extraction.action_items || extraction.action_items.length === 0) {
      return res.json({
        success: true,
        meeting_summary: extraction.meeting_summary,
        action_items: [],
        message: 'No action items found in the meeting notes'
      });
    }

    // If not auto-creating, return extracted items for review
    if (!autoCreate) {
      return res.json({
        success: true,
        meeting_summary: extraction.meeting_summary,
        action_items: extraction.action_items,
        message: `Found ${extraction.action_items.length} action items. Review and confirm to create tasks.`
      });
    }

    // Step 2: Create tasks in Monday.com
    const createResponse = await fetch(`http://localhost:${process.env.PORT || 3000}/api/create-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionItems: extraction.action_items,
        boardId,
        groupId,
        meetingTitle
      })
    });

    const createResult = await createResponse.json();

    res.json({
      success: true,
      meeting_summary: extraction.meeting_summary,
      action_items: extraction.action_items,
      creation_result: createResult
    });
  } catch (error) {
    console.error('Error processing meeting:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve the meeting processor UI
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'meeting-processor.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Granola → Monday Agent running at http://localhost:${PORT}`);
  console.log(`📋 Open http://localhost:${PORT} to process meeting notes`);
});
