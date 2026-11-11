// Real Qoder wire messages, captured from one run of @qoder-ai/qoder-agent-sdk 1.0.57
// with CLI 1.1.80 on 2026-11-11, then desensitized: workspace path, session id, message id
// and per-message uuids were replaced; usage blocks and unrelated keys were dropped.
//
// The turn launched two background Agents (`run_in_background: true`): one counted files,
// one was told to read a missing file. Both finished with `status: "completed"` — CLI 1.1.80
// does not report a failed terminal state for a sub-agent task. Nothing here is synthetic:
// replaying these messages is the shared-entry evidence for Qoder's Agent path.

export const QODER_BACKGROUND_AGENT_MESSAGES: Array<Record<string, unknown>> = [
  {
    "type": "assistant",
    "message": {
      "id": "msg-qoder-fixture-1",
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_bdrk_01NGwGZjyG6Z24Fn6T9cM53V",
          "name": "Agent",
          "input": {
            "description": "Count workspace files",
            "prompt": "Research-only task, do not modify anything. Count the number of regular files (recursively, including hidden files) under /tmp/qoder-fixture/workspace. Use a command like `find /tmp/qoder-fixture/workspace -type f | wc -l`. Report the exact count in one short sentence.",
            "subagent_type": "general-purpose",
            "run_in_background": true
          }
        }
      ],
      "model": "Ultimate"
    }
  },
  {
    "type": "user",
    "message": {
      "id": null,
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_bdrk_01NGwGZjyG6Z24Fn6T9cM53V",
          "content": "Async agent launched successfully.\nagentId: ageneral-purpose-4b61b1be377ad0c8 (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\noutput_file: /tmp/qoder-fixture/session/tasks/aa3f121bd8d976e35.output\nDo NOT read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you will get a completion notification."
        }
      ]
    }
  },
  {
    "type": "assistant",
    "message": {
      "id": "msg-qoder-fixture-1",
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_bdrk_01DS2dJ8RmumS5jNeFVp7nZv",
          "name": "Agent",
          "input": {
            "description": "Read missing file",
            "prompt": "Research-only task, do not create or modify any files. Use the Read tool to read /tmp/qoder-fixture/workspace/not-here.txt. This file is expected NOT to exist. Do not create it or search for alternatives. Just attempt the read once and report the exact error message you got, in one short sentence.",
            "subagent_type": "general-purpose",
            "run_in_background": true
          }
        }
      ],
      "model": "Ultimate"
    }
  },
  {
    "type": "user",
    "message": {
      "id": null,
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_bdrk_01DS2dJ8RmumS5jNeFVp7nZv",
          "content": "Async agent launched successfully.\nagentId: ageneral-purpose-27de6c40ff34cb87 (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\noutput_file: /tmp/qoder-fixture/session/tasks/a034c322ab36b091c.output\nDo NOT read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you will get a completion notification."
        }
      ]
    }
  },
  {
    "type": "system",
    "task_id": "aa3f121bd8d976e35",
    "tool_use_id": "toolu_bdrk_01NGwGZjyG6Z24Fn6T9cM53V",
    "description": "Count workspace files",
    "task_type": "local_agent",
    "subagent_type": "general-purpose",
    "prompt": "Research-only task, do not modify anything. Count the number of regular files (recursively, including hidden files) under /tmp/qoder-fixture/workspace. Use a command like `find /tmp/qoder-fixture/workspace -type f | wc -l`. Report the exact count in one short sentence.",
    "subtype": "task_started",
    "uuid": "uuid-fixture-5",
    "session_id": "session-qoder-fixture"
  },
  {
    "type": "system",
    "task_id": "a034c322ab36b091c",
    "tool_use_id": "toolu_bdrk_01DS2dJ8RmumS5jNeFVp7nZv",
    "description": "Read missing file",
    "task_type": "local_agent",
    "subagent_type": "general-purpose",
    "prompt": "Research-only task, do not create or modify any files. Use the Read tool to read /tmp/qoder-fixture/workspace/not-here.txt. This file is expected NOT to exist. Do not create it or search for alternatives. Just attempt the read once and report the exact error message you got, in one short sentence.",
    "subtype": "task_started",
    "uuid": "uuid-fixture-6",
    "session_id": "session-qoder-fixture"
  },
  {
    "type": "system",
    "task_id": "aa3f121bd8d976e35",
    "tool_use_id": "toolu_bdrk_01NGwGZjyG6Z24Fn6T9cM53V",
    "description": "Count regular files recursively",
    "last_tool_name": "Bash",
    "subagent_type": "general-purpose",
    "subtype": "task_progress",
    "uuid": "uuid-fixture-7",
    "session_id": "session-qoder-fixture"
  },
  {
    "type": "system",
    "task_id": "a034c322ab36b091c",
    "tool_use_id": "toolu_bdrk_01DS2dJ8RmumS5jNeFVp7nZv",
    "description": "/private/.../workspace/not-here.txt",
    "last_tool_name": "Read",
    "subagent_type": "general-purpose",
    "subtype": "task_progress",
    "uuid": "uuid-fixture-8",
    "session_id": "session-qoder-fixture"
  },
  {
    "type": "system",
    "task_id": "a034c322ab36b091c",
    "patch": {
      "status": "completed",
      "end_time": 1794385710009
    },
    "subtype": "task_updated",
    "uuid": "uuid-fixture-9",
    "session_id": "session-qoder-fixture"
  },
  {
    "type": "system",
    "task_id": "aa3f121bd8d976e35",
    "tool_use_id": "toolu_bdrk_01NGwGZjyG6Z24Fn6T9cM53V",
    "description": "List workspace contents including hidden",
    "last_tool_name": "Bash",
    "subagent_type": "general-purpose",
    "subtype": "task_progress",
    "uuid": "uuid-fixture-10",
    "session_id": "session-qoder-fixture"
  },
  {
    "type": "system",
    "subtype": "task_notification",
    "task_id": "a034c322ab36b091c",
    "tool_use_id": "toolu_bdrk_01DS2dJ8RmumS5jNeFVp7nZv",
    "status": "completed",
    "output_file": "/tmp/qoder-fixture/session/tasks/a034c322ab36b091c.output",
    "summary": "Agent \"Read missing file\" finished",
    "uuid": "uuid-fixture-11",
    "session_id": "session-qoder-fixture"
  },
  {
    "type": "system",
    "task_id": "aa3f121bd8d976e35",
    "patch": {
      "status": "completed",
      "end_time": 1794385713748
    },
    "subtype": "task_updated",
    "uuid": "uuid-fixture-12",
    "session_id": "session-qoder-fixture"
  },
  {
    "type": "system",
    "subtype": "task_notification",
    "task_id": "aa3f121bd8d976e35",
    "tool_use_id": "toolu_bdrk_01NGwGZjyG6Z24Fn6T9cM53V",
    "status": "completed",
    "output_file": "/tmp/qoder-fixture/session/tasks/aa3f121bd8d976e35.output",
    "summary": "Agent \"Count workspace files\" finished",
    "uuid": "uuid-fixture-13",
    "session_id": "session-qoder-fixture"
  }
]
