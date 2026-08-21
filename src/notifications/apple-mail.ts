import { execFile as defaultExecFile, type ExecFile } from '../lib/process.js';

const OSASCRIPT = '/usr/bin/osascript';
const RESOLVE_RECIPIENT_SCRIPT = `tell application "Mail"
  repeat with mailAccount in every account
    if enabled of mailAccount then
      set accountAddresses to email addresses of mailAccount
      if (count of accountAddresses) > 0 then return item 1 of accountAddresses
    end if
  end repeat
  return ""
end tell`;
const SEND_SCRIPT = `on run argv
  set recipientAddress to item 1 of argv
  set messageSubject to item 2 of argv
  set messageBody to item 3 of argv
  tell application "Mail"
    set outgoingMessage to make new outgoing message with properties {subject:messageSubject, content:messageBody, visible:false}
    tell outgoingMessage
      make new to recipient at end of to recipients with properties {address:recipientAddress}
      send
    end tell
  end tell
end run`;

export class AppleMailError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppleMailError';
  }
}

export class AppleMailNotifier {
  constructor(private readonly execFile: ExecFile = defaultExecFile) {}

  async resolveSelfRecipient(): Promise<string> {
    try {
      const result = await this.execFile(OSASCRIPT, [
        '-e',
        RESOLVE_RECIPIENT_SCRIPT,
      ]);
      const recipient = result.stdout.trim();
      if (!recipient) {
        throw new AppleMailError(
          'No address was found on an enabled Apple Mail account',
        );
      }
      return recipient;
    } catch (error) {
      if (error instanceof AppleMailError) {
        throw error;
      }
      throw new AppleMailError('Unable to resolve an Apple Mail recipient', {
        cause: error,
      });
    }
  }

  async send(recipient: string, subject: string, text: string): Promise<void> {
    try {
      await this.execFile(OSASCRIPT, [
        '-e',
        SEND_SCRIPT,
        '--',
        recipient,
        subject,
        text,
      ]);
    } catch (error) {
      throw new AppleMailError('Unable to send the Apple Mail message', {
        cause: error,
      });
    }
  }
}
