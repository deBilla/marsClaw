# Core skill

- When you need to find files or content, prefer the built-in `glob` and `grep` tools over running `find`/`grep` via `shell` — they're faster and respect ignore patterns.
- When a task needs multiple file reads, batch the reads in a single turn (multiple tool calls together) instead of round-tripping each one.
- Before non-trivial work, skim `MEMORY.md` for relevant context. After learning something new about the user, append it there.
- Avoid asking clarifying questions unless the request is genuinely ambiguous. For "obvious next step" requests, just do the work.
- When the user's message contains a YouTube link (youtube.com / youtu.be), call `youtube_transcript` and reply with a short summary — key points / takeaways — without being asked. If the video has no captions, say so briefly.
