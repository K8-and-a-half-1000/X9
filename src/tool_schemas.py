"""
tool_schemas.py

OpenAI-compatible function tool schemas and the converter that turns
native function calls back into ToolBlocks for the execution pipeline.

Extracted from agent_tools.py to keep schema definitions separate from
tool parsing / execution logic.
"""

import json
import logging
from typing import Optional

from core.platform_compat import IS_WINDOWS
from src.agent_tools import ToolBlock, TOOL_TAGS
from src.tool_parsing import _TOOL_NAME_MAP

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# OpenAI-compatible function tool schemas
# ---------------------------------------------------------------------------
# On Windows the `bash` tool actually executes PowerShell (the name is kept
# for tag/frontend compatibility) — the description must say so, or models
# emit POSIX commands that fail on the host.
_SHELL_TOOL_DESC = (
    (
        "Run a PowerShell command on the WINDOWS host (full access; the tool name `bash` is historical "
        "-- the command executes in PowerShell). Write PowerShell syntax, not bash or cmd.exe: "
        "Get-ChildItem not ls, Select-String not grep, $env:NAME not $NAME; chain with `;` "
        "(avoid &&/||, unsupported in Windows PowerShell 5.1). Multi-line scripts are fine. "
        if IS_WINDOWS
        else "Run a shell command (full access). "
    )
    + "Prefer a dedicated tool whenever one fits the job (reading, writing, editing, searching, or "
    "listing files); use bash only for what no dedicated tool covers (installs, git, builds, running "
    "programs, system info). Do NOT create or edit files via shell redirects/heredocs/sed/Set-Content "
    "-- use the dedicated file tools."
)

FUNCTION_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": _SHELL_TOOL_DESC,
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": (
                            "The PowerShell command to execute"
                            if IS_WINDOWS
                            else "The shell command to execute"
                        ),
                    }
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "python",
            "description": "Execute Python code to compute a result or test something. Prefer a dedicated tool whenever one fits the job (reading, writing, or searching files); use python only for computation, data processing, or scripting no dedicated tool covers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python code to execute"}
                },
                "required": ["code"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Quick single web lookup for a fact or current event mid-task. NOT for 'research X' / 'do research on X' — those are deep-research jobs; use trigger_research instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "time_filter": {"type": "string", "enum": ["day", "week", "month", "year"], "description": "Optional freshness filter for news/latest/today queries"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "Fetch and read the text content of a specific URL the user names (e.g. 'check example.com', 'what's on this page <url>'). Use when you already have a concrete URL/domain. NOT for open-ended searches (use web_search) or 'research X' jobs (use trigger_research). Downloads are size-budgeted; a '[partial content: ...]' notice in the result means the body was cut short and you can re-call with full=true for the rest.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL or domain to fetch (http/https; a bare domain like example.com is fine)"},
                    "full": {"type": "boolean", "description": "Raise the download budget to the hard cap for large pages/files. Use only after a result reported partial content."}
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from disk. Optionally read a line range with offset/limit for large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to read"},
                    "offset": {"type": "integer", "description": "1-based line to start reading from (optional)"},
                    "limit": {"type": "integer", "description": "Max number of lines to read from offset (optional)"}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "Search file contents for a regular expression across a directory tree (uses ripgrep when available, respecting .gitignore). Returns file:line:match. PREFER this over `bash grep/rg` for code search — confined to the allowed roots, structured output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regular expression to search for"},
                    "path": {"type": "string", "description": "Directory or file to search (optional; defaults to the project root)"},
                    "glob": {"type": "string", "description": "Only search files matching this glob, e.g. '*.py' (optional)"},
                    "ignore_case": {"type": "boolean", "description": "Case-insensitive match (optional)"},
                    "max_results": {"type": "integer", "description": "Max matches to return (optional)"}
                },
                "required": ["pattern"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "glob",
            "description": "Find files by glob pattern (recursive), newest first. e.g. '**/*.py'. PREFER this over `bash find/ls` for locating files — confined to the allowed roots.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern, e.g. '**/*.ts' or 'src/**/test_*.py'"},
                    "path": {"type": "string", "description": "Base directory (optional; defaults to the project root)"}
                },
                "required": ["pattern"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ls",
            "description": "List the entries of a directory (folders first, then files with sizes). PREFER this over `bash ls` — confined to the allowed roots.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory to list (optional; defaults to the project root)"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_workspace",
            "description": "Return the absolute path of the active workspace folder the user is working in. File tools are confined to it; the shell starts there but is not sandboxed. Call this first when the user refers to 'the project'/'the code'/'this folder' without a path, instead of asking them. Takes no arguments.",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write/save a file to disk",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to write to"},
                    "content": {"type": "string", "description": "File content to write"}
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Edit a file ON DISK by exact string replacement (home folder, project files, any real path like ~/sweden.txt or /path/to/file). This is the right tool for files on disk — NOT edit_document (that's for editor-panel documents). PREFER this over bash (sed/echo) — it shows a diff. old_string must match the file exactly and be unique (or set replace_all). Use write_file to create a new file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to edit"},
                    "old_string": {"type": "string", "description": "Exact text to replace (must match the file, including indentation)"},
                    "new_string": {"type": "string", "description": "Replacement text"},
                    "replace_all": {"type": "boolean", "description": "Replace all occurrences instead of requiring a unique match"}
                },
                "required": ["path", "old_string", "new_string"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_document",
            "description": "Create a new document in the editor panel. Use this when the user asks to write, create, build, or generate code, scripts, programs, games, apps, or any substantial content (>15 lines) AND there is no already-open document that the request refers to. NEVER put large code blocks directly in chat — use this tool instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Document title"},
                    "language": {"type": "string", "description": "Programming language or format (e.g. python, javascript, markdown, text)"},
                    "content": {"type": "string", "description": "The document content"}
                },
                "required": ["title", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "edit_document",
            "description": "Edit a document OPEN IN THE EDITOR PANEL (created via create_document) — NOT a file on disk. For files on disk (home folder, project files, anything with a path like ~/x.txt or /path/to/file) use edit_file instead. Targeted find-and-replace with multiple FIND/REPLACE pairs per call; use for any edit smaller than a full rewrite. Do NOT send the whole file back via update_document for small edits.",
            "parameters": {
                "type": "object",
                "properties": {
                    "edits": {
                        "type": "array",
                        "description": "List of find/replace edits (first match only per edit)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "find": {"type": "string", "description": "Exact text to find in the document"},
                                "replace": {"type": "string", "description": "Text to replace it with"}
                            },
                            "required": ["find", "replace"]
                        }
                    }
                },
                "required": ["edits"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_document",
            "description": "Suggest improvements to the active document WITHOUT editing it. Creates inline comment bubbles the user can accept or reject. Use when the user asks for suggestions, review, improvements, or feedback.",
            "parameters": {
                "type": "object",
                "properties": {
                    "suggestions": {
                        "type": "array",
                        "description": "List of suggested changes with reasons",
                        "items": {
                            "type": "object",
                            "properties": {
                                "find": {"type": "string", "description": "Exact text in the document to suggest changing"},
                                "replace": {"type": "string", "description": "Suggested replacement text"},
                                "reason": {"type": "string", "description": "Brief explanation of why this change helps"}
                            },
                            "required": ["find", "replace", "reason"]
                        }
                    }
                },
                "required": ["suggestions"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "update_document",
            "description": "Replace the ENTIRE active document. ONLY use for genuine full rewrites (>50% of lines changed). For any smaller change, use edit_document — echoing back the whole file for small edits is wasteful.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Complete new document content"}
                },
                "required": ["content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_chats",
            "description": "Search the user's past session transcripts by keyword. Use when the user asks about previous chats, past conversations, or when direct transcript evidence is better than persistent memory. Returns matching sessions with clickable links and nearby context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keyword(s) to find in past conversations"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "chat_with_model",
            "description": "Send a message to another AI model and get its response. Use for getting a second opinion, delegating subtasks, or AI-to-AI communication.",
            "parameters": {
                "type": "object",
                "properties": {
                    "model": {"type": "string", "description": "Model name (e.g. 'qwen3-32b') or model@endpoint_name"},
                    "message": {"type": "string", "description": "The message to send to the model"}
                },
                "required": ["model", "message"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_session",
            "description": "Create a new chat for ongoing conversations with a specific model. (The UI calls these 'chats'; 'session' is the internal term.)",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Name for the new chat"},
                    "model": {"type": "string", "description": "Model name or model@endpoint_name"}
                },
                "required": ["name", "model"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_sessions",
            "description": "List the user's chats (the UI calls them 'chats') as clickable markdown links. Use this to enumerate chats before opening, renaming, archiving, or deleting them. When replying to the user, preserve the returned [title](#session-id) links; do not strip them into plain text. Optionally filter by keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {"type": "string", "description": "Optional keyword to filter chats by name"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "send_to_session",
            "description": "Send a new message to an existing live chat and get that chat model's response. Do not use this to retrieve, read, summarize, or inspect old chats; use search_chats or list_sessions for past chat evidence.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "The id of the chat to send the message to"},
                    "message": {"type": "string", "description": "The message to send"}
                },
                "required": ["session_id", "message"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "pipeline",
            "description": "Run a multi-step AI pipeline where each model's output feeds the next. Example: Draft -> Critique -> Revise.",
            "parameters": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "description": "Pipeline steps in order",
                        "items": {
                            "type": "object",
                            "properties": {
                                "model": {"type": "string", "description": "Model name for this step"},
                                "instruction": {"type": "string", "description": "What this step should do"}
                            },
                            "required": ["model", "instruction"]
                        }
                    }
                },
                "required": ["steps"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_session",
            "description": "Manage a chat: rename, archive, unarchive, delete, mark important, truncate history, or fork it. (The UI calls these 'chats'; 'session' is the internal term.) For destructive actions like delete, call list_sessions first and pass the exact id returned there; never invent ids.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["rename", "archive", "unarchive", "delete", "important", "unimportant", "truncate", "fork"],
                               "description": "The action to perform"},
                    "session_id": {"type": "string", "description": "Exact target chat id from list_sessions, or 'current' for the active chat where supported"},
                    "value": {"type": "string", "description": "Action parameter: new name (rename), keep_count (truncate/fork)"}
                },
                "required": ["action", "session_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_memory",
            "description": "Manage the user's memory system: list, add, edit, delete, or search memories. Memories persist across sessions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "edit", "delete", "search"],
                               "description": "The action to perform"},
                    "text": {"type": "string", "description": "Memory text (for add/edit) or search query (for search)"},
                    "memory_id": {"type": "string", "description": "Memory ID (for edit/delete)"},
                    "category": {"type": "string", "enum": ["fact", "event", "contact", "preference"],
                                 "description": "Memory category (for add/list filter)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_models",
            "description": "List all available AI models across configured endpoints. Optionally filter by keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {"type": "string", "description": "Optional keyword to filter models"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ui_control",
            "description": "Control the user interface. Actions: toggle (turn tools on/off), open_panel (open a modal: documents/library, gallery, sessions, memories/brain, skills, settings), set_mode, switch_model, set_theme (built-in presets: dark, light, midnight, paper, cyberpunk, retrowave, forest, ocean, ume, copper, terminal, organs, lavender, gpt, claude, cute), create_theme (CREATE any custom theme with a name + colors object — pick distinctive, evocative hex colors that match the requested aesthetic, NOT generic defaults. The theme auto-applies after creation). When a user asks for ANY theme not in the built-in preset list, ALWAYS use create_theme.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["toggle", "open_panel", "set_mode", "switch_model", "set_theme", "create_theme", "get_toggles"],
                               "description": "The UI action. Use set_theme for presets, create_theme to build a custom theme with any hex colors"},
                    "name": {"type": "string", "description": "For toggle: web, bash, research, incognito, document_editor (aliases: shell, search, deepresearch, documents). For open_panel: documents, gallery, sessions, brain/memories, skills, settings. For set_theme: a preset theme name. For create_theme: the custom theme name."},
                    "value": {"type": "string", "description": "Value: on/off for toggle, agent/chat for set_mode, model name for switch_model, or theme name for set_theme"},
                    "colors": {"type": "object", "description": "For create_theme: the theme colors",
                               "properties": {
                                   "bg": {"type": "string", "description": "Background color (hex, e.g. #1a1a2e)"},
                                   "fg": {"type": "string", "description": "Foreground/text color (hex)"},
                                   "panel": {"type": "string", "description": "Panel/sidebar background color (hex)"},
                                   "border": {"type": "string", "description": "Border/divider color (hex)"},
                                   "accent": {"type": "string", "description": "Accent color for buttons, brand, highlights (hex)"},
                                   "userBubbleBg": {"type": "string", "description": "User chat bubble background (hex, optional)"},
                                   "aiBubbleBg": {"type": "string", "description": "AI chat bubble background (hex, optional)"},
                                   "bubbleBorder": {"type": "string", "description": "Chat bubble border color (hex, optional)"},
                                   "sidebarBg": {"type": "string", "description": "Sidebar background override (hex, optional)"},
                                   "sectionAccent": {"type": "string", "description": "Section header accent color (hex, optional)"},
                                   "brandColor": {"type": "string", "description": "Brand/logo color (hex, optional)"},
                                   "inputBg": {"type": "string", "description": "Chat input background (hex, optional)"},
                                   "inputBorder": {"type": "string", "description": "Chat input border (hex, optional)"},
                                   "sendBtnBg": {"type": "string", "description": "Send button background (hex, optional)"},
                                   "sendBtnHover": {"type": "string", "description": "Send button hover color (hex, optional)"},
                                   "codeBg": {"type": "string", "description": "Code block background (hex, optional)"},
                                   "codeFg": {"type": "string", "description": "Code block text color (hex, optional)"},
                                   "toggleBg": {"type": "string", "description": "Toggle switch off background (hex, optional)"},
                                   "toggleActive": {"type": "string", "description": "Toggle switch on color (hex, optional)"},
                                   "accentPrimary": {"type": "string", "description": "Primary accent override (hex, optional)"},
                                   "accentError": {"type": "string", "description": "Error/danger color (hex, optional)"}
                               },
                               "required": ["bg", "fg", "panel", "border", "accent"]}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ask_user",
            "description": "Ask the user a multiple-choice question to get a decision or clarification when the task is genuinely ambiguous and the answer changes what you do next (e.g. pick between approaches, confirm an assumption, choose a target). The user sees clickable option buttons; calling this ENDS your turn and their selection arrives as your next message. Prefer sensible defaults over asking — only ask when you truly cannot proceed well without the user's input. Do NOT use it to confirm irreversible/destructive actions that have a dedicated confirmation flow.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "The question to ask. Be specific and self-contained."},
                    "options": {
                        "type": "array",
                        "description": "2-6 choices. Each is an object with a short `label` and an optional `description` explaining the trade-off.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "description": "Concise choice text the user clicks (1-5 words)."},
                                "description": {"type": "string", "description": "Optional one-line explanation of this choice."}
                            },
                            "required": ["label"]
                        }
                    },
                    "multi": {"type": "boolean", "description": "Set true ONLY when the question explicitly allows choosing more than one option. Otherwise omit it or set false. Default false."}
                },
                "required": ["question", "options"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "update_plan",
            "description": "Write back to the ACTIVE PLAN: mark steps done or revise them. Use this while executing an approved plan — after you finish a step, call update_plan with the full checklist and that step marked `- [x]`; when the user asks to change the plan, call it with the revised checklist. The user's docked plan window updates live. Pass the COMPLETE checklist every time (not a diff). No effect if there is no active plan.",
            "parameters": {
                "type": "object",
                "properties": {
                    "plan": {"type": "string", "description": "The full updated plan as a GitHub-style markdown checklist — one step per line, `- [ ]` for pending and `- [x]` for done. Always send the whole list."}
                },
                "required": ["plan"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_tasks",
            "description": "Manage scheduled/automated tasks: list, create, edit, delete, pause, resume, or run tasks. Use this for ANY recurring/scheduled request ('every morning…', 'each day at 7:30', 'daily summarize…') — create a task rather than doing it once. Task types: llm (AI runs a prompt), research (runs the deep-research pipeline on a question), or action (built-in automation). Triggers can be time-based or event-based.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "create", "edit", "delete", "pause", "resume", "run"],
                               "description": "The action to perform"},
                    "task_id": {"type": "string", "description": "Task ID (for edit/delete/pause/resume/run)"},
                    "name": {"type": "string", "description": "Task name"},
                    "prompt": {"type": "string", "description": "The instruction (for task_type=llm) or the research question (for task_type=research). Required for both."},
                    "task_type": {"type": "string", "enum": ["llm", "research", "action"],
                                  "description": "llm = AI runs your prompt; research = runs the deep-research pipeline on the prompt as a question; action = direct built-in function"},
                    "action_name": {"type": "string", "enum": [
                        "tidy_sessions", "tidy_documents", "consolidate_memory", "tidy_research",
                        "classify_events",
                        "test_skills", "audit_skills"
                    ],
                                    "description": "Built-in action (for task_type=action)"},
                    "trigger_type": {"type": "string", "enum": ["schedule", "event"],
                                     "description": "schedule = time-based, event = count-based"},
                    "schedule": {"type": "string", "enum": ["once", "daily", "weekly", "monthly"],
                                 "description": "Schedule frequency (for trigger_type=schedule)"},
                    "scheduled_time": {"type": "string", "description": "HH:MM in UTC (for schedule triggers). Convert the user's stated local time using the UTC offset given in the 'Current date and time' context."},
                    "scheduled_day": {"type": "integer", "description": "Day of week 0=Mon (weekly) or day of month (monthly)"},
                    "trigger_event": {"type": "string", "enum": ["session_created", "message_sent", "document_created", "memory_added", "research_completed", "skill_added"],
                                      "description": "Event name (for trigger_type=event)"},
                    "trigger_count": {"type": "integer", "description": "Fire every N events (for trigger_type=event)"},
                    "output_target": {"type": "string", "description": "Where results go. Defaults to 'session' (results land in a dedicated chat session the user reads) — this is the right choice for 'summarize for me' / 'send to me'."}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "api_call",
            "description": "Call a registered API integration (RSS reader, git forge, bookmark manager, smart home, etc.). Check the system context for available integrations and their endpoints.",
            "parameters": {
                "type": "object",
                "properties": {
                    "integration": {"type": "string", "description": "Integration name or ID (e.g. 'Miniflux', 'Gitea')"},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "HTTP method"},
                    "path": {"type": "string", "description": "API endpoint path (e.g. '/v1/entries?status=unread&limit=20')"},
                    "body": {"type": "object", "description": "JSON request body (for POST/PUT/PATCH)"}
                },
                "required": ["integration", "method", "path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ask_teacher",
            "description": "Ask a more capable AI model for help when stuck on a difficult problem. The teacher provides guidance that can be saved as a learned skill.",
            "parameters": {
                "type": "object",
                "properties": {
                    "model": {"type": "string", "description": "Teacher model name (e.g. 'claude-sonnet-4') or 'auto' for configured default"},
                    "problem": {"type": "string", "description": "Describe the problem or question you need help with"}
                },
                "required": ["problem"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_skills",
            "description": (
                "Read or modify the user's skill library. Skills are SKILL.md files "
                "(YAML frontmatter + structured body: When to Use / Procedure / "
                "Pitfalls / Verification) and follow a draft → published lifecycle. "
                "Use progressive disclosure: 'list' to see what exists, 'view' to "
                "load full content for a single skill, 'view_ref' for sub-files. "
                "Use 'patch' for surgical text edits and 'edit' for full rewrites. "
                "'publish' once you've verified the procedure works. For add, "
                "always provide an explicit name slug and only tell the user the "
                "exact name returned by the tool."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "view", "view_ref", "add", "edit", "patch", "publish", "delete", "search"], "description": "list = name+description summary; view = full SKILL.md; view_ref = sub-file under the skill dir; add = create; edit = full rewrite (content); patch = old_string→new_string; publish = flip status; delete; search = relevance match on published skills."},
                    "name": {"type": "string", "description": "Slug/name of the skill. Required for add/view/view_ref/edit/patch/publish/delete. For add, choose the exact kebab-case name the user should see and report only the returned name."},
                    "path": {"type": "string", "description": "Sub-path under the skill directory for view_ref (e.g. 'references/example.md')."},
                    "description": {"type": "string", "description": "One-line summary surfaced in the skills index (for add)."},
                    "category": {"type": "string", "description": "Organizational grouping like 'dev', 'email', 'system' (for add)."},
                    "when_to_use": {"type": "string", "description": "Trigger conditions in plain English (for add)."},
                    "procedure": {"type": "array", "items": {"type": "string"}, "description": "Numbered steps (for add)."},
                    "pitfalls": {"type": "array", "items": {"type": "string"}, "description": "Known failure modes + recovery (for add)."},
                    "verification": {"type": "array", "items": {"type": "string"}, "description": "How to confirm the procedure succeeded (for add)."},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Keyword tags (for add)."},
                    "platforms": {"type": "array", "items": {"type": "string"}, "description": "Restrict to OSes (for add)."},
                    "requires_toolsets": {"type": "array", "items": {"type": "string"}, "description": "Hide unless these toolsets are active (for add)."},
                    "fallback_for_toolsets": {"type": "array", "items": {"type": "string"}, "description": "Hide when these toolsets are active (for add)."},
                    "status": {"type": "string", "enum": ["draft", "published"], "description": "Defaults to 'draft' on add."},
                    "version": {"type": "string", "description": "Semver-ish, e.g. '1.0.0' (for add)."},
                    "confidence": {"type": "number", "description": "0-1 (for add/publish)."},
                    "content": {"type": "string", "description": "Full SKILL.md text (for edit)."},
                    "old_string": {"type": "string", "description": "Exact substring to replace (for patch). Must appear exactly once."},
                    "new_string": {"type": "string", "description": "Replacement text (for patch)."},
                    "query": {"type": "string", "description": "Search query (for search)."}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_endpoints",
            "description": "Manage model API endpoints: list configured endpoints, add new ones, delete, enable or disable them.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "delete", "enable", "disable"]},
                    "endpoint_id": {"type": "string", "description": "Endpoint ID (for delete/enable/disable)"},
                    "name": {"type": "string", "description": "Display name (for add)"},
                    "base_url": {"type": "string", "description": "API base URL e.g. https://api.openai.com/v1 (for add)"},
                    "api_key": {"type": "string", "description": "API key (for add)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_mcp",
            "description": "Manage MCP (Model Context Protocol) tool servers: list servers and their tools, add new servers, delete, enable/disable, reconnect, or list all available tools.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "delete", "enable", "disable", "reconnect", "list_tools"]},
                    "server_id": {"type": "string", "description": "Server ID (for delete/enable/disable/reconnect)"},
                    "name": {"type": "string", "description": "Server name (for add)"},
                    "command": {"type": "string", "description": "Command to run e.g. npx (for add)"},
                    "args": {"type": "array", "items": {"type": "string"}, "description": "Command arguments (for add)"},
                    "env": {"type": "object", "description": "Environment variables (for add)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_webhooks",
            "description": "Manage webhooks: list, add, delete, enable or disable webhook endpoints.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "delete", "enable", "disable"]},
                    "webhook_id": {"type": "string", "description": "Webhook ID (for delete/enable/disable)"},
                    "name": {"type": "string", "description": "Webhook name (for add)"},
                    "url": {"type": "string", "description": "Webhook URL (for add)"},
                    "events": {"type": "string", "description": "Comma-separated event names (for add)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_tokens",
            "description": "Manage API access tokens: list existing tokens, create new ones, or delete them.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "create", "delete"]},
                    "token_id": {"type": "string", "description": "Token ID (for delete)"},
                    "name": {"type": "string", "description": "Token name (for create)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_documents",
            "description": "Manage documents: list all documents (with optional search/language filter), delete documents, or run tidy cleanup.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "delete", "tidy"]},
                    "document_id": {"type": "string", "description": "Document ID (for delete)"},
                    "search": {"type": "string", "description": "Search query (for list)"},
                    "language": {"type": "string", "description": "Filter by language (for list)"},
                    "limit": {"type": "integer", "description": "Max results (for list, default 50)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_settings",
            "description": "Manage user preferences and settings. Use `disable_tool`/`enable_tool`/`list_tools` to turn individual tools on or off globally (e.g. shell, search, browser, documents, memory, skills, images, tasks). Use list/get/set/delete for free-form preferences.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "get", "set", "delete", "disable_tool", "enable_tool", "list_tools"]},
                    "key": {"type": "string", "description": "Setting key (for get/set/delete)"},
                    "value": {"description": "Setting value (for set) — can be string, number, boolean, or object"},
                    "tool": {"type": "string", "description": "Tool name to disable/enable (for disable_tool/enable_tool). Accepts aliases: shell, search, browser, documents, memory, skills, images, tasks — or a raw tool name like 'bash' or 'web_search'."}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "app_api",
            "description": "Generic loopback to allowed internal X9 endpoints. Use this when there's no named tool for what the user wants. Hits the same routes the UI buttons hit (cookbook, gallery, library/documents, memory, notes, tasks, settings, themes, research, etc.). action='endpoints' returns the OpenAPI surface (use `filter` to narrow). action='call' (default) takes method+path+body. Sensitive auth/user/admin/shell paths and host-control Cookbook mutation routes are blocked for safety. Do not use for shell commands; use named command tooling instead. Do not use for package installs, engine rebuilds, or PID signalling.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["call", "endpoints"], "description": "'call' to hit an endpoint, 'endpoints' to list what's available"},
                    "path": {"type": "string", "description": "Endpoint path starting with /api/ (e.g. '/api/cookbook/gpus', '/api/gallery/list', '/api/notes')"},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "HTTP method (default GET)"},
                    "body": {"type": "object", "description": "JSON request body for POST/PUT/PATCH"},
                    "query": {"type": "object", "description": "Querystring params as a key-value object"},
                    "filter": {"type": "string", "description": "For action=endpoints: substring to filter paths/summaries (e.g. 'cookbook', 'gallery')"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "edit_image",
            "description": "Edit a gallery image: upscale, remove background, inpaint, or harmonize.",
            "parameters": {
                "type": "object",
                "properties": {
                    "image_id": {"type": "string", "description": "Gallery image ID"},
                    "action": {"type": "string", "enum": ["upscale", "rembg", "inpaint", "harmonize"], "description": "Edit action"},
                    "prompt": {"type": "string", "description": "For inpaint: what to fill the masked area with"},
                    "scale": {"type": "number", "description": "For upscale: scale factor (default 2)"},
                },
                "required": ["image_id", "action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "trigger_research",
            "description": "Start a deep research task on a topic. Returns a task ID for tracking.",
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string", "description": "Research question or topic"},
                },
                "required": ["topic"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_queue",
            "description": "Plan improvements on the sidebar Queue page: add, list, remove, or skip skill/rag/memory/test improvement items. Items need a description of what should improve; new items join the BOTTOM of the queue. A 'test' improvement builds a test- prefixed skill that proves whether a feature works. The queue only RUNS when the user presses play on the Queue page — never promise to run it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["add", "list", "remove", "skip"],
                               "description": "add = queue a new improvement; list = show the queue top-down; remove = delete by id; skip = toggle an item's skipped state."},
                    "type": {"type": "string", "enum": ["skill", "rag", "memory", "test"],
                             "description": "What the improvement targets (required for add). Use 'test' for a test- skill that proves a feature works."},
                    "description": {"type": "string", "description": "What needs to improve (required for add)."},
                    "id": {"type": "string", "description": "Queue item id (required for remove/skip; from action='list')."},
                    "skipped": {"type": "boolean", "description": "For skip: true parks the item (eye icon), false puts it back in line. Default true."},
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "resolve_contact",
            "description": "Look up a contact by name. Searches the CardDAV address book. Returns email addresses (when available) or phone numbers. Use when the user says 'message [name]' or asks for someone's contact details.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Person's name to search for"},
                },
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_contact",
            "description": "Create, update, delete, or list the user's CardDAV contacts. Use to save a new contact, update an existing one (email/phone/address), or remove one. For update/delete you need the contact's uid — call action='list' first to find it. Writes go through the same dedupe + validation as the Contacts UI.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "update", "delete"],
                               "description": "list = show all contacts (with uids); add = create; update = edit by uid; delete = remove by uid."},
                    "uid": {"type": "string", "description": "Contact UID (required for update/delete; get it from action=list)."},
                    "name": {"type": "string", "description": "Contact's display name (for add/update)."},
                    "email": {"type": "string", "description": "Single email address (convenience for add, or the primary email for update)."},
                    "emails": {"type": "array", "items": {"type": "string"}, "description": "Full list of email addresses (for update; first is primary)."},
                    "phones": {"type": "array", "items": {"type": "string"}, "description": "Full list of phone numbers (for update)."},
                    "address": {"type": "string", "description": "Postal/mailing address as a single human-readable string."},
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_bg_jobs",
            "description": "Inspect and control detached background `bash` jobs (started with the `#!bg` marker). action='list' shows this chat's jobs with id/status/age/command; action='output' returns a job's captured output so far (use for a still-running job, or to re-read a finished one); action='kill' terminates a runaway job's process tree instead of waiting out its max-runtime. output and kill need job_id from list.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "output", "kill"], "description": "list | output | kill (default: list)"},
                    "job_id": {"type": "string", "description": "Background job id (required for output/kill; from action='list')"},
                },
                "required": ["action"]
            }
        }
    },
]


# ---------------------------------------------------------------------------
# Converter: native function call -> ToolBlock
# ---------------------------------------------------------------------------

def _decode_loose_json_string(value: str) -> str:
    """Decode common JSON string escapes without requiring inner quotes to be escaped."""
    out = []
    i = 0
    while i < len(value):
        ch = value[i]
        if ch != "\\" or i + 1 >= len(value):
            out.append(ch)
            i += 1
            continue
        nxt = value[i + 1]
        if nxt == "n":
            out.append("\n")
        elif nxt == "r":
            out.append("\r")
        elif nxt == "t":
            out.append("\t")
        elif nxt == "b":
            out.append("\b")
        elif nxt == "f":
            out.append("\f")
        elif nxt in ('"', "\\", "/"):
            out.append(nxt)
        elif nxt == "u" and i + 5 < len(value):
            try:
                out.append(chr(int(value[i + 2:i + 6], 16)))
                i += 4
            except ValueError:
                out.append("\\" + nxt)
        else:
            out.append("\\" + nxt)
        i += 2
    return "".join(out)


def _repair_document_function_args(tool_type: str, arguments: str) -> Optional[dict]:
    """Salvage obvious malformed document tool args from local model wrappers.

    The doc LoRA sometimes emits the right native tool call but puts raw quotes
    inside the document text, making the surrounding JSON invalid. Treat that as
    a wrapper parse failure, not a semantic tool-choice failure.
    """
    if tool_type != "update_document" or not isinstance(arguments, str):
        return None
    raw = arguments.strip()
    if not raw.startswith("{") or not raw.endswith("}"):
        return None
    for key in ("content", "conten"):
        marker = f'"{key}"'
        key_pos = raw.find(marker)
        if key_pos < 0:
            continue
        colon_pos = raw.find(":", key_pos + len(marker))
        if colon_pos < 0:
            continue
        first_quote = raw.find('"', colon_pos + 1)
        if first_quote < 0:
            continue
        close_brace = raw.rfind("}")
        last_quote = raw.rfind('"', first_quote + 1, close_brace)
        if last_quote <= first_quote:
            continue
        content = _decode_loose_json_string(raw[first_quote + 1:last_quote])
        return {"content": content}
    return None


def function_call_to_tool_block(name: str, arguments: str) -> Optional[ToolBlock]:
    """Convert a native function call into a ToolBlock for the existing execution pipeline."""
    tool_type = _TOOL_NAME_MAP.get(name, name)
    try:
        if not arguments or (isinstance(arguments, str) and not arguments.strip()):
            args = {}
        else:
            args = json.loads(arguments) if isinstance(arguments, str) else arguments
    except (json.JSONDecodeError, TypeError):
        args = _repair_document_function_args(tool_type, arguments)
        if args is not None:
            logger.warning(f"Repaired malformed document function call arguments for {name}")
        else:
            logger.error(f"Failed to parse function call arguments for {name}: {arguments}")
            return None

    # Some models emit valid JSON that isn't an object (e.g. a bare array
    # ["ls -la"], string, or number) as function arguments. Local tools keep
    # the legacy empty-object coercion for stream robustness.
    if not isinstance(args, dict):
        logger.warning(f"Non-object function call arguments for {name}: {args!r}; treating as empty")
        args = {}

    # Allow MCP tools through (namespaced as mcp__serverid__toolname)
    if tool_type.startswith("mcp__"):
        content = json.dumps(args) if args else "{}"
        return ToolBlock(tool_type, content)
    if tool_type not in TOOL_TAGS:
        logger.warning(f"Unknown function call: {name}")
        return None

    # Convert structured args back to the text format each tool expects
    if tool_type == "bash":
        content = args.get("command", "")
    elif tool_type == "python":
        content = args.get("code", "")
    elif tool_type == "web_search":
        queries = args.get("queries")
        if isinstance(queries, list) and queries:
            content = str(queries[0])
        elif queries:
            content = str(queries)
        else:
            content = args.get("query", "")
        # Preserve the model-requested freshness filter — the web_search schema
        # advertises time_filter and the executor parses {"query","time_filter"},
        # but a bare query string dropped it. Mirrors the read_file JSON idiom.
        tf = args.get("time_filter")
        if content and isinstance(tf, str) and tf in ("day", "week", "month", "year"):
            content = json.dumps({"query": content, "time_filter": tf})
    elif tool_type == "read_file":
        # Plain path (back-compat) unless a line range is requested → JSON.
        if args.get("offset") or args.get("limit"):
            content = json.dumps(args)
        else:
            content = args.get("path", "")
    elif tool_type in ("grep", "glob", "ls"):
        content = json.dumps(args) if args else "{}"
    elif tool_type == "get_workspace":
        content = ""
    elif tool_type == "write_file":
        content = args.get("path", "") + "\n" + args.get("content", "")
    elif tool_type == "edit_file":
        content = json.dumps(args)
    elif tool_type == "create_document":
        parts = [args.get("title", "Untitled")]
        if args.get("language"):
            parts.append(args["language"])
        parts.append(args.get("content", ""))
        content = "\n".join(parts)
    elif tool_type == "edit_document":
        blocks = []
        edits = args.get("edits", [])
        if not isinstance(edits, list):
            edits = []
        for edit in edits:
            if not isinstance(edit, dict):
                continue
            blocks.append(
                f'<<<FIND>>>\n{edit.get("find", "")}\n<<<REPLACE>>>\n{edit.get("replace", "")}\n<<<END>>>'
            )
        content = "\n".join(blocks)
    elif tool_type == "suggest_document":
        blocks = []
        suggestions = args.get("suggestions", [])
        if not isinstance(suggestions, list):
            suggestions = []
        for s in suggestions:
            if not isinstance(s, dict):
                continue
            blocks.append(
                f'<<<FIND>>>\n{s.get("find", "")}\n<<<SUGGEST>>>\n{s.get("replace", "")}\n<<<REASON>>>\n{s.get("reason", "")}\n<<<END>>>'
            )
        content = "\n".join(blocks)
    elif tool_type == "update_document":
        content = args.get("content", "")
    elif tool_type == "search_chats":
        content = args.get("query", "")
    elif tool_type == "chat_with_model":
        content = args.get("model", "") + "\n" + args.get("message", "")
    elif tool_type == "create_session":
        content = args.get("name", "Untitled") + "\n" + args.get("model", "")
    elif tool_type == "list_sessions":
        content = args.get("filter", "")
    elif tool_type == "send_to_session":
        content = args.get("session_id", "") + "\n" + args.get("message", "")
    elif tool_type == "pipeline":
        # Pass as JSON for the pipeline parser
        content = json.dumps({"steps": args.get("steps", [])})
    elif tool_type == "manage_session":
        action = args.get("action", "")
        value = args.get("value", "")
        # `list` is the only action that takes an OPTIONAL keyword
        # filter — never a session_id. Don't leak the "current" default
        # into the filter slot (was producing "No sessions found
        # matching 'current'" when the agent omitted session_id).
        if action == "list":
            keyword = args.get("session_id", "") or args.get("keyword", "") or value
            content = "list" + (("\n" + keyword) if keyword and keyword.lower() != "current" else "")
        else:
            sid = args.get("session_id", "current")
            content = action + "\n" + sid
            if value:
                content += "\n" + value
    elif tool_type == "manage_memory":
        action = args.get("action", "")
        if action == "add":
            content = "add\n" + args.get("text", "")
            if args.get("category"):
                content += "\n" + args["category"]
        elif action == "edit":
            content = "edit\n" + args.get("memory_id", "") + "\n" + args.get("text", "")
        elif action == "delete":
            content = "delete\n" + args.get("memory_id", "")
        elif action == "search":
            content = "search\n" + args.get("text", "")
        elif action == "list":
            content = "list"
            if args.get("category"):
                content += "\n" + args["category"]
        else:
            content = action
    elif tool_type == "list_models":
        content = args.get("filter", "")
    elif tool_type == "ui_control":
        action = args.get("action", "")
        name = args.get("name", "")
        value = args.get("value", "")
        if action == "toggle":
            content = f"toggle {name} {value}"
        elif action == "open_panel":
            content = f"open_panel {name or value}"
        elif action == "set_mode":
            content = f"set_mode {value or name}"
        elif action == "switch_model":
            content = f"switch_model {value or name}"
        elif action == "set_theme":
            content = f"set_theme {value or name}"
        elif action == "create_theme":
            colors = args.get("colors", {})
            theme_name = name or value or "custom"
            bg = colors.get("bg", "#282c34")
            fg = colors.get("fg", "#9cdef2")
            panel = colors.get("panel", "#111111")
            border = colors.get("border", "#355a66")
            accent = colors.get("accent", "#e06c75")
            content = f"create_theme {theme_name} {bg} {fg} {panel} {border} {accent}"
            # Append advanced overrides as key=value
            adv_keys = [
                "userBubbleBg", "aiBubbleBg", "bubbleBorder", "sidebarBg",
                "sectionAccent", "brandColor", "inputBg", "inputBorder",
                "sendBtnBg", "sendBtnHover", "codeBg", "codeFg",
                "toggleBg", "toggleActive", "accentPrimary", "accentError",
            ]
            for ak in adv_keys:
                if colors.get(ak):
                    content += f" {ak}={colors[ak]}"
        else:
            content = action
    elif tool_type in ("manage_tasks", "manage_skills", "api_call",
                        "manage_endpoints", "manage_mcp", "manage_webhooks",
                        "manage_tokens", "manage_documents", "manage_settings"):
        content = json.dumps(args)
    elif tool_type == "ask_teacher":
        content = args.get("model", "auto") + "\n" + args.get("problem", "")
    elif tool_type == "ask_user":
        # Keep user-facing labels readable in the tool trace.  The outer SSE
        # JSON encoder will escape them for transport and JSON.parse restores
        # them once; pre-escaping here caused literal ``\u00f1`` sequences to
        # remain visible in the debug panel.
        content = json.dumps(args, ensure_ascii=False)
    else:
        content = json.dumps(args)

    return ToolBlock(tool_type, content)
