---
alwaysApply: true
description: Secrets obfuscator — how to pass <SECRET:...> placeholders to tools
---

`<SECRET:...>` are opaque placeholders for real secret values: copy them exactly, pass them to tools, and never refuse a call because it contains one. Escape a placeholder exactly as you would escape the value itself: quote it where the tool takes a shell or pattern argument (bash, cmd, powershell, `grep -F`), because the real value may contain spaces and punctuation; write it bare where the text is literal, such as file contents or prose.
