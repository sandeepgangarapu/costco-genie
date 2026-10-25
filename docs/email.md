# Costco Genie: Email

**Apple Mail (default):** open Mail, finish adding an account, and make sure it is enabled. Leave `emailRecipient` null to send to yourself or set it through the wizard. Apple Mail messages are plain text.

**SMTP (optional):** keep credentials outside the repository. Create a private file:

```sh
mkdir -p ~/.costco-genie
(umask 077; touch ~/.costco-genie/smtp.json)
chmod 600 ~/.costco-genie/smtp.json
open -e ~/.costco-genie/smtp.json
```

Fill it with your provider's settings; these are placeholders:

```json
{
  "smtp_host": "smtp.example.com",
  "smtp_port": 587,
  "smtp_user": "you@example.com",
  "smtp_pass": "REPLACE_WITH_YOUR_PROVIDER_PASSWORD",
  "email_from": "you@example.com",
  "email_to": "you@example.com"
}
```

In your local `config.json`, set `smtpConfigPath` to the **full absolute path** of that file. Run `echo "$HOME/.costco-genie/smtp.json"` to see the path; `~` is not expanded inside JSON. Use your provider's app password if required. Port 465 uses implicit TLS; other ports require STARTTLS. SMTP messages include an HTML table and plain-text fallback. `emailRecipient`, if set, overrides `email_to`.

Never paste this file, your password, or your browser session into an issue or a chat.

Receipt summaries use `Costco Genie: potential price adjustments`; weekly reports use `Costco Genie weekly report`. Summary options, deduplication, and weekly scheduling behavior are preserved. Watch drops use a distinct `Costco Genie: N items hit new lows` subject (with an unverified marker when needed), one consolidated email for pending lows per check, and the same `emailRecipient` override. All messages identify Costco Genie in their footer. Apple Mail gets plain text; SMTP gets HTML and text. No watch email is sent for an initial baseline. Failed drop delivery remains queued, including when the following check finds no new lows. Removal cancels that item's pending alerts while keeping observations.

Scheduled failures use `Costco Genie: receipt run failed` or `Costco Genie: watch check failed`. They use the same transport and recipient settings: Apple Mail plain text by default, SMTP HTML plus text via `smtpConfigPath`, and `emailRecipient` overrides the transport's default recipient. Each includes the local failure time, operational stage, a fixed safe reason, recovery guidance, and the next configured local attempt. Raw service errors and purchase details are excluded. Expired/invalid sessions say: run `./costco login`, sign in, close the dedicated Chrome window, then `./costco run`. Other failures say to run `./costco doctor` and give the private `logs/stderr.log` path.

The additive SQLite table `scheduled_failure_notifications` in `costco.sqlite` reserves each `(job, local_day)` before sending, using the local day of the notification attempt (even if a long dispatch crosses midnight). Both jobs can alert on the same day. Failed delivery is recorded and logged to stderr/launchd logs, with the existing macOS notification as a fallback; it never changes the job's exit status. The reservation remains even if sending fails or the process crashes, so there is no same-day retry of failure email. `status`/`doctor` show the last recorded failure and the day's notification status: `delivered`, `failed`, or `pending/unknown` (a reserved attempt interrupted before its result was saved). Repeated same-day failures update that failure's time/stage while retaining the original daily delivery result. If the database itself cannot reserve the attempt, the app logs the state error and uses only the local fallback to avoid unbounded email duplicates. A later failed day gets another attempt.

This daily policy replaces the three-strike watch notice and separate session-expiry mail. Interactive checks send no failure emails. Normal price-drop/receipt mail retains its existing retry behavior: SMTP cannot guarantee exactly-once delivery across a crash after acceptance and before marking a price alert sent. No live email tests belong in the offline test suite.
