# Recovering a queue after a connection interruption

The bot persists the accepted turn ID before waiting. After reconnecting, it matches that ID or the request identity against live Codex state and retires completed, failed or interrupted requests. Unknown requests are never automatically replayed. The next queued request starts only when its conversation is ready.

Use **Refresh status and queue** in `/queue` to obtain a fresh snapshot. Telegram delivery errors no longer prevent connection and queue maintenance.

Legacy requests from earlier versions may have no saved acceptance identity and no recoverable identity in history. Inspect Codex first to verify that the task finished or was cancelled. Then choose **This task ended; continue queue** and confirm on the second screen. The bot reads fresh state for that same conversation before both steps and rejects confirmation while work is active. Confirmation retires only the legacy wait record; it does not resend or interrupt that request. Uncertain delivery still requires inspection.
