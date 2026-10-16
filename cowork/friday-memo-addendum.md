# Addendum for the existing Friday Memo scheduled task

Add this to the current task instructions, after the line about sources. Everything else in the task stays the same.

---

**Additional source: handwritten notes (Gleaner).** Read the token from `%USERPROFILE%\.gleaner-token`. Then, via Desktop Commander, run
`curl.exe -s -H "Authorization: Bearer <token>" "http://umbrel.local:3717/api/notes?from=<this Monday>&to=<today>"`
and `curl.exe -s -H "Authorization: Bearer <token>" http://umbrel.local:3717/api/items?status=all`.
Use them like calendar and email: evidence of what happened this week. Do not recount them.

Handwritten notes are less filtered than calendar entries. Apply the memo's exclusions strictly: no personnel matters,
confidential negotiations, private political strategy, or unannounced decisions. When a note is the only source for a
claim, list it under "Facts to verify" in the Editor's Notes rather than stating it in the memo. If Gleaner is unreachable,
note that in Editor's Notes and proceed without it.
