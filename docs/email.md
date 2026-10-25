# Email

**Apple Mail (default):** open Mail, finish adding an account, and make sure it is enabled. Leave `emailRecipient` null to send to yourself or set it through the wizard. Apple Mail messages are plain text.

**SMTP (optional):** keep credentials outside the repository. Create a private file:

```sh
mkdir -p ~/.costco-price-matcher
(umask 077; touch ~/.costco-price-matcher/smtp.json)
chmod 600 ~/.costco-price-matcher/smtp.json
open -e ~/.costco-price-matcher/smtp.json
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

In your local `config.json`, set `smtpConfigPath` to the **full absolute path** of that file. Run `echo "$HOME/.costco-price-matcher/smtp.json"` to see the path; `~` is not expanded inside JSON. Use your provider's app password if required. Port 465 uses implicit TLS; other ports require STARTTLS. SMTP messages include an HTML table and plain-text fallback. `emailRecipient`, if set, overrides `email_to`.

Never paste this file, your password, or your browser session into an issue or a chat.

Receipt reports retain their existing subject, summary options, deduplication, and weekly scheduling behavior. Watch drops use a distinct `Costco price drop: N items hit new lows` subject (with an unverified marker when needed), one consolidated email for pending lows per check, and the same `emailRecipient` override. Apple Mail gets plain text; SMTP gets HTML and text. No watch email is sent for an initial baseline. Failed drop delivery remains queued, including when the following check finds no new lows. Removal cancels that item's pending alerts while keeping observations.

Session-expiry and repeated scheduled-watch-failure notices are separate operational messages. SMTP cannot guarantee exactly-once delivery across a crash after server acceptance and before marking the alert sent; that narrow window can cause a retry duplicate. No live email tests belong in the offline test suite.
