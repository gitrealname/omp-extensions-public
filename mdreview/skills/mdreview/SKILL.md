---
name: mdreview
description: "Interactive markdown file review with annotation and AI chat in a browser UI."
---

When user says `.mdreview`, "review this file", "annotate this", or asks to discuss/comment on a markdown file — call `slash_proxy` with:

    slash_proxy({ command: "/mdreview /absolute/path/to/file.md" })

Infer the path from context. Stay silent after calling.
